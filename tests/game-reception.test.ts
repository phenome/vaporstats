import cyberpunk90d from "./fixtures/cyberpunk-score-90d.json";
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClientProvider } from "@tanstack/react-query";
import type { GameScoreHistory, GameScoreSummary, ReconstructedScore, ScoreMilestone } from "../src/lib/score";
import { selectScoreMilestones } from "../src/lib/score-milestone-density";
import { createQueryClient } from "../src/lib/query-client";
import { gameScoreHistoryQueryOptions, gameScoreSummaryQueryOptions } from "../src/lib/score-query";
import { buildScoreHistoryChartData, GameReception, ScoreHistoryTooltip } from "../src/components/game-reception";

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

function renderReception(score: NonNullable<GameScoreSummary["score"]>, history: GameScoreHistory | null = null, stripMarkup = true): string {
  const client = createQueryClient();
  const summary: Pick<GameScoreSummary, "score" | "critics" | "alignment" | "lifetime_approval"> = {
    score,
    critics: [],
    alignment: [],
    lifetime_approval: null,
  };
  client.setQueryData(gameScoreSummaryQueryOptions(10).queryKey, summary);
  client.setQueryData(gameScoreHistoryQueryOptions(10, "30d").queryKey, history);
  try {
    const markup = renderToString(React.createElement(QueryClientProvider, { client }, React.createElement(GameReception, { appid: 10 })));
    return stripMarkup ? markup.replace(/<[^>]*>/g, "") : markup;
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
          ...evidence("2026-09-08", "2026-09-10"),
          current_evidence_observed_at: "2026-09-10T00:00:00.000Z",
        },
      ],
    });
    expect(data.map((point) => [point.score, point.run])).toEqual([[87.5, 0], [100, 1], [80, 1]]);
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
    expect(data.map((point) => [point.score, point.provenance, point.details.formula_version]))
      .toEqual([[75, "recorded", "steam-player-v1"]]);
  });
});

function evidence(start: string, end: string, granularity: "day" | "week" | "month" = "day") {
  start = new Date(start).toISOString();
  end = new Date(end).toISOString();
  return {
    evidence_start: start,
    evidence_end: end,
    current_evidence_intervals: [{ start, end, granularity }],
  };
}

function reconstructed(start: string, end: string, granularity: "day" | "week" | "month" = "day"): ReconstructedScore {
  return {
    ...SCORE,
    kind: "reconstructed",
    score_at: end,
    evaluated_at: end,
    ...evidence(start, end, granularity),
  };
}

test("keeps distinct evidence without connecting past an intervening formula or a gap", () => {
  const observedAt = (date: string) => date + "T19:00:00Z";
  const midnight = (date: string) => date + "T00:00:00Z";
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    range: "90d",
    range_start: midnight("2026-08-21"),
    range_end: midnight("2026-11-19"),
    recorded_scores: [
      { ...SCORE, formula_version: "steam-player-v1", observed_at: "2026-09-15T05:00:00Z" },
      { ...SCORE, formula_version: "steam-player-v1", observed_at: observedAt("2026-09-16") },
      { ...SCORE, observed_at: observedAt("2026-11-04") },
    ],
    reconstructed_scores: [
      reconstructed(midnight("2026-09-14"), midnight("2026-09-15")),
      reconstructed(midnight("2026-09-15"), midnight("2026-09-16")),
    ],
  });
  expect(data.map((point) => [point.provenance, point.run])).toEqual([
    ["reconstructed", 0], ["recorded", 1], ["reconstructed", 2], ["recorded", 3], ["recorded", 4],
  ]);
});

test("ALL follows monthly, weekly and daily evidence and splits at missing intervals", () => {
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    range_start: null,
    range_end: null,
    reconstructed_scores: [
      reconstructed("2026-01-01", "2026-02-01", "month"),
      reconstructed("2026-02-01", "2026-03-01", "month"),
      reconstructed("2026-03-01", "2026-03-08", "week"),
      reconstructed("2026-03-08", "2026-03-09"),
      reconstructed("2026-03-10", "2026-03-11"),
    ],
  });
  expect(data.map((point) => point.run)).toEqual([0, 0, 0, 0, 1]);
});

test("a recorded point can join a reconstructed point under the same formula", () => {
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    range_end: "2026-09-12T00:00:00Z",
    recorded_scores: [
      { ...SCORE, observed_at: "2026-09-08T19:00:00Z" },
      { ...SCORE, ...evidence("2026-09-10", "2026-09-11"), observed_at: "2026-09-11T19:00:00Z" },
    ],
    reconstructed_scores: [reconstructed("2026-09-08", "2026-09-09")],
  });
  expect(data.map((point) => point.run)).toEqual([0, 0, 1]);
});

test("weekly evidence can support recorded points a week apart without filling a missing week", () => {
  const last = {
    ...SCORE,
    observed_at: "2026-09-08T19:00:00Z",
    ...evidence("2026-09-01", "2026-09-08", "week"),
  };
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    range_start: null,
    range_end: null,
    recorded_scores: [
      { ...SCORE, ...evidence("2026-08-25", "2026-09-01", "week"), observed_at: "2026-09-01T19:00:00Z" },
      last,
      {
        ...last,
        observed_at: "2026-09-22T19:00:00Z",
        ...evidence("2026-09-15", "2026-09-22", "week"),
      },
    ],
  });
  expect(data.map((point) => point.run)).toEqual([0, 0, 1]);
});

test("the score hover contains only the date and score, and point evidence is in Score details", () => {
  const point = {
    ...SCORE,
    observed_at: "2026-09-09T00:00:00Z",
    current_reviews: 2345,
    recalculation: {
      previous_observation_id: 1,
      previous_formula_version: "steam-player-v1",
      calculated_at: "2026-09-09T00:00:00Z",
    },
  };
  const history = { ...EMPTY_HISTORY, recorded_scores: [point] };
  const chartPoint = buildScoreHistoryChartData(history)[0]!;
  const hover = renderToString(React.createElement(ScoreHistoryTooltip, { point: chartPoint })).replace(/<[^>]*>/g, "");
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(chartPoint.timestamp);
  const score = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(point.value);
  expect(hover).toBe(date + "Player score" + score);
  const details = renderReception(SCORE, history, false).split("Score details")[1]!.replace(/<!-- -->/g, "");
  expect(details).toContain("Historical score point");
  expect(details).toContain("<select");
  expect(details).toContain("Formula recalculation (not new reviews)");
  expect(details).toContain("steam-player-v1 → steam-player-v2");
  expect(details).toContain(new Intl.NumberFormat().format(point.current_reviews) + " reviews");
  expect(details).toContain("Review evidence observed at");
});

test("uses recorded collection across midnight and preserves same-valued distinct evidence", () => {
  const estimate = reconstructed("2026-09-07", "2026-09-08");
  const recorded = [
    { ...SCORE, observed_at: "2026-09-09T01:00:00Z" },
    { ...SCORE, ...evidence("2026-09-08", "2026-09-09"), observation_id: 2, observed_at: "2026-09-09T04:00:00Z" },
  ];
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    recorded_scores: recorded,
    reconstructed_scores: [estimate, reconstructed("2026-09-09", "2026-09-10")],
  });
  expect(data.map((point) => [point.timestamp, point.provenance, point.run])).toEqual([
    [Date.parse(recorded[0]!.observed_at), "recorded", 0],
    [Date.parse(recorded[1]!.observed_at), "recorded", 0],
    [Date.parse("2026-09-10"), "reconstructed", 0],
  ]);
  expect(new Set(data.map((point) => point.score)).size).toBe(1);
});

test("keeps a coincident different population and breaks the line at its boundary", () => {
  const population: NonNullable<typeof SCORE.population_ref> = {
    source_id: "all-reviews",
    population: "all_reviews",
    endpoint: "appreviewhistogram",
    request_filter: "none",
    language: null,
    purchase_type: null,
    filter_offtopic_activity: null,
    population_flags: {},
    interpretation_version: "test",
  };
  const estimate = { ...reconstructed("2026-09-07", "2026-09-08"), population_ref: population };
  const later = { ...reconstructed("2026-09-08", "2026-09-09"), population_ref: population };
  const distinctScope = { ...reconstructed("2026-09-06", "2026-09-08"), value: 42 };
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    recorded_scores: [SCORE],
    reconstructed_scores: [estimate, estimate, distinctScope, later],
  });
  expect(data.map((point) => [point.provenance, point.run])).toEqual([
    ["recorded", 0], ["reconstructed", 1], ["reconstructed", 2], ["reconstructed", 3],
  ]);
  expect(new Set(data.map((point) => point.id)).size).toBe(4);
});

test("keeps the historical reconstruction when the only recorded match is a later recalculation", () => {
  const estimate = reconstructed("2026-09-07", "2026-09-08");
  const calculatedAt = "2026-09-10T00:00:00Z";
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    recorded_scores: [{
      ...SCORE,
      observed_at: calculatedAt,
      recalculation: { calculated_at: calculatedAt, previous_formula_version: "steam-player-v1", previous_observation_id: 1 },
    }],
    reconstructed_scores: [estimate],
  });
  expect(data.map((point) => [point.timestamp, point.provenance, point.run])).toEqual([
    [Date.parse(estimate.score_at), "reconstructed", 0],
    [Date.parse(calculatedAt), "recorded", 1],
  ]);
});

test("Cyberpunk snapshot 90D uses all nine September collections and leaves the November gap", () => {
  // App 1091500, 2026-11-18 production snapshot evaluated on Nov 19 at 10:23 UTC.
  // The fixture projects the real timestamps, values, provenance and evidence coverage.
  function details(entry: typeof cyberpunk90d.recorded[number] | typeof cyberpunk90d.reconstructed[number]) {
    return {
      ...SCORE,
      ...entry,
      current_evidence_intervals: entry.current_evidence_intervals as typeof SCORE.current_evidence_intervals,
      historical_evidence_intervals: entry.historical_evidence_intervals as typeof SCORE.historical_evidence_intervals,
      population_ref: { source_id: entry.source_id } as NonNullable<typeof SCORE.population_ref>,
      historical_population_ref: { source_id: entry.historical_source_id } as NonNullable<typeof SCORE.historical_population_ref>,
    };
  }
  const data = buildScoreHistoryChartData({
    ...EMPTY_HISTORY,
    appid: 1091500,
    range: "90d",
    range_start: cyberpunk90d.range_start,
    range_end: cyberpunk90d.range_end,
    recorded_scores: cyberpunk90d.recorded.map(details),
    reconstructed_scores: cyberpunk90d.reconstructed.map((entry) => ({
      ...details(entry), kind: "reconstructed", score_at: entry.score_at, evaluated_at: entry.score_at,
    })),
  });
  expect(data).toHaveLength(27);
  expect(data.slice(0, 17).every((point) => point.provenance === "reconstructed" && point.run === 0)).toBe(true);
  expect(data.slice(17, 26).map((point) => [point.timestamp, point.score, point.provenance, point.run]))
    .toEqual(cyberpunk90d.recorded.slice(0, 9).map((entry) => [Date.parse(entry.observed_at), entry.value, "recorded", 1]));
  expect(data[26]).toMatchObject({ timestamp: Date.parse("2026-11-04T19:49:06.776Z"), provenance: "recorded", run: 2 });
  expect((data[26]!.timestamp - data[25]!.timestamp) / 86_400_000).toBeCloseTo(49.03);
});
