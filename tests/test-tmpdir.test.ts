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

test("a copy of a test database keeps its rows, written to its own file, and later writes stay separate", async () => {
  const { copyTestDatabase } = await import("./support/db");
  const original = openTestDatabase();
  try {
    original.native.exec("INSERT INTO apps (appid, name, slug) VALUES (10, 'Copied', 'copied')");
    const copy = copyTestDatabase(original);
    try {
      expect(copy.databasePath).not.toBe(original.databasePath);
      expect(copy.native.query("SELECT name FROM apps WHERE appid = 10").get()).toEqual({ name: "Copied" });
      copy.native.exec("INSERT INTO apps (appid, name, slug) VALUES (11, 'Only copy', 'only-copy')");
      expect(original.native.query("SELECT COUNT(*) AS count FROM apps WHERE appid = 11").get()).toEqual({ count: 0 });
    } finally {
      copy.cleanup();
    }
  } finally {
    original.cleanup();
  }
});
