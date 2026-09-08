import type { ScoreMilestone } from "./score";

export const SCORE_MILESTONE_LABEL_WIDTH = 62;
export const SCORE_MILESTONE_LABEL_GAP = 3;

type Candidate = {
  milestone: ScoreMilestone;
  timestamp: number;
  left: number;
  right: number;
  priority: number;
};

function milestonePriority(kind: string | null): number {
  if (kind === "major_update" || kind === "14") return 3;
  if (kind === "patch" || kind === "patch_notes" || kind === "regular_update" || kind === "early_access" || kind === "full_release") return 2;
  return 1;
}

/** Keep labels readable without hiding the complete milestone list below the chart. */
export function selectScoreMilestones(
  milestones: readonly ScoreMilestone[],
  domain: readonly [number, number],
  plotWidth: number,
): ScoreMilestone[] {
  const [start, end] = domain;
  const span = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || span <= 0 || !(plotWidth > 0)) return [];

  const midpoint = (start + end) / 2;
  const candidates: Candidate[] = [];
  for (const milestone of milestones) {
    const timestamp = Date.parse(milestone.event_time);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
    const x = ((timestamp - start) / span) * plotWidth;
    const alignLeft = timestamp >= midpoint;
    candidates.push({
      milestone,
      timestamp,
      left: x + (alignLeft ? -(SCORE_MILESTONE_LABEL_WIDTH + SCORE_MILESTONE_LABEL_GAP) : SCORE_MILESTONE_LABEL_GAP),
      right: x + (alignLeft ? -SCORE_MILESTONE_LABEL_GAP : SCORE_MILESTONE_LABEL_WIDTH + SCORE_MILESTONE_LABEL_GAP),
      priority: milestonePriority(milestone.kind),
    });
  }

  candidates.sort((left, right) => right.priority - left.priority || right.timestamp - left.timestamp || left.milestone.event_id.localeCompare(right.milestone.event_id));
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (selected.every((other) => candidate.right <= other.left || candidate.left >= other.right)) selected.push(candidate);
  }
  return selected
    .sort((left, right) => left.timestamp - right.timestamp || left.milestone.event_id.localeCompare(right.milestone.event_id))
    .map(({ milestone }) => milestone);
}
