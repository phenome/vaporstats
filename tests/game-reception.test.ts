import { describe, expect, test } from "bun:test";
import type { ScoreMilestone } from "../src/lib/score";
import { selectScoreMilestones } from "../src/lib/score-milestone-density";

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
