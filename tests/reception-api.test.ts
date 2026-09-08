import { describe, expect, test } from "bun:test";
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

describe("reception rankings HTTP contract", () => {
  test("normalizes repeated facet IDs without dropping unknown IDs", () => {
    const parsed = parseReceptionRequest(new URL(
      "https://vaporstats.test/api/rankings?type=top_rated_now&genre=99999999&genre=3&genre=3&feature=8&tag=1&tag=99999998",
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
});

describe("score and facets HTTP contracts", () => {
  test("strictly validates score view/range and keeps errors uncached", async () => {
    for (const url of [
      "https://vaporstats.test/api/games/1091500/score?view=history&range=bad",
      "https://vaporstats.test/api/games/1091500/score?view=summary&view=history",
      "https://vaporstats.test/api/games/not-an-id/score",
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
