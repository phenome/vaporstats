import { afterEach, describe, expect, test } from "bun:test";
import { writeTransaction } from "../src/lib/db-transaction";
import { authorizeMediaRun, runSerializedMediaDiscovery } from "../src/lib/media-discovery";
import {
  advanceMediaProcessing,
  authorizeMediaProcessing,
} from "../src/lib/media-processing";
import { openTestDatabase, type TestDatabase } from "./support/db";
import {
  BALDURS_GATE,
  ControlledGeminiTransport,
  CYBERPUNK,
  discoveryFetch,
  extractionOutput,
  insertCompletedRun,
  overviewOutput,
  processingArticleHtml,
  seedApps,
} from "./support/media";

// Discovery and processing keep separate in-process promise queues but share
// one SQLite connection, as the server and the ingestion tick do.

const URL = "https://ign.com/articles/cyberpunk-review";
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

function fixture(): TestDatabase & { processingRunId: number } {
  const database = openTestDatabase("vaporstats-media-concurrency-");
  cleanups.push(database.cleanup);
  seedApps(database.native, [CYBERPUNK, BALDURS_GATE]);
  const processingRunId = insertCompletedRun(database.native, "initial:concurrency-processing", [CYBERPUNK]);
  database.native.prepare("INSERT INTO media_sources (appid, pass, original_url, title, outlet, retrieved_at, type, hands_on, platform, build_context) VALUES (?, 'initial', ?, 'Cyberpunk 2077 Review', 'IGN', ?, 'preview', 1, 'PC', 'Early Access')").run(CYBERPUNK, URL, "2026-09-11T00:00:00.000Z");
  return { ...database, processingRunId };
}

function count(value: TestDatabase, sql: string): number {
  return (value.native.query<{ count: number }, []>(sql).get()?.count) ?? 0;
}

describe("media writers sharing one connection", () => {
  test("a write from another chain waits for an open transaction and survives its rollback", async () => {
    const value = fixture();
    let opened!: () => void;
    const transactionOpen = new Promise<void>((resolve) => { opened = resolve; });
    const failing = writeTransaction(value.db, async () => {
      await value.db.prepare("INSERT INTO apps (appid, name, slug) VALUES (10, 'Rolled back', 'rolled-back')").run();
      opened();
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
      throw new Error("abandon transaction");
    });
    const outside = transactionOpen.then(() =>
      value.db.prepare("INSERT INTO apps (appid, name, slug) VALUES (20, 'Kept', 'kept')").run(),
    );

    await expect(failing).rejects.toThrow("abandon transaction");
    await outside;

    expect(value.native.query("SELECT appid FROM apps WHERE appid IN (10, 20)").all()).toEqual([{ appid: 20 }]);
  });

  test("discovery and processing authorizations started together both commit", async () => {
    const value = fixture();

    const [discovery, processing] = await Promise.all([
      authorizeMediaRun(value.db, { pass: "initial", games: [BALDURS_GATE] }),
      authorizeMediaProcessing(value.db, value.processingRunId),
    ]);

    expect(discovery.authorized).toBe(true);
    expect(processing).toEqual({ runId: value.processingRunId, status: "queued" });
    expect(value.native.query("SELECT status, selected_games FROM media_discovery_runs WHERE id = ?").get(discovery.runId)).toEqual({ status: "running", selected_games: "[1086940]" });
    expect(value.native.query("SELECT status FROM media_processing_authorizations WHERE run_id = ?").get(value.processingRunId)).toEqual({ status: "queued" });
    expect(value.native.inTransaction).toBe(false);
  });

  test("a triggered discovery run and a processing advance interleave without corrupting either", async () => {
    const value = fixture();
    await authorizeMediaProcessing(value.db, value.processingRunId);
    const transport = new ControlledGeminiTransport();
    transport.nextPolls.push(
      { state: "succeeded", output: extractionOutput(), usage: { inputTokens: 100, outputTokens: 20 } },
      { state: "succeeded", output: overviewOutput(URL), usage: { inputTokens: 100, outputTokens: 20 } },
    );
    const { fetchFn } = discoveryFetch();
    const processingOptions = {
      runId: value.processingRunId,
      transport,
      articleFetch: async () => processingArticleHtml(CYBERPUNK),
      now: new Date("2026-09-11T00:00:00.000Z"),
    };

    const [discovery, firstAdvance, secondAdvance] = await Promise.all([
      runSerializedMediaDiscovery(value.db, { games: [BALDURS_GATE], tavilyApiKey: "test-key", fetch: fetchFn, now: new Date("2026-09-10T00:00:00.000Z") }),
      advanceMediaProcessing(value.db, processingOptions),
      advanceMediaProcessing(value.db, { ...processingOptions, now: new Date("2026-09-11T00:01:00.000Z") }),
    ]);

    expect(discovery.status).toBe("completed");
    expect(discovery.articles).toBeGreaterThan(0);
    expect(firstAdvance.submitted).toBe(2);
    expect(secondAdvance.completed).toBeGreaterThanOrEqual(2);
    expect(count(value, "SELECT COUNT(*) AS count FROM media_sources WHERE appid = 1086940")).toBe(discovery.articles);
    expect(count(value, "SELECT COUNT(*) AS count FROM media_game_overviews WHERE appid = 1091500 AND active = 1")).toBe(1);
    expect(value.native.inTransaction).toBe(false);
  });
});
