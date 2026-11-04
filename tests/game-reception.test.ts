import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import type { GameScoreHistory, GameScoreSummary, ScoreMilestone } from "../src/lib/score";
import { selectScoreMilestones } from "../src/lib/score-milestone-density";
import { createQueryClient } from "../src/lib/query-client";
import { gameScoreHistoryQueryOptions, gameScoreSummaryQueryOptions } from "../src/lib/score-query";
import { buildScoreHistoryChartData, GameReception } from "../src/components/game-reception";

function milestone(event_id: string, seconds: number, kind: string | null): ScoreMilestone {
  return {
    event_id,
    kind,
    title: event_id,
    event_time: new Date(seconds * 1000).toISOString(),
    event_precision: "instant",
    date_basis: "start_at",
    source_url: null,
    display_label: kind === "major_update" ? "Major update" : "News",
  };
}

describe("score milestone density", () => {
  test("uses label bounds and priority instead of an event-count cap", () => {
    const milestones = [
      milestone("major-old", 200, "major_update"),
      milestone("news-between", 220, "unknown"),
      milestone("major-new", 230, "major_update"),
      milestone("news-newer", 240, "unknown"),
      milestone("major-later", 700, "major_update"),
      milestone("news-later", 900, "unknown"),
    ];
    const selected = selectScoreMilestones(milestones, [0, 1_000_000], 400);
    expect(selected.map((item) => item.event_id)).toEqual(["major-new", "major-later", "news-later"]);
    const narrower = selectScoreMilestones(milestones, [0, 1_000_000], 300);
    expect(narrower.map((item) => item.event_id)).toEqual(["major-new", "major-later"]);
  });
});

const SCORE: NonNullable<GameScoreSummary["score"]> = {
  value: 100 / 21,
  observation_id: 1,
  observed_at: "2026-09-08T00:00:00.000Z",
  formula_version: "steam-player-v2",
  anchor: null,
  score_window: { start: "2026-06-10T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" },
  evidence_start: "2026-09-07T00:00:00.000Z",
  evidence_end: "2026-09-08T00:00:00.000Z",
  current_positive_reviews: 1,
  current_total_reviews: 1,
  current_reviews: 1,
  current_evidence_intervals: [{ start: "2026-09-07T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z", granularity: "day" }],
  current_evidence_observed_at: "2026-09-08T00:00:00.000Z",
  historical_evidence_intervals: [{ start: "2026-06-01T00:00:00.000Z", end: "2026-06-02T00:00:00.000Z", granularity: "day" }],
  historical_evidence_window: { start: "2026-03-12T00:00:00.000Z", end: "2026-06-10T00:00:00.000Z" },
  historical_evidence_observed_at: "2026-09-08T00:00:00.000Z",
  historical_support: { actual_reviews: 20, effective_reviews: 20, positive_reviews: 0, total_reviews: 20 },
  population_ref: null,
  historical_population_ref: null,
  provenance: {},
};

function renderReception(score: NonNullable<GameScoreSummary["score"]>): string {
  const client = createQueryClient();
  const summary: Pick<GameScoreSummary, "score" | "critics" | "alignment" | "lifetime_approval"> = {
    score,
    critics: [],
    alignment: [],
    lifetime_approval: null,
  };
  client.setQueryData(gameScoreSummaryQueryOptions(10).queryKey, summary);
  client.setQueryData(gameScoreHistoryQueryOptions(10, "30d").queryKey, null);
  try {
    return renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(GameReception, { appid: 10 }))).replace(/<[^>]*>/g, "");
  } finally {
    client.clear();
  }
}

describe("reception score evidence", () => {
  test("renders current raw-sample uncertainty separately from historical score support", () => {
    const text = renderReception({
      ...SCORE,
      observed_at: "2026-09-09T00:00:00.000Z",
      recalculation: {
        previous_observation_id: 1,
        previous_formula_version: "steam-player-v1",
        calculated_at: "2026-09-09T00:00:00.000Z",
      },
    });
    const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
    expect(text).toContain(number.format(4.8));
    expect(text).toContain(`${number.format(20.7)}%–${number.format(100)}%`);
    expect(text).toContain("Formula recalculation (not new reviews)");
  });

  test("displays a retained v1 observation under its original formula and value", () => {
    const text = renderReception({
      ...SCORE,
      value: 75,
      formula_version: "steam-player-v1",
      historical_support: { actual_reviews: 0, effective_reviews: 0, positive_reviews: 0, total_reviews: 0 },
      historical_evidence_intervals: [],
    });
    expect(text).toContain(new Intl.NumberFormat().format(75));
    expect(text).toMatch(/formula version:\s*steam-player-v1/);
  });
});

const EMPTY_HISTORY: GameScoreHistory = {
  appid: 10,
  range: "all",
  range_start: "2026-09-01T00:00:00.000Z",
  range_end: "2026-09-11T00:00:00.000Z",
  recorded_scores: [],
  reconstructed_scores: [],
  approval_buckets: [],
  milestones: [],
  populations: [],
  metrics: { latest_approval: null, reviews_in_period: null },
};

describe("score chart formula boundaries", () => {
  test("does not connect a formula increase while connecting subsequent same-formula evidence", () => {
    const common = {
      ...SCORE,
      current_positive_reviews: 3,
      current_total_reviews: 3,
      current_reviews: 3,
      historical_support: { actual_reviews: 0, effective_reviews: 0, positive_reviews: 0, total_reviews: 0 },
      historical_evidence_intervals: [],
    };
    const data = buildScoreHistoryChartData({
      ...EMPTY_HISTORY,
      recorded_scores: [
        { ...common, formula_version: "steam-player-v1", value: 87.5 },
        {
          ...common,
          observation_id: 2,
          observed_at: "2026-09-09T00:00:00.000Z",
          value: 100,
          recalculation: {
            previous_observation_id: 1,
            previous_formula_version: "steam-player-v1",
            calculated_at: "2026-09-09T00:00:00.000Z",
          },
        },
        {
          ...common,
          observation_id: 3,
          observed_at: "2026-09-10T00:00:00.000Z",
          value: 80,
          current_positive_reviews: 4,
          current_total_reviews: 5,
          current_reviews: 5,
          current_evidence_observed_at: "2026-09-10T00:00:00.000Z",
        },
      ],
    });
    expect(data.map((point) => point.score)).toEqual([87.5, null, 100, 80]);
    expect(data[1]?.timestamp).toBe(Date.parse("2026-09-08T12:00:00.000Z"));
    expect(data.filter((point) => point.score !== null).map((point) => point.isolated)).toEqual([true, false, false]);
  });

  test("prefers an actual v1 observation over v2 reconstruction at the same timestamp", () => {
    const { observation_id, ...fields } = SCORE;
    const data = buildScoreHistoryChartData({
      ...EMPTY_HISTORY,
      recorded_scores: [{ ...fields, observation_id, value: 75, formula_version: "steam-player-v1" }],
      reconstructed_scores: [{
        ...fields,
        kind: "reconstructed",
        score_at: SCORE.observed_at,
        evaluated_at: SCORE.observed_at,
        value: 100,
      }],
    });
    expect(data.map((point) => point.score === null ? null : [point.score, point.provenance, point.details.formula_version]))
      .toEqual([[75, "recorded", "steam-player-v1"]]);
  });
});
