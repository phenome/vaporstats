import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../src/lib/migrations";
import { type AppDatabase, type AppPreparedStatement } from "../src/lib/db";
import { getCriticRecords, persistCriticRecord } from "../src/lib/critic-store";
import { runCriticCollection } from "../workers/critic-collector";

function createDb(): { db: AppDatabase; close: () => void } {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  const db: AppDatabase = {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T = unknown>(column?: string) {
          const row = sqlite.prepare(query).get(...(values as SQLQueryBindings[])) as Record<string, unknown> | null;
          return (column ? row?.[column] : row) as T | null;
        },
        async run() {
          sqlite.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: 1, duration: 0 } };
        },
        async all<T = unknown>() {
          return { success: true, results: sqlite.prepare(query).all(...(values as SQLQueryBindings[])) as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T = unknown>() {
          return sqlite.prepare(query).values(...(values as SQLQueryBindings[])) as T[];
        },
      };
      return statement;
    },
    async batch() { return []; },
    async exec(query: string) { sqlite.exec(query); return { count: 0, duration: 0 }; },
  };
  return { db, close: () => sqlite.close() };
}

const openCriticPage = `<!doctype html><title>Cyberpunk 2077 - OpenCritic</title>
<link rel="canonical" href="https://opencritic.com/game/8525/cyberpunk-2077">
<script type="application/json">{"game":{"id":8525,"name":"Cyberpunk 2077","slug":"cyberpunk-2077","steamId":1091500,"topCriticScore":76,"tier":"Strong","numReviews":230,"percentRecommended":66,"platforms":[{"name":"PC"}]}}</script>`;
const metacriticPage = `<!doctype html><title>Cyberpunk 2077 for PC Reviews - Metacritic</title>
<h1>Cyberpunk 2077</h1><script type="application/ld+json">{"@type":"VideoGame","name":"Cyberpunk 2077","aggregateRating":{"ratingValue":86,"ratingCount":106}}</script>
<div>Metascore 86</div><div>Showing 106 Critic Reviews</div>`;

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

async function insertApp(db: AppDatabase, metacriticUrl: string | null = null): Promise<void> {
  await db.prepare(
    `INSERT INTO apps (appid, name, slug, metacritic_url) VALUES (?, ?, ?, ?)`,
  ).bind(1091500, "Cyberpunk 2077", "cyberpunk-2077", metacriticUrl).run();
}

function fetchFor(routes: Record<string, Response | (() => Response)>): { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetch(input) {
      const url = String(input);
      urls.push(url);
      const route = routes[url];
      return typeof route === "function" ? route() : route ?? response("missing", 404);
    },
  };
}

describe("critic collector", () => {
  let db: AppDatabase;
  let close: () => void;

  beforeEach(() => {
    ({ db, close } = createDb());
  });
  afterEach(() => close());

  test("collects both public providers within the complete request budget", async () => {
    await insertApp(db, "https://www.metacritic.com/game/cyberpunk-2077/critic-reviews/?platform=pc");
    const sitemapIndex = `<sitemapindex>${[1, 2, 3, 4, 5].map((n) => `<loc>https://opencritic.com/sitemap_games_${n}.xml</loc>`).join("")}</sitemapindex>`;
    const routes: Record<string, Response> = {
      "https://opencritic.com/sitemap.xml": response(sitemapIndex),
      ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => ["https://opencritic.com/sitemap_games_" + n + ".xml", response(n === 1 ? "<urlset><loc>https://opencritic.com/game/8525/cyberpunk-2077</loc></urlset>" : "<urlset/>")])),
      "https://opencritic.com/game/8525/cyberpunk-2077": response(openCriticPage),
      "https://www.metacritic.com/game/cyberpunk-2077/critic-reviews/?platform=pc": response(metacriticPage),
    };
    const fake = fetchFor(routes);
    const result = await runCriticCollection(db, { now: "2026-09-07T00:00:00Z", maxRequests: 8, maxGames: 1, fetch: fake.fetch });
    expect(result.requests).toBe(8);
    expect(result.successes).toBe(2);
    expect((await getCriticRecords(db, 1091500)).map((record) => record.source)).toEqual(["metacritic", "opencritic"]);
    expect(fake.urls).not.toContain("https://api.opencritic.com/");
  });

  test("preserves a last-good record when a later page is unavailable", async () => {
    await insertApp(db);
    await persistCriticRecord(db, {
      source: "opencritic", sourceUrl: "https://opencritic.com/game/8525/cyberpunk-2077", sourceId: "8525",
      steamAppId: 1091500, title: "Cyberpunk 2077", slug: "cyberpunk-2077", edition: "", platforms: ["PC"],
      platformScope: "mixed", score: 76, tier: "Strong", reviewCount: 230, percentRecommended: 66,
      reviewPeriodStart: null, reviewPeriodEnd: null, observedAt: "2026-08-01T00:00:00Z", collectionBasis: "public_page",
      matchedIdentity: null, identityVerified: false, cadence: "monthly",
    });
    const fake = fetchFor({ "https://opencritic.com/sitemap.xml": response("<sitemapindex/>") });
    await runCriticCollection(db, { now: "2026-09-07T00:00:00Z", maxRequests: 1, maxGames: 1, fetch: fake.fetch });
    const records = await getCriticRecords(db, 1091500);
    expect(records[0]?.score).toBe(76);
    expect(records[0]?.observedAt).toBe("2026-08-01T00:00:00Z");
  });

  test("stops immediately on a sitemap 429 and never exceeds the request cap", async () => {
    await insertApp(db);
    const fake = fetchFor({ "https://opencritic.com/sitemap.xml": response("rate limited", 429) });
    const result = await runCriticCollection(db, { maxRequests: 8, maxGames: 2, fetch: fake.fetch });
    expect(result.rateLimited).toBe(true);
    expect(result.requests).toBe(1);
    expect(fake.urls).toHaveLength(1);
  });

  test("records a negative due checkpoint for a missing Metacritic URL", async () => {
    await insertApp(db);
    const fake = fetchFor({ "https://opencritic.com/sitemap.xml": response("<sitemapindex/>") });
    const result = await runCriticCollection(db, { maxRequests: 2, maxGames: 1, fetch: fake.fetch });
    expect(result.negativeLookups).toBeGreaterThan(0);
    const checkpoint = await db.prepare(`SELECT value FROM checkpoints WHERE key = ?`).bind("critic:collection:metacritic:1091500").first<{ value: string }>();
    expect(JSON.parse(checkpoint?.value ?? "{}").lastStatus).toBe("missing");
  });

  test("does not prove an ambiguous normalized OpenCritic title", async () => {
    await insertApp(db);
    const sitemapIndex = `<sitemapindex><loc>https://opencritic.com/sitemap_games_1.xml</loc></sitemapindex>`;
    const fake = fetchFor({
      "https://opencritic.com/sitemap.xml": response(sitemapIndex),
      "https://opencritic.com/sitemap_games_1.xml": response(`<urlset><loc>https://opencritic.com/game/1/cyberpunk-2077</loc><loc>https://opencritic.com/game/2/cyberpunk-2077</loc></urlset>`),
    });
    const result = await runCriticCollection(db, { maxRequests: 2, maxGames: 1, fetch: fake.fetch });
    expect(result.negativeLookups).toBeGreaterThan(0);
    expect(fake.urls.some((url) => url.includes("/game/"))).toBe(false);
  });

  test("selects a lower-priority due app when the tracked leaders are fresh", async () => {
    await insertApp(db);
    await db.prepare(
      "INSERT INTO apps (appid, name, slug) VALUES (?, ?, ?)",
    ).bind(1091501, "Later Game", "later-game").run();
    await db.prepare(
      "INSERT INTO tracked_games (appid, tier, slot, next_due_at, latest_players) VALUES (?, ?, ?, ?, ?)",
    ).bind(1091500, "daily", 0, "2026-09-07T00:00:00Z", 100).run();
    const fresh = JSON.stringify({ nextDueAt: "2099-01-01T00:00:00.000Z", lastStatus: "success" });
    await db.prepare("INSERT INTO checkpoints (key, value) VALUES (?, ?), (?, ?)").bind(
      "critic:collection:opencritic:1091500", fresh,
      "critic:collection:metacritic:1091500", fresh,
    ).run();
    const fake = fetchFor({
      "https://opencritic.com/sitemap.xml": response("<sitemapindex><loc>https://opencritic.com/sitemap_games_1.xml</loc></sitemapindex>"),
      "https://opencritic.com/sitemap_games_1.xml": response("<urlset/>")
    });
    await runCriticCollection(db, { now: "2026-09-07T00:00:00Z", maxRequests: 2, maxGames: 1, fetch: fake.fetch });
    const checkpoint = await db.prepare("SELECT value FROM checkpoints WHERE key = ?").bind("critic:collection:opencritic:1091501").first<{ value: string }>();
    expect(JSON.parse(checkpoint?.value ?? "{}").lastStatus).toBe("missing");
  });
});
