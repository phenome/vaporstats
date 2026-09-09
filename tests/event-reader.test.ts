import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import {
  extractReaderContent,
  getEventReader,
  sanitizeReaderHtml,
} from "../src/lib/event-reader";
import { handleEventReaderRequest } from "../src/routes/api.games.$appid.events.$eventid.reader";

function appDatabase(native: Database): AppDatabase {
  return {
    prepare(query: string): AppPreparedStatement {
      let values: unknown[] = [];
      const statement: AppPreparedStatement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T = unknown>() {
          const row = native.prepare(query).get(...(values as SQLQueryBindings[]));
          return (row as T | null) ?? null;
        },
        async run() {
          const result = native.prepare(query).run(...(values as SQLQueryBindings[]));
          return { success: true, meta: { changes: Number(result.changes), duration: 0 } };
        },
        async all<T = unknown>() {
          return { success: true, results: native.prepare(query).all(...(values as SQLQueryBindings[])) as T[], meta: { changes: 0, duration: 0 } };
        },
        async raw<T = unknown>() {
          return native.prepare(query).values(...(values as SQLQueryBindings[])) as T[];
        },
      };
      return statement;
    },
    async batch<T = unknown>(statements: AppPreparedStatement[]) {
      const results: { success: boolean; results?: T[] }[] = [];
      for (const statement of statements) {
        await statement.run();
        results.push({ success: true });
      }
      return results;
    },
    async exec(query: string) {
      native.exec(query);
      return { count: 0, duration: 0 };
    },
  };
}

function freshDb(): { db: AppDatabase; native: Database } {
  const native = new Database(":memory:");
  applyMigrations(native);
  native.query("INSERT INTO apps (appid, name, slug) VALUES (730, 'Counter-Strike 2', 'counter-strike-2')").run();
  return { db: appDatabase(native), native };
}

describe("Event Reader Sanitization", () => {
  test("strips scripts, iframes, styles, and on* event handlers", () => {
    const dirty = `
      <script>alert('xss')</script>
      <iframe src="https://evil.com"></iframe>
      <p style="color: red; position: fixed" onclick="malicious()">Safe text</p>
      <a href="javascript:alert(1)">Bad link</a>
      <a href="/patch-notes">Good link</a>
      <img src="javascript:alert(2)" />
      <img src="/banner.png" />
    `;
    const clean = sanitizeReaderHtml(dirty, "https://store.steampowered.com/news/app/730/");
    expect(clean).not.toContain("<script>");
    expect(clean).not.toContain("<iframe");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("style=");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain("Safe text");
    expect(clean).toContain('href="https://store.steampowered.com/patch-notes"');
    expect(clean).toContain('src="https://store.steampowered.com/banner.png"');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer"');
  });
});

describe("Event Reader Extraction", () => {
  test("extracts readable article content from HTML document", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Counter-Strike 2: Release Notes</title></head>
        <body>
          <header><nav>Nav links</nav></header>
          <article>
            <h1>Counter-Strike 2 - Release Notes for 9/8/2026</h1>
            <p class="byline">By Valve</p>
            <p>Today we are shipping a major update with new competitive map adjustments, sound occlusion improvements, and weapon balancing.</p>
            <p>Full changelog details can be viewed below along with developer commentary.</p>
            <ul>
              <li>Fixed sound occlusion on de_dust2</li>
              <li>Adjusted grenade trajectory visual fidelity</li>
            </ul>
          </article>
          <footer>Footer text</footer>
        </body>
      </html>
    `;
    const result = extractReaderContent(html, "https://store.steampowered.com/news/app/730/view/123");
    expect(result).not.toBeNull();
    expect(result?.title).toContain("Counter-Strike 2");
    expect(result?.contentHtml).toContain("major update with new competitive map adjustments");
    expect(result?.contentHtml).toContain("Fixed sound occlusion");
    expect(result?.textContent).toContain("sound occlusion improvements");
  });

  test("returns null for empty or unparseable HTML", () => {
    expect(extractReaderContent("")).toBeNull();
    expect(extractReaderContent("<div>No readable article here</div>")).toBeNull();
  });
});

describe("Event Reader Data Access and API", () => {
  test("returns not_found when event is absent from database", async () => {
    const { db, native } = freshDb();
    const result = await getEventReader(db, 730, "missing-event");
    expect(result.status).toBe("not_found");
    native.close(true);
  });

  test("returns fallback when event has no URL", async () => {
    const { db, native } = freshDb();
    native.query(`
      INSERT INTO steam_events (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('no-url-event', 730, 'major_update', 'Major Update Notice', NULL, '2026-09-08T00:00:00Z', NULL, '2026-09-08T00:00:00Z', 'steam', '{}');
    `).run();

    const result = await getEventReader(db, 730, "no-url-event");
    expect(result.status).toBe("fallback");
    if (result.status === "fallback") {
      expect(result.fallbackReason).toBe("no_url");
      expect(result.title).toBe("Major Update Notice");
      expect(result.contentHtml).toBeNull();
    }
    native.close(true);
  });

  test("returns fallback when upstream fetch fails", async () => {
    const { db, native } = freshDb();
    native.query(`
      INSERT INTO steam_events (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('failed-fetch-event', 730, 'patch_notes', 'Patch Notes', 'https://example.com/fail', '2026-09-08T00:00:00Z', NULL, '2026-09-08T00:00:00Z', 'steam', '{}');
    `).run();

    const customFetch = (async () => new Response("Internal Server Error", { status: 500 })) as unknown as typeof fetch;
    const result = await getEventReader(db, 730, "failed-fetch-event", { customFetch });
    expect(result.status).toBe("fallback");
    if (result.status === "fallback") {
      expect(result.fallbackReason).toBe("fetch_failed");
      expect(result.sourceUrl).toBe("https://example.com/fail");
    }
    native.close(true);
  });

  test("returns success with extracted content when fetch succeeds", async () => {
    const { db, native } = freshDb();
    native.query(`
      INSERT INTO steam_events (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('success-event', 730, 'major_update', 'DB Title', 'https://example.com/update', '2026-09-08T00:00:00Z', NULL, '2026-09-08T00:00:00Z', 'steam', '{}');
    `).run();

    const articleHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Spring Major Update</title></head>
        <body>
          <article>
            <h1>Spring Major Update</h1>
            <p>Welcome to the comprehensive overhaul of our game engine and matchmaker systems with performance gains.</p>
            <p>This update includes deep adjustments to network tickrate compensation and sound physics.</p>
          </article>
        </body>
      </html>
    `;
    const customFetch = (async () => new Response(articleHtml, { status: 200 })) as unknown as typeof fetch;
    const result = await getEventReader(db, 730, "success-event", { customFetch });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.title).toContain("Spring Major Update");
      expect(result.contentHtml).toContain("comprehensive overhaul of our game engine");
      expect(result.category).toBe("major_update");
    }
    native.close(true);
  });

  test("handleEventReaderRequest returns 200 with cache headers and data", async () => {
    const { db, native } = freshDb();
    native.query(`
      INSERT INTO steam_events (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('api-test-event', 730, 'major_update', 'API Update', 'https://example.com/api-update', '2026-09-08T00:00:00Z', NULL, '2026-09-08T00:00:00Z', 'steam', '{}');
    `).run();

    const customFetch = (async () => new Response(`
      <html><body><article><h1>API Update</h1><p>Comprehensive article text with detailed patch descriptions and bug fixes.</p></article></body></html>
    `, { status: 200 })) as unknown as typeof fetch;

    const request = new Request("https://vaporstats.com/api/games/730/events/api-test-event/reader");
    const response = await handleEventReaderRequest(request, db, 730, "api-test-event", { customFetch });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=3600");
    const body = (await response.json()) as {
      status: string;
      data: { contentHtml: string };
    };
    expect(body.status).toBe("data");
    expect(body.data.contentHtml).toContain("Comprehensive article text");
    native.close(true);
  });
});
