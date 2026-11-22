import { afterEach, describe, expect, test } from "bun:test";
import { fetchOutletArticle } from "../src/lib/media-outlet-access";
import { openTestDatabase, type TestDatabase } from "./support/db";
import { CYBERPUNK, insertCompletedRun, seedApps, throwingResponse } from "./support/media";

const START = "https://ign.com/reviews/start";
const DAY = new Date("2026-09-10T12:00:00Z");
const TOMORROW = new Date("2026-09-11T00:00:00Z");
let database: TestDatabase | undefined;

afterEach(() => database?.cleanup());

function fixture(respond: (url: string) => Response | string) {
  const db = openTestDatabase("outlet-contract-");
  database = db;
  seedApps(db.native, [CYBERPUNK]);
  const runId = insertCompletedRun(db.native, "outlet-contract", [CYBERPUNK]);
  const calls: string[] = [];
  return {
    calls,
    fetch: (url = START, day = DAY) => fetchOutletArticle(db.db, {
      url, runId, outlet: "IGN", appid: CYBERPUNK, pass: "initial", clock: () => day,
      fetch: async (address, init) => {
        expect(init?.redirect).toBe("manual");
        calls.push(address);
        expect(db.native.query("SELECT COUNT(*) AS count FROM media_discovery_attempts").get()).toEqual({ count: calls.length });
        return respond(address);
      },
    }),
    attempts: () => db.native.query("SELECT kind, status_code, succeeded, error FROM media_discovery_attempts ORDER BY id").all(),
  };
}

describe("Outlet article response scopes", () => {
  const stops = [
    { scope: "Outlet denial", status: 401, reopens: false },
    { scope: "Outlet denial", status: 403, reopens: false },
    { scope: "Outlet day stop", status: 429, reopens: true },
  ];

  for (const { scope, status, reopens } of stops) {
    test(`${status} is an ${scope}`, async () => {
      const outlet = fixture(() => new Response("", { status }));
      const stop = `fetch_http_${status}`;
      expect(await outlet.fetch()).toEqual({ stop, contacted: true });
      expect(await outlet.fetch()).toEqual({ stop, contacted: false });
      expect(await outlet.fetch(START, TOMORROW)).toEqual({ stop, contacted: reopens });
      expect(outlet.calls).toHaveLength(reopens ? 2 : 1);
    });
  }

  test("follows relative redirects within the Outlet and records each hop", async () => {
    const outlet = fixture((url) => url === START
      ? new Response(null, { status: 302, headers: { location: "end" } })
      : new Response("article"));
    expect(await outlet.fetch()).toEqual({ html: "article", finalUrl: "https://ign.com/reviews/end" });
    expect(outlet.attempts()).toEqual([
      { kind: "redirect", status_code: 302, succeeded: 0, error: "HTTP 302" },
      { kind: "fetch", status_code: 200, succeeded: 1, error: null },
    ]);
  });

  test("rejects off-Outlet starting URLs and redirects before contacting them", async () => {
    const offOutlet = "https://ign.com.example.org/article";
    const outlet = fixture(() => Response.redirect(offOutlet));
    expect(await outlet.fetch(offOutlet)).toBeNull();
    expect(await outlet.fetch()).toBeNull();
    expect(outlet.calls).toEqual([START]);
  });

  test("follows at most five redirects", async () => {
    const outlet = fixture((url) => new Response(null, { status: 302, headers: { location: `${url}/next` } }));
    expect(await outlet.fetch()).toBeNull();
    expect(outlet.calls).toHaveLength(6);
    expect(outlet.attempts()).toHaveLength(6);
  });

  for (const [part, kind, status, response] of [
    ["status", "failure", null, () => throwingResponse("response failed")],
    ["body", "fetch", 200, () => Object.assign(new Response("article"), { text: async () => { throw new Error("response failed"); } })],
    ["redirect headers", "redirect", 302, () => Object.defineProperty(new Response(null, { status: 302 }), "headers", { get() { throw new Error("response failed"); } })],
  ] as const) {
    test(`records a throwing response's ${part} before propagating the error`, async () => {
      const outlet = fixture(response);
      await expect(outlet.fetch()).rejects.toThrow("response failed");
      expect(outlet.attempts()).toEqual([{ kind, status_code: status, succeeded: 0, error: "response failed" }]);
    });
  }
});
