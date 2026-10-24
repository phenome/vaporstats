import { describe, expect, test } from "bun:test";
import {
  planSnapshotRetention,
  type SnapshotRetentionPlan,
  type SnapshotRetentionReason,
} from "../src/lib/snapshot-retention";

function snapshot(day: string): string {
  return `vaporstats-${day}.sqlite`;
}

function snapshots(days: readonly string[]): string[] {
  return days.map(snapshot).sort();
}

function daysBetween(first: string, last: string): string[] {
  const days: string[] = [];
  const date = new Date(`${first}T00:00:00Z`);
  while (date.toISOString().slice(0, 10) <= last) {
    days.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return days;
}

function selectedFor(plan: SnapshotRetentionPlan, reason: SnapshotRetentionReason): string[] {
  return plan.keep.filter((name) => plan.reasons[name]?.includes(reason));
}

describe("snapshot retention", () => {
  test("keeps the latest recovery point once with every applicable reason", () => {
    const latest = snapshot("2026-10-23");
    expect(planSnapshotRetention([latest], new Date("2026-10-23T00:00:00Z"))).toEqual({
      keep: [latest],
      remove: [],
      ignored: [],
      reasons: { [latest]: ["daily", "monthly", "weekly", "yearly"] },
    });
    expect(planSnapshotRetention([], new Date("2026-10-23T12:00:00Z"))).toEqual({
      keep: [],
      remove: [],
      ignored: [],
      reasons: {},
    });
  });

  test("preserves calendar recovery points through daily generation and pruning for seven years", () => {
    let retained: string[] = [];
    let finalPlan: SnapshotRetentionPlan | undefined;
    const completedYears: string[] = [];

    for (const day of daysBetween("2019-01-01", "2026-03-02")) {
      const plan = planSnapshotRetention([...retained, snapshot(day)], new Date(`${day}T12:00:00Z`));
      retained = plan.keep;
      finalPlan = plan;
      expect(retained).toContain(snapshot(day));
      if (day.endsWith("-12-31")) completedYears.push(snapshot(day));
      for (const yearEnd of completedYears) expect(retained).toContain(yearEnd);
      if (day === "2020-03-07") {
        expect(selectedFor(plan, "monthly")).toContain(snapshot("2020-02-29"));
      }
    }

    const expected = new Set([
      ...snapshots(daysBetween("2026-02-24", "2026-03-02")),
      ...snapshots(["2026-02-15", "2026-02-22"]),
      ...snapshots([
        "2025-04-30", "2025-05-31", "2025-06-30", "2025-07-31",
        "2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30",
        "2025-12-31", "2026-01-31",
      ]),
      ...snapshots([
        "2019-12-31", "2020-12-31", "2021-12-31", "2022-12-31",
        "2023-12-31", "2024-12-31",
      ]),
    ]);
    expect(retained).toEqual([...expected].sort());
    expect(selectedFor(finalPlan!, "weekly")).toEqual(snapshots([
      "2026-02-15", "2026-02-22", "2026-03-01", "2026-03-02",
    ]));
    expect(selectedFor(finalPlan!, "yearly")).toEqual(snapshots([
      "2019-12-31", "2020-12-31", "2021-12-31", "2022-12-31",
      "2023-12-31", "2024-12-31", "2025-12-31", "2026-03-02",
    ]));
    expect(retained).not.toContain(snapshot("2020-02-29"));
  });

  test("uses Monday-based ISO weeks across the week-year boundary", () => {
    const plan = planSnapshotRetention(snapshots([
      "2020-12-20", "2020-12-27", "2020-12-28", "2020-12-31",
      "2021-01-01", "2021-01-03", "2021-01-04", "2021-01-10", "2021-01-11",
    ]), new Date("2021-01-11T00:00:00Z"));

    expect(selectedFor(plan, "weekly")).toEqual(snapshots([
      "2020-12-27", "2021-01-03", "2021-01-10", "2021-01-11",
    ]));
    expect(selectedFor(plan, "monthly")).toEqual(snapshots(["2020-12-31", "2021-01-11"]));
    expect(selectedFor(plan, "yearly")).toEqual(snapshots(["2020-12-31", "2021-01-11"]));
  });

  test("counts available days, weeks and months despite extended generation outages", () => {
    const successfulDays = [
      "2017-01-02", "2018-04-03", "2019-07-04", "2020-02-29",
      "2020-09-30", "2021-03-31", "2021-11-30", "2022-06-30",
      "2023-01-31", "2023-08-31", "2024-02-29", "2024-09-30",
      "2025-03-31", "2025-11-30", "2026-05-31",
    ];
    let retained: string[] = [];
    for (const day of successfulDays) {
      retained = planSnapshotRetention([...retained, snapshot(day)], new Date(`${day}T12:00:00Z`)).keep;
    }
    const plan = planSnapshotRetention(retained, new Date("2035-12-31T23:59:59Z"));
    expect(selectedFor(plan, "daily")).toEqual(snapshots(successfulDays.slice(-7)));
    expect(selectedFor(plan, "weekly")).toEqual(snapshots(successfulDays.slice(-4)));
    expect(selectedFor(plan, "monthly")).toEqual(snapshots(successfulDays.slice(-12)));
    expect(selectedFor(plan, "yearly")).toEqual(snapshots([
      "2017-01-02", "2018-04-03", "2019-07-04", "2020-09-30", "2021-11-30",
      "2022-06-30", "2023-08-31", "2024-09-30", "2025-11-30", "2026-05-31",
    ]));
    expect(plan.keep).toEqual(retained);
    expect(plan.remove).toEqual([]);
  });

  test("chooses the last successful day rather than assuming month-end or week-end generation", () => {
    const names = snapshots([
      "2024-01-10", "2024-01-19", "2024-02-01", "2024-02-27",
      ...daysBetween("2024-03-01", "2024-04-10"),
    ]);
    const plan = planSnapshotRetention(names, new Date("2024-04-10T18:00:00Z"));
    expect(selectedFor(plan, "monthly")).toEqual(snapshots([
      "2024-01-19", "2024-02-27", "2024-03-31", "2024-04-10",
    ]));
    expect(selectedFor(plan, "weekly")).toEqual(snapshots([
      "2024-03-24", "2024-03-31", "2024-04-07", "2024-04-10",
    ]));
    expect(plan.keep).toContain(snapshot("2024-02-27"));
    expect(plan.remove).toContain(snapshot("2024-01-10"));
    expect(plan.remove).toContain(snapshot("2024-02-01"));
  });

  test("recognizes only exact filenames with real dates and protects invalid and future names", () => {
    const ignored = [
      "vaporstats-1900-02-29.sqlite", "vaporstats-2100-02-29.sqlite",
      "vaporstats-2024-02-30.sqlite", "vaporstats-2026-04-31.sqlite",
      "vaporstats-2026-00-01.sqlite", "vaporstats-2026-13-01.sqlite",
      "vaporstats-2026-01-00.sqlite", "vaporstats-2026-1-01.sqlite",
      "vaporstats-2026-10-24.sqlite", "vaporstats-9999-12-31.sqlite",
      "vaporstats-2026-10-23.sqlite-wal", "vaporstats-2026-10-23.sqlite-shm",
      "vaporstats-2026-10-23.sqlite.tmp", "vaporstats-2026-10-23.sqlite\n",
      "pre-vaporstats-2026-10-23.sqlite", "deploy-2026-10-23.sqlite",
      "../vaporstats-2026-10-23.sqlite", "/tmp/vaporstats-2026-10-23.sqlite",
      "Vaporstats-2026-10-23.sqlite", "vaporstats-2026-10-23.SQLITE", "",
    ];
    const valid = snapshots(["2000-02-29", "2024-02-29", "2026-10-23"]);
    const plan = planSnapshotRetention([...ignored, ...valid], new Date("2026-10-23T23:59:59Z"));
    expect(plan.ignored).toEqual([...ignored].sort());
    expect(plan.keep).toEqual(valid);
    expect(plan.remove).toEqual([]);
    expect(Object.keys(plan.reasons).sort()).toEqual(valid);
  });

  test("uses the UTC reference day rather than the reference's written timezone", () => {
    const names = snapshots(["2026-10-22", "2026-10-23", "2026-10-24"]);
    const plan = planSnapshotRetention(names, new Date("2026-10-23T23:30:00-02:00"));
    expect(plan.keep).toEqual(names);
    expect(plan.ignored).toEqual([]);
    const earlier = planSnapshotRetention(names, new Date("2026-10-23T00:30:00+02:00"));
    expect(earlier.keep).toEqual(snapshots(["2026-10-22"]));
    expect(earlier.ignored).toEqual(snapshots(["2026-10-23", "2026-10-24"]));
  });

  test("deduplicates and partitions shuffled inputs without mutation, with stable sorted reporting", () => {
    const names = [...snapshots(daysBetween("2026-07-01", "2026-10-23")), "not-a-snapshot"];
    const expected = planSnapshotRetention(names, new Date("2026-10-23T12:00:00Z"));
    const shuffled = Object.freeze([...names.filter((_, index) => index % 2 === 0).reverse(), ...names, ...names]);
    const original = [...shuffled];
    const actual = planSnapshotRetention(shuffled, new Date("2026-10-23T12:00:00Z"));
    expect(actual).toEqual(expected);
    expect(shuffled).toEqual(original);
    expect([...actual.keep, ...actual.remove, ...actual.ignored].sort()).toEqual([...names].sort());
    expect(actual.remove.length).toBeGreaterThan(0);
    for (const values of [actual.keep, actual.remove, actual.ignored, ...Object.values(actual.reasons)]) {
      expect(values).toEqual([...new Set(values)].sort());
    }
    expect(Object.keys(actual.reasons).sort()).toEqual(actual.keep);
    expect(planSnapshotRetention(actual.keep, new Date("2026-10-23T12:00:00Z")).keep).toEqual(actual.keep);
  });

  test("does not offer deletion when the reference date is invalid", () => {
    expect(() => planSnapshotRetention(
      snapshots(daysBetween("2026-01-01", "2026-02-01")),
      new Date(Number.NaN),
    )).toThrow(RangeError);
  });
});
