import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnapshotRetention, type SnapshotRetentionOptions } from "../src/lib/snapshot-storage";

const referenceDate = new Date("2025-01-31T12:00:00Z");
const filename = (day: number) => `vaporstats-2025-01-${String(day).padStart(2, "0")}.sqlite`;

describe("local snapshot retention", () => {
  let root: string;
  let directory: string;
  let activeDatabasePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vaporstats-retention-"));
    directory = join(root, "snapshots");
    mkdirSync(directory);
    activeDatabasePath = join(root, "active.sqlite");
    writeFileSync(activeDatabasePath, "active database");
    for (let day = 1; day <= 31; day++) writeFileSync(join(directory, filename(day)), `snapshot ${day}`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function options(mode: "plan" | "apply"): SnapshotRetentionOptions {
    return { directory, activeDatabasePath, referenceDate, mode };
  }

  test("plans without writes or opening SQLite and reports logical and allocated sizes", async () => {
    const before = readdirSync(directory);
    const result = await runSnapshotRetention(options("plan"));
    expect(result.plan.remove).toContain(filename(2));
    expect(result.deleted).toEqual([]);
    expect(readdirSync(directory)).toEqual(before);
    expect(readFileSync(activeDatabasePath, "utf8")).toBe("active database");
    const candidate = result.candidates.find((entry) => entry.name === filename(2))!;
    const stat = statSync(candidate.path);
    expect(candidate.sizeBytes).toBe(stat.size);
    expect(candidate.allocatedBytes).toBe(stat.blocks * 512);
    expect(readdirSync(root).sort()).toEqual(["active.sqlite", "snapshots"]);
  });

  test("deletes only managed regular files and protects paths, aliases and pending WALs", async () => {
    const active = join(directory, filename(2));
    unlinkSync(active);
    linkSync(activeDatabasePath, active);
    const preserved = join(directory, filename(3));
    const preservedAlias = join(directory, filename(5));
    unlinkSync(preservedAlias);
    linkSync(preserved, preservedAlias);
    writeFileSync(join(directory, filename(4) + "-wal"), "committed WAL");
    const symlink = join(directory, filename(6));
    unlinkSync(symlink);
    symlinkSync(activeDatabasePath, symlink);
    const nested = join(directory, "vaporstats-2025-01-07.sqlite");
    unlinkSync(nested);
    mkdirSync(nested);
    writeFileSync(join(nested, filename(8)), "nested");
    const ignored = ["pre-deploy.sqlite", "deploy-2025.sqlite", "vaporstats-2025-02-30.sqlite", "vaporstats-2026-01-01.sqlite", "vaporstats-2025-01-08.sqlite.tmp", "vaporstats-2025-01-08.sqlite-shm"];
    for (const name of ignored) writeFileSync(join(directory, name), "untouched");
    writeFileSync(join(directory, filename(8) + "-wal"), "");

    const result = await runSnapshotRetention({ ...options("apply"), preservePaths: [preserved] });
    expect(result.deleted).toContain(filename(8));
    for (const day of [2, 3, 4, 5, 6, 7, 31]) expect(existsSync(join(directory, filename(day)))).toBe(true);
    for (const name of ignored) expect(readFileSync(join(directory, name), "utf8")).toBe("untouched");
    expect(readFileSync(join(nested, filename(8)), "utf8")).toBe("nested");
    expect(readFileSync(join(directory, filename(4) + "-wal"), "utf8")).toBe("committed WAL");
    expect(existsSync(join(directory, filename(8) + "-wal"))).toBe(true);
    expect(readFileSync(activeDatabasePath, "utf8")).toBe("active database");
    for (const name of result.deleted) expect(existsSync(join(directory, name))).toBe(false);
    expect(result.deleted).toEqual(result.plan.remove);
  });

  test("protects the active database through a symlinked directory path", async () => {
    const active = join(directory, filename(2));
    const alias = join(root, "alias");
    symlinkSync(directory, alias);
    const result = await runSnapshotRetention({ ...options("apply"), activeDatabasePath: join(alias, filename(2)) });
    expect(result.plan.keep).toContain(filename(2));
    expect(readFileSync(active, "utf8")).toBe("snapshot 2");
  });

  test("prunes managed hardlink aliases while retaining their policy keeper", async () => {
    const keeper = join(directory, filename(31));
    for (const day of [2, 3]) {
      const alias = join(directory, filename(day));
      unlinkSync(alias);
      linkSync(keeper, alias);
    }
    expect(statSync(keeper).nlink).toBe(3);
    const result = await runSnapshotRetention(options("apply"));
    expect(result.deleted).toEqual(result.plan.remove);
    expect(result.deleted).toContain(filename(2));
    expect(result.deleted).toContain(filename(3));
    expect(readFileSync(keeper, "utf8")).toBe("snapshot 31");
    expect(statSync(keeper).nlink).toBe(1);
  });

  test("prunes every ordinary managed hardlink candidate without false replacement errors", async () => {
    const original = join(directory, filename(2));
    const alias = join(directory, filename(3));
    unlinkSync(alias);
    linkSync(original, alias);
    expect(statSync(original).nlink).toBe(2);
    const result = await runSnapshotRetention(options("apply"));
    expect(result.deleted).toEqual(result.plan.remove);
    expect(result.deleted).toContain(filename(2));
    expect(result.deleted).toContain(filename(3));
    expect(existsSync(original)).toBe(false);
    expect(existsSync(alias)).toBe(false);
    expect(readFileSync(join(directory, filename(31)), "utf8")).toBe("snapshot 31");
  });

  for (const change of ["replacement", "keeper removal", "WAL arrival", "source replacement", "directory replacement"] as const) {
    test(`fails closed before deletion on concurrent ${change}`, async () => {
      const pending = runSnapshotRetention(options("apply"));
      if (change === "replacement") {
        const path = join(directory, filename(8));
        renameSync(path, join(root, "original"));
        writeFileSync(path, "replacement");
      } else if (change === "keeper removal") {
        unlinkSync(join(directory, filename(31)));
      } else if (change === "WAL arrival") {
        writeFileSync(join(directory, filename(8) + "-wal"), "new transaction");
      } else if (change === "source replacement") {
        renameSync(activeDatabasePath, join(root, "old-active"));
        writeFileSync(activeDatabasePath, "new source");
      } else {
        renameSync(directory, join(root, "original-directory"));
        mkdirSync(directory);
      }
      await expect(pending).rejects.toThrow("changed");
      const originalDirectory = change === "directory replacement" ? join(root, "original-directory") : directory;
      expect(readFileSync(join(originalDirectory, filename(9)), "utf8")).toBe("snapshot 9");
      expect(readFileSync(join(originalDirectory, filename(10)), "utf8")).toBe("snapshot 10");
    });
  }
});
