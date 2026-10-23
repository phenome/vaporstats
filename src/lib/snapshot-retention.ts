export type SnapshotRetentionReason = "daily" | "weekly" | "monthly" | "yearly";

export interface SnapshotRetentionPlan {
  keep: string[];
  remove: string[];
  ignored: string[];
  reasons: Record<string, SnapshotRetentionReason[]>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function planSnapshotRetention(
  names: readonly string[],
  referenceDate: Date,
): SnapshotRetentionPlan {
  const referenceTime = referenceDate.getTime();
  if (!Number.isFinite(referenceTime)) {
    throw new RangeError("Snapshot retention requires a valid reference date");
  }

  const plan: SnapshotRetentionPlan = { keep: [], remove: [], ignored: [], reasons: {} };
  const days = new Set<string>();
  const weeks = new Set<number>();
  const months = new Set<string>();
  const years = new Set<string>();

  // Descending order makes the first snapshot in each available period its newest.
  for (const name of [...new Set(names)].sort().reverse()) {
    const match = /^vaporstats-(\d{4}-\d{2}-\d{2})\.sqlite$/.exec(name);
    const date = match ? new Date(`${match[1]}T00:00:00.000Z`) : null;
    if (
      !date ||
      !Number.isFinite(date.getTime()) ||
      name !== `vaporstats-${date.toISOString().slice(0, 10)}.sqlite` ||
      date.getTime() > referenceTime
    ) {
      plan.ignored.push(name);
      continue;
    }

    const day = date.toISOString().slice(0, 10);
    const week = date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS;
    const month = day.slice(0, 7);
    const year = day.slice(0, 4);
    const reasons: SnapshotRetentionReason[] = [];

    if (!days.has(day) && days.size < 7) {
      days.add(day);
      reasons.push("daily");
    }
    // Use Monday's timestamp rather than a calendar year plus week number:
    // an ISO week can span two calendar years.
    if (!weeks.has(week) && weeks.size < 4) {
      weeks.add(week);
      reasons.push("weekly");
    }
    if (!months.has(month) && months.size < 12) {
      months.add(month);
      reasons.push("monthly");
    }
    if (!years.has(year)) {
      years.add(year);
      reasons.push("yearly");
    }

    if (reasons.length > 0) {
      plan.keep.push(name);
      plan.reasons[name] = reasons.sort();
    } else {
      plan.remove.push(name);
    }
  }

  plan.keep.reverse();
  plan.remove.reverse();
  plan.ignored.reverse();
  return plan;
}
