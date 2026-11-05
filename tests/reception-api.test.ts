import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { applyMigrations } from "../src/lib/migrations";
import { publishReceptionProjection } from "../src/lib/reception-publication";
import { handleRankingsHttpRequest } from "../src/routes/rankings.index";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { handleFacetsRequest, listAllNamedFacets } from "../src/routes/api.facets";
import { handleGameScoreRequest } from "../src/routes/api.games.$appid.score";
import { handleRankingsRequest, parseReceptionRequest } from "../src/routes/api.rankings";
import type { FacetDictionaryEntry } from "../src/lib/taxonomy";

const failingDb: AppDatabase = {
  prepare() {
    throw new Error("database unavailable");
  },
  async batch<T = unknown>(): Promise<{ success: boolean; results?: T[] }[]> {
    throw new Error("database unavailable");
  },
  async exec() {
    throw new Error("database unavailable");
  },
};

class FacetDb implements AppDatabase {
  readonly entries: FacetDictionaryEntry[] = Array.from({ length: 501 }, (_, index) => ({
    facet_group: index % 3 === 0 ? "genre" : index % 3 === 1 ? "feature" : "community_tag",
    source_id: String(index + 1),
    name: `Facet ${index + 1}`,
  }));

  prepare(query: string): AppPreparedStatement {
    const thisEntries = this.entries;
    let values: unknown[] = [];
    const statement: AppPreparedStatement = {
      bind: (...next) => {
        values = next;
        return statement;
      },
      async first<T>() {
        if (query.includes("MAX(updated_at)")) {
          return { source_timestamp: "2026-09-07T12:00:00.000Z" } as T;
        }
        return null;
      },
      async all<T>() {
        const offset = Number(values.at(-1) ?? 0);
        const page = offset === 0 ? thisEntries.slice(0, 500) : thisEntries.slice(500);
        return { success: true, results: page as T[], meta: { changes: 0, duration: 0 } };
      },
      async raw<T>() {
        return [] as T[];
      },
      async run() {
        return { success: true, meta: { changes: 0, duration: 0 } };
      },
    };
    return statement;
  }

  async batch<T = unknown>(): Promise<{ success: boolean; results?: T[] }[]> {
    return [];
  }

  async exec() {
    return { count: 0, duration: 0 };
  }
}

function receptionDatabase(): { db: AppDatabase; native: Database } {
  const native = new Database(":memory:");
  applyMigrations(native);
  const executions = new WeakMap<AppPreparedStatement, () => { success: boolean; results?: unknown[] }>();
  const db: AppDatabase = {
    prepare(query) {
      let values: SQLQueryBindings[] = [];
      const read = () => native.prepare(query).all(...values);
      const statement: AppPreparedStatement = {
        bind(...next) { values = next as SQLQueryBindings[]; return statement; },
        async first<T>(column?: string) {
          const row = read()[0] as Record<string, unknown> | undefined;
          return row ? (column ? row[column] : row) as T : null;
        },
        async all<T>() { return { success: true, results: read() as T[], meta: { changes: 0, duration: 0 } }; },
        async raw<T>() { return native.prepare(query).values(...values) as T[]; },
        async run() {
          const result = native.prepare(query).run(...values);
          return { success: true, meta: { changes: Number(result.changes), duration: 0 } };
        },
      };
      executions.set(statement, () => {
        if (/^(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(query.trim())) return { success: true, results: read() };
        native.prepare(query).run(...values);
        return { success: true };
      });
      return statement;
    },
    async batch<T>(statements: AppPreparedStatement[]) {
      return native.transaction(() => statements.map((statement) => {
        const execute = executions.get(statement);
        if (!execute) throw new Error("Statement belongs to a different database");
        return execute() as { success: boolean; results?: T[] };
      }))();
    },
    async exec(query) { native.exec(query); return { count: 1, duration: 0 }; },
  };
  return { db, native };
}

describe("reception rankings HTTP contract", () => {
  test("normalizes repeated facet IDs without dropping unknown IDs", () => {
    const parsed = parseReceptionRequest(new URL(
      "https://vaporstats.test/api/rankings?type=top_rated_now&version=2&genre=99999999&genre=3&genre=3&feature=8&tag=1&tag=99999998",
    ));
    expect(parsed).toEqual({
      type: "top_rated_now",
      view: "list",
      filters: { genres: [3, 99999999], features: [8], tags: [1, 99999998] },
      limit: 25,
      offset: 0,
    });
  });

  test("rejects malformed IDs, repeated singletons, and pagination on comparison", async () => {
    for (const url of [
      "https://vaporstats.test/api/rankings?type=top_rated_now&genre=1.5",
      "https://vaporstats.test/api/rankings?type=top_rated_now&type=top_rated_now",
      "https://vaporstats.test/api/rankings?type=top_rated_now&view=unknown",
      "https://vaporstats.test/api/rankings?type=top_rated_now&view=comparison&appid=1&limit=1",
      "https://vaporstats.test/api/rankings?type=top_rated_all_time&version=1",
      "https://vaporstats.test/api/rankings?type=top_rated_all_time&version=2&version=2",
    ]) {
      const response = await handleRankingsRequest(new Request(url), failingDb);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
      expect((await response.json()).status).toBe("error");
    }
  });

  test("reports a valid database failure as a non-cacheable error", async () => {
    const response = await handleRankingsRequest(
      new Request("https://vaporstats.test/api/rankings?type=top_rated_now"),
      failingDb,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
    expect(await response.json()).toEqual({ status: "error", message: "Live data unavailable" });
  });

  test("returns non-cacheable 503 for unpublished or incompatible data in both HTTP handlers", async () => {
    const { db, native } = receptionDatabase();
    try {
      const urls = [
        "https://vaporstats.test/api/rankings?type=top_rated_now",
        "https://vaporstats.test/api/rankings?type=top_rated_all_time&view=comparison&appid=1",
      ];
      for (const url of urls) {
        const response = await handleRankingsRequest(new Request(url), db);
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
      }
      const page = await handleRankingsHttpRequest(new Request("https://vaporstats.test/rankings"), db);
      expect(page.status).toBe(503);
      expect(page.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
      await publishReceptionProjection(db, { evaluatedAt: "2026-09-08T00:00:00.000Z" });
      const ready = await handleRankingsRequest(new Request(urls[0]!), db);
      expect(ready.status).toBe(200);
      expect((await ready.json()).data.items).toEqual([]);
      native.query("UPDATE reception_publication_builds SET projection_version = projection_version + 1").run();
      expect((await handleRankingsRequest(new Request(urls[0]!), db)).status).toBe(503);
      expect((await handleRankingsHttpRequest(new Request("https://vaporstats.test/rankings"), db)).status).toBe(503);
    } finally {
      native.close(true);
    }
  });

  test("serves published list and comparison evidence without changing the evaluation cutoff", async () => {
    const { db, native } = receptionDatabase();
    try {
      native.query("INSERT INTO apps (appid, name, slug) VALUES (1, 'Published Game', 'published-game')").run();
      native.query(`INSERT INTO review_sources
        (id, endpoint, request_filter, language, purchase_type, filter_offtopic_activity, population, interpretation_version, identity_key)
        VALUES ('summary', 'appreviews', 'filter=all', 'all', 'all', 1, 'summary:all:all:all:1', 'test', 'summary')`).run();
      native.query(`INSERT INTO review_summary_snapshots
        (appid, source_id, observed_at, lifetime_positive_count, lifetime_total_count)
        VALUES (1, 'summary', '2026-08-15T00:00:00.000Z', 300, 300),
               (1, 'summary', '2026-09-07T00:00:00.000Z', 400, 500)`).run();
      const evaluatedAt = "2026-09-08T00:00:00.000Z";
      await publishReceptionProjection(db, { evaluatedAt });
      const list = await handleRankingsRequest(new Request("https://vaporstats.test/api/rankings?type=top_rated_all_time&limit=1"), db);
      expect(list.status).toBe(200);
      const payload = await list.json();
      expect(payload).toMatchObject({
        status: "data", source_timestamp: "2026-09-07T00:00:00.000Z",
        data: { evaluated_at: evaluatedAt, eligible_total: 1, total: 1 },
      });
      expect(payload.data.items[0]).toMatchObject({
        rank: 1, game: { appid: 1 }, metric: { kind: "lifetime_confidence", lifetime_approval: 80 },
        eligibility: { qualifying_reviews: 500, population_ref: { source_id: "summary" } },
      });
      const comparison = await handleRankingsRequest(new Request("https://vaporstats.test/api/rankings?type=top_rated_all_time&view=comparison&appid=1"), db);
      expect(comparison.status).toBe(200);
      const history = await comparison.json();
      expect(history.data.evaluated_at).toBe(evaluatedAt);
      expect(history.data.points).toHaveLength(1);
      expect(history.data.points[0]).toMatchObject({
        cutoff: "2026-09-01T00:00:00.000Z", comparison_rank: 1, compared_count: 1,
        lifetime_reviews: 300, lifetime_approval: 100, provenance: "lifetime_summary",
      });
    } finally {
      native.close(true);
    }
  });
});

describe("score and facets HTTP contracts", () => {
  test("strictly validates score view/range and keeps errors uncached", async () => {
    for (const url of [
      "https://vaporstats.test/api/games/1091500/score?view=history&range=bad",
      "https://vaporstats.test/api/games/1091500/score?view=summary&view=history",
      "https://vaporstats.test/api/games/not-an-id/score",
      "https://vaporstats.test/api/games/1091500/score?version=1",
      "https://vaporstats.test/api/games/1091500/score?version=2&version=2",
    ]) {
      const response = await handleGameScoreRequest(new Request(url), failingDb);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
      expect((await response.json()).status).toBe("error");
    }
  });

  test("fetches every 500-row dictionary page and reports its source timestamp", async () => {
    const db = new FacetDb();
    const entries = await listAllNamedFacets(db);
    expect(entries).toHaveLength(501);
    const response = await handleFacetsRequest(new Request("https://vaporstats.test/api/facets"), db);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=300, stale-while-revalidate=60");
    expect(await response.json()).toMatchObject({
      status: "data",
      data: db.entries,
      source_timestamp: "2026-09-07T12:00:00.000Z",
    });
  });

  test("rejects facet query parameters", async () => {
    const response = await handleFacetsRequest(
      new Request("https://vaporstats.test/api/facets?group=genre"),
      failingDb,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
  });
});
