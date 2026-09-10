import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AppDatabase, AppPreparedStatement } from "../src/lib/db";
import { applyMigrations } from "../src/lib/migrations";
import {
  bbcodeToHtml,
  bbcodeToPlainText,
  extractReaderContent,
  getEventReader,
  sanitizeReaderHtml,
} from "../src/lib/event-reader";
import {
  handleEventReaderRequest,
  parseEventReaderPath,
} from "../src/routes/api.games.$appid.events.$eventid.reader";
import { parseSearch, stringifySearch } from "../src/router";
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

describe("Steam Store BBCode and Event Extraction", () => {
  test("converts BBCode elements to semantic HTML", () => {
    const bbcode = `
      [h2]Patch Highlights[/h2]
      [b]Bold note[/b] and [i]italic note[/i] and [u]underlined[/u] and [strike]deleted[/strike].
      [img]{STEAM_CLAN_IMAGE}/44971832/test.png[/img]
      [url=https://store.steampowered.com]Steam Store[/url]
      [list]
      [*]First bullet
      [*]Second bullet
      [/list]
      [previewyoutube=dQw4w9WgXcQ;full][/previewyoutube]
    `;
    const html = bbcodeToHtml(bbcode);
    expect(html).toContain('<h2 class="score-event-section-header">Patch Highlights</h2>');
    expect(html).toContain("<strong>Bold note</strong>");
    expect(html).toContain("<em>italic note</em>");
    expect(html).toContain("<u>underlined</u>");
    expect(html).toContain("<del>deleted</del>");
    expect(html).toContain('src="https://clan.fastly.steamstatic.com/images/44971832/test.png"');
    expect(html).toContain('href="https://store.steampowered.com"');
    expect(html).toContain("<ul><li>First bullet</li><li>Second bullet</li></ul>");
    expect(html).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    const plain = bbcodeToPlainText(bbcode);
    expect(plain).not.toContain("[h2]");
    expect(plain).not.toContain("[img]");
    expect(plain).toContain("Patch Highlights");
    expect(plain).toContain("Bold note");
  });

  test("converts Steam [img src] attributes and clan image placeholders", () => {
    const bbcode = '[p][img src="{STEAM_CLAN_LOC_IMAGE}/3703047/test.png"][/img]Congratulations[/p]';
    const html = bbcodeToHtml(bbcode);

    expect(html).toContain('src="https://clan.fastly.steamstatic.com/images/3703047/test.png"');
    expect(html).toContain("Congratulations");
    expect(html).not.toContain("[img src=");

    const plain = bbcodeToPlainText(bbcode);
    expect(plain).toBe("Congratulations");
  });

  test("keeps a section heading after a YouTube preview", () => {
    const html = bbcodeToHtml('[previewyoutube="gsSWz6sfu-U;full"][/previewyoutube][h1]Patch Notes – Valheim 1.0[/h1]');

    expect(html).toContain("score-event-youtube-embed");
    expect(html).toContain('<h1 class="score-event-section-header">Patch Notes – Valheim 1.0</h1>');
  });

  test("converts Steam BBCode with paragraphs, escaped brackets, and [/*] list items", () => {
    const csBbcode = `[p]\\[ MAPS ][/p][p]Boulder[/p][list][*][p]Updated to the latest version from the Community Workshop ([url="https://steamcommunity.com/sharedfiles/filedetails/changelog/3663186989"]Update Notes[/url])[/p][/*][/list][p]Poseidon[/p][list][*][p]Updated to the latest version from the Community Workshop ([url="https://steamcommunity.com/sharedfiles/filedetails/changelog/3522144043"]Update Notes[/url])[/p][/*][/list][p]\\[ GAMEPLAY ][/p][list][*][p]Fixed a case where player speed was too high when moving against walls.[/p][/*][/list]`;

    const html = bbcodeToHtml(csBbcode);
    expect(html).toContain('<h3 class="score-event-section-header">[ MAPS ]</h3>');
    expect(html).not.toContain("\\[");
    expect(html).not.toContain("\\]");
    expect(html).not.toContain("[p]");
    expect(html).not.toContain("[/p]");
    expect(html).not.toContain("[/*]");
    expect(html).not.toContain("[*]");
    expect(html).toContain('<a href="https://steamcommunity.com/sharedfiles/filedetails/changelog/3663186989">Update Notes</a>');
    expect(html).toContain("<li>Updated to the latest version");
    expect(html).toContain("[ GAMEPLAY ]");

    const plain = bbcodeToPlainText(csBbcode);
    expect(plain).toContain("[ MAPS ]");
    expect(plain).not.toContain("\\[");
    expect(plain).not.toContain("[p]");
    expect(plain).not.toContain("[/*]");
    expect(plain).toContain("Update Notes");
  });

  test("extracts Steam store event content from data-partnereventstore", () => {
    const storeHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Slay the Spire 2 - News</title></head>
        <body>
          <div id="application_config" data-partnereventstore="[{&quot;gid&quot;:&quot;671751488532383386&quot;,&quot;event_name&quot;:&quot;Beta Patch Notes - v0.111.0&quot;,&quot;announcement_body&quot;:{&quot;gid&quot;:&quot;671751488532383387&quot;,&quot;headline&quot;:&quot;Beta Patch Notes - v0.111.0&quot;,&quot;body&quot;:&quot;Time for another beta patch!\n\n[h2]CONTENT &amp; BALANCE:[/h2]\n[list]\n[*]Buffed Axebot\n[/list]&quot;}}]"></div>
          <footer>© Valve Corporation. All rights reserved.</footer>
        </body>
      </html>
    `;
    const result = extractReaderContent(storeHtml, "https://store.steampowered.com/news/app/2868840/view/671751488532383386");
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Beta Patch Notes - v0.111.0");
    expect(result?.contentHtml).toContain("Time for another beta patch!");
    expect(result?.contentHtml).toContain('<h2 class="score-event-section-header">CONTENT &amp; BALANCE:</h2>');
    expect(result?.contentHtml).toContain("<li>Buffed Axebot</li>");
    expect(result?.contentHtml).not.toContain("Valve Corporation. All rights reserved");
  });


  test("tags h1 headings as sticky section headers", () => {
    const bbcode = `
      [p]Intro text[/p]
      [h1][b]Vehicles[/b][/h1]
      [list][*]New vehicle added[/list]
      [h1]Photo Mode[/h1]
      [list][*]New camera setting[/list]
    `;
    const html = bbcodeToHtml(bbcode);
    expect(html).toContain('<h1 class="score-event-section-header"><strong>Vehicles</strong></h1>');
    expect(html).toContain('<h1 class="score-event-section-header">Photo Mode</h1>');
  });

  test("handles BBCode attributes and YouTube preview embeds", () => {
    const bbcode = `[p align="start"]To survive in Night City, you need someone to watch your back.[/p][previewyoutube="KO0a5vujTB0;full"][/previewyoutube][p align="start"]Check out: http://cdpred.ly/AAY[/p]`;

    const html = bbcodeToHtml(bbcode);
    expect(html).not.toContain('[p align="start"]');
    expect(html).toContain("<p>To survive in Night City");
    expect(html).toContain("https://www.youtube-nocookie.com/embed/KO0a5vujTB0");
    expect(html).toContain("<iframe");
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/KO0a5vujTB0"');
    expect(html).toContain('href="http://cdpred.ly/AAY"');

    const sanitized = sanitizeReaderHtml(html, "https://store.steampowered.com");
    expect(sanitized).toContain('src="https://www.youtube-nocookie.com/embed/KO0a5vujTB0"');
    expect(sanitized).toContain("Watch on YouTube");
  });

  test("milestone label precedence and safe iframe filtering", () => {
    const maliciousIframe = '<iframe src="https://evil.com/malicious"></iframe>';
    const sanitizedMalicious = sanitizeReaderHtml(maliciousIframe);
    expect(sanitizedMalicious).not.toContain("iframe");
    expect(sanitizedMalicious).not.toContain("evil.com");

    const youtubeIframe = '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="Video"></iframe>';
    const sanitizedYoutube = sanitizeReaderHtml(youtubeIframe);
    expect(sanitizedYoutube).toContain("iframe");
    expect(sanitizedYoutube).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });
  test("rejects pages where Readability only extracted Valve legal footer", () => {
    const footerOnlyHtml = `
      <!DOCTYPE html>
      <html>
        <head><title>Steam Community</title></head>
        <body>
          <div id="root"></div>
          <p>© Valve Corporation. All rights reserved. All trademarks are property of their respective owners.</p>
        </body>
      </html>
    `;
    const result = extractReaderContent(footerOnlyHtml, "https://store.steampowered.com/news/app/730/view/999");
    expect(result).toBeNull();
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

  test("parseEventReaderPath strips surrounding quotes from eventId", () => {
    const parsed = parseEventReaderPath("/api/games/1091500/events/%223873721309648486251%22/reader");
    expect(parsed).not.toBeNull();
    expect(parsed?.appid).toBe(1091500);
    expect(parsed?.eventId).toBe("3873721309648486251");
  });

  test("router search serialization avoids quotes and preserves 64-bit integer precision", () => {
    const stringified = stringifySearch({ range: 5, event: "3873721309648486251" });
    expect(stringified).toBe("?range=5&event=3873721309648486251");
    expect(stringified).not.toContain("%22");
    expect(stringified).not.toContain('"');

    const parsed = parseSearch("?range=5&event=3873721309648486251");
    expect(parsed.range).toBe(5);
    expect(parsed.event).toBe("3873721309648486251");
    expect(typeof parsed.event).toBe("string");

    const parsedFromQuoted = parseSearch('?range=5&event=%223873721309648486251%22');
    expect(parsedFromQuoted.event).toBe("3873721309648486251");
  });

  test("derives canonical store URL for numeric eventId when DB url is null", async () => {
    const { db, native } = freshDb();
    native.query(`
      INSERT INTO steam_events (event_id, appid, category, title, url, start_at, publication_at, observed_at, source, provenance)
      VALUES ('3873721309648486251', 1091500, 'major_update', 'Update 2.1', NULL, '2023-12-05T11:10:40Z', NULL, '2023-12-05T11:10:40Z', 'steam', '{}');
    `).run();

    let requestedUrl = "";
    const customFetch = (async (url: string | URL | Request) => {
      requestedUrl = typeof url === "string" ? url : url.toString();
      return new Response(`
        <html>
          <body>
            <div id="application_config" data-partnereventstore="[{&quot;gid&quot;:&quot;3873721309648486251&quot;,&quot;event_name&quot;:&quot;Update 2.1&quot;,&quot;announcement_body&quot;:{&quot;headline&quot;:&quot;Update 2.1&quot;,&quot;body&quot;:&quot;Update 2.1 is now available!&quot;}}]"></div>
          </body>
        </html>
      `, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await getEventReader(db, 1091500, "3873721309648486251", { customFetch });
    expect(requestedUrl).toBe("https://store.steampowered.com/news/app/1091500/view/3873721309648486251");
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.title).toBe("Update 2.1");
      expect(result.contentHtml).toContain("Update 2.1 is now available!");
    }
    native.close(true);
  });
});
