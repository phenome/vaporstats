import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase } from "./support/db";
import { testTemporaryRoot } from "./support/tmpdir";

const configured = process.env.VAPORSTATS_TEST_TMPDIR;
afterEach(() => {
  if (configured === undefined) delete process.env.VAPORSTATS_TEST_TMPDIR;
  else process.env.VAPORSTATS_TEST_TMPDIR = configured;
});

test("temporary SQLite files go under VAPORSTATS_TEST_TMPDIR when it is set, creating it when missing", () => {
  const root = mkdtempSync(join(tmpdir(), "vaporstats-root-"));
  try {
    process.env.VAPORSTATS_TEST_TMPDIR = join(root, "nested");
    expect(testTemporaryRoot()).toBe(join(root, "nested"));
    const database = openTestDatabase();
    try {
      expect(database.databasePath.startsWith(join(root, "nested") + "/")).toBe(true);
      expect(existsSync(database.databasePath)).toBe(true);
    } finally {
      database.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("temporary SQLite files fall back to the system temporary directory", () => {
  delete process.env.VAPORSTATS_TEST_TMPDIR;
  expect(testTemporaryRoot()).toBe(tmpdir());
  process.env.VAPORSTATS_TEST_TMPDIR = "";
  expect(testTemporaryRoot()).toBe(tmpdir());
});
