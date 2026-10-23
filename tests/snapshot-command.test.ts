import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const command = resolve(import.meta.dir, "../scripts/snapshot-retention.ts");

interface RetentionReport {
  mode: "plan" | "apply";
  directory: string;
  activeDatabasePath: string;
  candidates: { name: string; sizeBytes: number; allocatedBytes: number }[];
  keep: string[];
  remove: string[];
  ignored: string[];
  estimatedRemoval: { sizeBytes: number; allocatedBytes: number };
  deleted: string[];
}

describe("snapshot retention command", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "vaporstats-snapshot-command-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function run(args: string[] = [], configuredPaths = true) {
    const env = { ...process.env };
    delete env.DATABASE_PATH;
    delete env.DATABASE_SNAPSHOT_DIR;
    if (configuredPaths) {
      env.DATABASE_PATH = join(directory, "snapshots", "vaporstats-2020-01-01.sqlite");
      env.DATABASE_SNAPSHOT_DIR = join(directory, "snapshots");
    }
    const child = Bun.spawn([process.execPath, command, ...args], {
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  function seedSnapshots(snapshotDirectory = join(directory, "snapshots")): string[] {
    mkdirSync(snapshotDirectory, { recursive: true });
    const names: string[] = [];
    for (let day = 0; day < 40; day += 1) {
      const date = new Date(Date.UTC(2020, 0, 1 + day)).toISOString().slice(0, 10);
      const name = "vaporstats-" + date + ".sqlite";
      // Deliberately not SQLite: maintenance must never open or migrate these files.
      writeFileSync(join(snapshotDirectory, name), "snapshot " + date);
      names.push(name);
    }
    writeFileSync(join(snapshotDirectory, "pre-deploy.sqlite"), "operational recovery copy");
    return names;
  }

  test("plans without writes, then deletes only the explicit apply removal set", async () => {
    const names = seedSnapshots();
    const snapshotDirectory = join(directory, "snapshots");
    const before = readdirSync(snapshotDirectory).sort();
    const planned = await run();
    expect(planned.exitCode).toBe(0);
    expect(planned.stderr).toBe("");
    const plan = JSON.parse(planned.stdout) as RetentionReport;
    const expectedKeep = [
      "2020-01-01", // Active source database identity is protected.
      "2020-01-19",
      "2020-01-26",
      "2020-01-31",
      "2020-02-02",
      "2020-02-03",
      "2020-02-04",
      "2020-02-05",
      "2020-02-06",
      "2020-02-07",
      "2020-02-08",
      "2020-02-09",
    ].map((date) => "vaporstats-" + date + ".sqlite");
    const expectedRemove = names.filter((name) => !expectedKeep.includes(name));
    expect(plan.mode).toBe("plan");
    expect(plan.keep).toEqual(expectedKeep);
    expect(plan.remove).toEqual(expectedRemove);
    expect(plan.ignored).toContain("pre-deploy.sqlite");
    expect(plan.deleted).toEqual([]);
    expect(plan.candidates.map((entry) => entry.name)).toEqual(names);
    expect(plan.estimatedRemoval).toEqual(expectedRemove.reduce(
      (sum, name) => {
        const stat = statSync(join(snapshotDirectory, name));
        return { sizeBytes: sum.sizeBytes + stat.size, allocatedBytes: sum.allocatedBytes + stat.blocks * 512 };
      },
      { sizeBytes: 0, allocatedBytes: 0 },
    ));
    expect(readdirSync(snapshotDirectory).sort()).toEqual(before);
    for (const name of names) {
      expect(readFileSync(join(snapshotDirectory, name), "utf8")).toBe("snapshot " + name.slice(11, 21));
    }

    const applied = await run(["--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr).toBe("");
    const report = JSON.parse(applied.stdout) as RetentionReport;
    expect(report.mode).toBe("apply");
    expect(report.remove).toEqual(expectedRemove);
    expect(report.deleted).toEqual(expectedRemove);
    expect(readdirSync(snapshotDirectory).sort()).toEqual([...expectedKeep, "pre-deploy.sqlite"].sort());
    expect(readFileSync(join(snapshotDirectory, names[0]!), "utf8")).toBe("snapshot 2020-01-01");
    expect(readFileSync(join(snapshotDirectory, "pre-deploy.sqlite"), "utf8")).toBe("operational recovery copy");
  });

  test("uses existing relative defaults without opening or migrating the active database", async () => {
    const snapshotDirectory = join(directory, "data", "snapshots");
    seedSnapshots(snapshotDirectory);
    const activeDatabasePath = join(directory, "data", "vaporstats.sqlite");
    writeFileSync(activeDatabasePath, "not a SQLite database");
    const before = readdirSync(snapshotDirectory).sort();
    const result = await run([], false);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as RetentionReport;
    expect(report.directory).toBe(snapshotDirectory);
    expect(report.activeDatabasePath).toBe(activeDatabasePath);
    expect(report.mode).toBe("plan");
    expect(report.remove.length).toBeGreaterThan(0);
    expect(report.deleted).toEqual([]);
    expect(readdirSync(snapshotDirectory).sort()).toEqual(before);
    expect(readdirSync(join(directory, "data")).sort()).toEqual(["snapshots", "vaporstats.sqlite"]);
    expect(readFileSync(activeDatabasePath, "utf8")).toBe("not a SQLite database");
  });

  test("rejects unknown, repeated, and conflicting arguments before deletion", async () => {
    seedSnapshots();
    const snapshotDirectory = join(directory, "snapshots");
    const before = readdirSync(snapshotDirectory).sort();
    for (const args of [
      ["--plan"],
      ["--apply=true"],
      ["apply"],
      ["--apply", "--apply"],
      ["--apply", "--plan"],
      ["--help", "--apply"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid arguments:");
      expect(readdirSync(snapshotDirectory).sort()).toEqual(before);
    }
  });
});
