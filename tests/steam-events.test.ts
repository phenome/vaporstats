import { describe, expect, it } from "bun:test";
import {
  discoverSteamNewsHubEvents,
  fetchSteamNewsHubBatchEvents,
  fetchSteamNewsHubEvents,
} from "../workers/steam-events";

const observedAt = "2026-09-07T12:00:00.000Z";
const epoch = (value: string) => Math.floor(Date.parse(value) / 1000);

function htmlResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  const encoded = JSON.stringify(payload).replaceAll('"', "&quot;");
  return new Response(`<div data-initialevents="${encoded}"></div>`, { status, headers });
}

function event(gid: string, announcementGid: string, eventType: number | string, appid = 730): Record<string, unknown> {
  return {
    gid,
    appid,
    event_name: `Event ${gid}`,
    event_type: eventType,
    rtime32_start_time: epoch("2026-08-24T23:41:00.000Z"),
    rtime32_end_time: epoch("2026-08-25T23:41:00.000Z"),
    rtime32_visibility_start: epoch("2026-08-24T23:39:20.000Z"),
    announcement_body: {
      gid: announcementGid,
      posttime: epoch("2026-08-24T23:39:20.000Z"),
      updatetime: epoch("2026-08-24T23:41:11.000Z"),
    },
  };
}

describe("Steam News Hub event source", () => {
  it("parses structured categories while preserving event and announcement identities and dates", async () => {
    const customFetch = (async () => htmlResponse({ events: [
      event("event-14", "body-14", 14),
      event("event-13", "body-13", 13),
      event("event-12", "body-12", 12),
      event("event-unknown", "body-unknown", 88),
    ] }, 200, { date: "Wed, 01 Jan 2099 00:00:00 GMT" })) as unknown as typeof fetch;
    const result = await fetchSteamNewsHubEvents(730, { customFetch, observedAt });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events.map((item) => item.category)).toEqual([
      "major_update",
      "regular_update",
      "patch_notes",
      "unknown",
    ]);
    expect(result.value.events[0]?.eventId).toBe("event-14");
    expect(result.value.events[0]?.announcementId).toBe("body-14");
    expect(result.value.events[0]?.eventId).not.toBe(result.value.events[0]?.announcementId);
    expect(result.value.events[0]?.rawCategory).toBe(14);
    expect(result.value.events[3]?.rawCategory).toBe(88);
    expect(result.value.events[0]?.startAt).toBe("2026-08-24T23:41:00.000Z");
    expect(result.value.events[0]?.publicationAt).toBe("2026-08-24T23:39:20.000Z");
    expect(result.value.events[0]?.provenance).toBe("steam.news_hub.initialevents");
    expect(result.value.observedAt).toBe(observedAt);
  });

  it("normalizes identity-only unknown category models", async () => {
    const result = await fetchSteamNewsHubEvents(730, {
      customFetch: (async () => htmlResponse({ events: [{ gid: "event-no-category", appid: 730 }] })) as unknown as typeof fetch,
      observedAt,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]?.eventId).toBe("event-no-category");
    expect(result.value.events[0]?.announcementId).toBeNull();
    expect(result.value.events[0]?.category).toBe("unknown");
    expect(result.value.events[0]?.rawCategory).toBeNull();
  });

  it("enforces the event and response-size bounds without pagination", async () => {
    let calls = 0;
    const payload = { events: [event("one", "body-one", 14), event("two", "body-two", 12), event("three", "body-three", 13)] };
    const result = await fetchSteamNewsHubEvents(730, {
      customFetch: (async () => {
        calls += 1;
        return htmlResponse(payload);
      }) as unknown as typeof fetch,
      maxEvents: 2,
      observedAt,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(1);
    expect(result.value.events).toHaveLength(2);
    expect(result.value.truncated).toBe(true);

    const oversized = await fetchSteamNewsHubEvents(730, {
      customFetch: (async () => htmlResponse(payload)) as unknown as typeof fetch,
      maxBodyBytes: 10,
      observedAt,
    });
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.outcome).toBe("failure");
  });

  it("returns rate-limit outcomes and rejects missing structured payloads", async () => {
    const rateLimited = await fetchSteamNewsHubEvents(730, {
      customFetch: (async () => new Response("", { status: 429 })) as unknown as typeof fetch,
      observedAt,
    });
    expect(rateLimited.ok).toBe(false);
    if (rateLimited.ok) return;
    expect(rateLimited.outcome).toBe("rate_limited");
    expect(rateLimited.rateLimited).toBe(true);
    expect(rateLimited.status).toBe(429);

    const missing = await fetchSteamNewsHubEvents(730, {
      customFetch: (async () => new Response("<html></html>")) as unknown as typeof fetch,
      observedAt,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.outcome).toBe("failure");
  });

  it("bounds batched announcement resolution and keeps resolution independent", async () => {
    let requested = "";
    const ids = ["100", "101", "102"];
    const result = await fetchSteamNewsHubBatchEvents(ids, 730, {
      maxBatchIds: 2,
      observedAt,
      customFetch: (async (input: RequestInfo | URL) => {
        requested = String(input);
        return response({ success: 1, events: [event("canonical-event", "100", 14)] });
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(requested).searchParams.get("announcement_gids")).toBe("100,101");
    expect(result.value.truncated).toBe(true);
    expect(result.value.events[0]?.eventId).toBe("canonical-event");
    expect(result.value.events[0]?.announcementId).toBe("100");

    const independent = await discoverSteamNewsHubEvents(730, {
      resolveAnnouncements: true,
      observedAt,
      customFetch: (async (input: RequestInfo | URL) => String(input).includes("ajaxget")
        ? new Response("", { status: 429 })
        : htmlResponse({ events: [event("page-event", "200", 13)] })) as unknown as typeof fetch,
    });
    expect(independent.discovery.ok).toBe(true);
    expect(independent.resolution?.ok).toBe(false);
    expect(independent.resolution?.outcome).toBe("rate_limited");
  });

  it("fails before fetching when observedAt is invalid", async () => {
    let calls = 0;
    const result = await fetchSteamNewsHubEvents(730, {
      observedAt: "not-a-date",
      customFetch: (async () => {
        calls += 1;
        return htmlResponse({ events: [{ gid: "event-no-category", appid: 730 }] });
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("Invalid observedAt");
    expect(result.observedAt).toBeNull();
    expect(calls).toBe(0);
  });

  it("does not derive a missing event identity from an announcement GID", async () => {
    const result = await fetchSteamNewsHubEvents(730, {
      customFetch: (async () => htmlResponse({ events: [
        { ...event("", "body-only", 14), gid: undefined },
        { ...event("", "", 14), gid: undefined, announcement_body: { gid: undefined } },
      ] })) as unknown as typeof fetch,
      observedAt,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]?.eventId).toBeNull();
    expect(result.value.events[0]?.announcementId).toBe("body-only");
  });
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
