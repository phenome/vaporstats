import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fingerprintMigrations } from "../scripts/migration-fingerprint";

const temporaryDirectories: string[] = [];
const artifacts = [
  ["0001_catalog.sql", "CREATE TABLE catalog (id INTEGER);\n"],
  ["0002_reviews.sql", "CREATE TABLE reviews (id INTEGER);\n"],
  ["meta/_journal.json", '{"entries":[{"tag":"0001_catalog"},{"tag":"0002_reviews"}]}\n'],
  ["meta/0001_snapshot.json", '{"tables":{"catalog":{}}}\n'],
  ["meta/0002_snapshot.json", '{"tables":{"catalog":{},"reviews":{}}}\n'],
] as const;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vaporstats-migration-fingerprint-"));
  temporaryDirectories.push(directory);
  return directory;
}

function migrationTree(reverse = false): string {
  const directory = temporaryDirectory();
  const entries = reverse ? [...artifacts].reverse() : artifacts;
  for (const [relativePath, bytes] of entries) {
    const path = join(directory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    // Restore permissions for cleanup after the unreadable-directory case.
    chmodSync(directory, 0o700);
    const meta = join(directory, "meta");
    try {
      chmodSync(meta, 0o700);
    } catch {
      // Some failure fixtures intentionally have no metadata directory.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration artifact fingerprints", () => {
  test("ignores creation order, timestamps, permissions, and absolute tree location", () => {
    const running = migrationTree();
    const candidate = migrationTree(true);
    for (const [relativePath] of artifacts) {
      const path = join(candidate, relativePath);
      chmodSync(path, 0o640);
      utimesSync(path, new Date("2000-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    }
    expect(fingerprintMigrations(candidate)).toBe(fingerprintMigrations(running));
  });

  test.each([
    ["SQL", "0002_reviews.sql"],
    ["snapshot", "meta/0002_snapshot.json"],
  ] as const)("detects changed, moved, added, and deleted %s evidence", (_kind, relativePath) => {
    const running = migrationTree();
    const original = fingerprintMigrations(running);
    for (const operation of ["change", "move", "add", "delete"] as const) {
      const candidate = migrationTree();
      const path = join(candidate, relativePath);
      switch (operation) {
        case "change":
          writeFileSync(path, Buffer.from([0, 1, 2, 255]));
          break;
        case "move":
          mkdirSync(join(candidate, "archive"));
          renameSync(path, join(candidate, "archive", basename(relativePath)));
          break;
        case "add":
          writeFileSync(join(dirname(path), `added-${basename(path)}`), "additional migration evidence\n");
          break;
        case "delete":
          rmSync(path);
          break;
      }
      expect(fingerprintMigrations(candidate)).not.toBe(original);
    }
  });

  test("detects a journal-only change even when all SQL and snapshots are unchanged", () => {
    const running = migrationTree();
    const candidate = migrationTree();
    writeFileSync(join(candidate, "meta/_journal.json"), '{"entries":[]}\n');
    expect(fingerprintMigrations(candidate)).not.toBe(fingerprintMigrations(running));
  });

  test("rejects a missing tree, empty tree, missing journal, or missing SQL", () => {
    expect(() => fingerprintMigrations(join(temporaryDirectory(), "missing"))).toThrow();
    expect(() => fingerprintMigrations(temporaryDirectory())).toThrow();
    const noJournal = migrationTree();
    rmSync(join(noJournal, "meta/_journal.json"));
    expect(() => fingerprintMigrations(noJournal)).toThrow();
    const noSql = migrationTree();
    for (const [relativePath] of artifacts) {
      if (relativePath.endsWith(".sql")) rmSync(join(noSql, relativePath));
    }
    expect(() => fingerprintMigrations(noSql)).toThrow();
  });

  test("rejects inaccessible dangling links rather than silently omitting evidence", () => {
    const directory = migrationTree();
    rmSync(join(directory, "0002_reviews.sql"));
    symlinkSync(join(directory, "missing.sql"), join(directory, "0002_reviews.sql"));
    expect(() => fingerprintMigrations(directory)).toThrow();
  });

  test("rejects a non-directory migration root", () => {
    const path = join(temporaryDirectory(), "migrations");
    writeFileSync(path, "not a directory");
    expect(() => fingerprintMigrations(path)).toThrow();
  });

  test.skipIf(process.getuid?.() === 0)("propagates filesystem permission errors", () => {
    const unreadableFile = migrationTree();
    chmodSync(join(unreadableFile, "0002_reviews.sql"), 0o000);
    expect(() => fingerprintMigrations(unreadableFile)).toThrow();
    const unreadableDirectory = migrationTree();
    chmodSync(join(unreadableDirectory, "meta"), 0o000);
    expect(() => fingerprintMigrations(unreadableDirectory)).toThrow();
  });
});
