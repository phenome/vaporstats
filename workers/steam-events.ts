const NEWS_HUB_ENDPOINT = "https://store.steampowered.com/news/app/";
const BATCH_EVENT_ENDPOINT = "https://store.steampowered.com/events/ajaxgetbatchedpartnerevent/";

export const STEAM_EVENTS_INTERPRETATION_VERSION = "steam-news-hub-v1";
export const DEFAULT_NEWS_HUB_MAX_EVENTS = 50;
export const DEFAULT_NEWS_HUB_MAX_BODY_BYTES = 1_500_000;
export const DEFAULT_NEWS_HUB_MAX_BATCH_IDS = 50;

export type EventJsonPrimitive = string | number | boolean | null;
export type EventJsonValue = EventJsonPrimitive | EventJsonValue[] | { [key: string]: EventJsonValue };
export type EventJsonRecord = { [key: string]: EventJsonValue };

export type SteamEventCategory = "major_update" | "regular_update" | "patch_notes" | "unknown";

export interface NewsHubOptions {
  customFetch?: typeof fetch;
  observedAt?: Date | string;
  maxEvents?: number;
  maxBodyBytes?: number;
  maxBatchIds?: number;
  language?: string;
  signal?: AbortSignal;
}

export interface SteamEventRecord {
  eventId: string | null;
  announcementId: string | null;
  appid: number;
  category: SteamEventCategory;
  rawCategory: EventJsonValue;
  title: string | null;
  url: string | null;
  startAt: string | null;
  publicationAt: string | null;
  endAt: string | null;
  visibilityStartAt: string | null;
  visibilityEndAt: string | null;
  lastModifiedAt: string | null;
  buildId: string | number | null;
  observedAt: string;
  source: "steam.news_hub";
  provenance: string;
}

export interface SteamEventsSuccess {
  ok: true;
  outcome: "success";
  value: {
    appid: number;
    events: SteamEventRecord[];
    observedAt: string;
    truncated: boolean;
    source: "steam.news_hub";
    interpretationVersion: string;
  };
}
export interface SteamEventsFailure {
  ok: false;
  outcome: "failure" | "rate_limited";
  rateLimited: boolean;
  status: number | null;
  message: string;
  observedAt: string | null;
  endpoint: string;
}

export type SteamEventsResult = SteamEventsSuccess | SteamEventsFailure;

export interface SteamEventsDiscovery {
  discovery: SteamEventsResult;
  resolution?: SteamEventsResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): EventJsonValue {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value ?? null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return String(value);
}

function validAppId(appid: number): boolean {
  return Number.isSafeInteger(appid) && appid > 0;
}

function appId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function stableId(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function epochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function isoFromEpoch(value: unknown): string | null {
  const seconds = epochSeconds(value);
  if (seconds === null || seconds > 8_640_000_000) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isoFromDate(value: Date | string | undefined): string | null {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}


function optionsFor(value: NewsHubOptions | typeof fetch | undefined): NewsHubOptions {
  return typeof value === "function" ? { customFetch: value } : value ?? {};
}

function failure(
  endpoint: string,
  message: string,
  status: number | null,
  rateLimited: boolean,
  observedAt: string | null
): SteamEventsFailure {
  return {
    ok: false,
    outcome: rateLimited ? "rate_limited" : "failure",
    rateLimited,
    status,
    message,
    observedAt,
    endpoint,
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function balancedJson(value: string, start: number): string | null {
  const opener = value[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (!closer) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === opener) depth += 1;
    else if (character === closer) {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function initialEventsJson(html: string): string | null {
  const marker = /data-initialevents\s*=\s*(["'])([\s\S]*?)\1/i.exec(html);
  if (marker) return decodeEntities(marker[2]);
  const markerIndex = html.search(/data-initialevents/i);
  if (markerIndex < 0) return null;
  const objectStart = html.indexOf("{", markerIndex);
  const arrayStart = html.indexOf("[", markerIndex);
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  return start < 0 ? null : decodeEntities(balancedJson(html, start) ?? "");
}

function eventArray(value: unknown, depth = 0): unknown[] | null {
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    if (value.some((entry) => isRecord(entry) && ("event_type" in entry || "announcement_body" in entry || "gid" in entry))) {
      return value;
    }
    for (const entry of value) {
      const nested = eventArray(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of ["events", "event_models", "eventModels", "initialEvents", "documents"]) {
    const nested = eventArray(value[key], depth + 1);
    if (nested) return nested;
  }
  for (const nestedValue of Object.values(value)) {
    const nested = eventArray(nestedValue, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function category(value: unknown): { category: SteamEventCategory; rawCategory: EventJsonValue } {
  const rawCategory = jsonValue(value);
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (numeric === 14) return { category: "major_update", rawCategory };
  if (numeric === 13) return { category: "regular_update", rawCategory };
  if (numeric === 12) return { category: "patch_notes", rawCategory };
  return { category: "unknown", rawCategory };
}

function eventRecord(raw: unknown, requestedAppId: number | null, observedAt: string, provenance: string): SteamEventRecord | null {
  if (!isRecord(raw)) return null;
  const eventAppId = appId(raw.appid) ?? requestedAppId;
  if (eventAppId === null || (requestedAppId !== null && eventAppId !== requestedAppId)) return null;
  const body = isRecord(raw.announcement_body) ? raw.announcement_body : null;
  const eventId = stableId(raw.gid);
  const announcementId = stableId(body?.gid);
  if (!eventId && !announcementId) return null;
  const eventCategory = category(raw.event_type);
  const rawTitle = raw.event_name ?? raw.name ?? body?.headline ?? body?.title;
  const title = typeof rawTitle === "string" ? rawTitle : null;
  const rawUrl = raw.url ?? body?.url;
  const url = typeof rawUrl === "string" && rawUrl.trim().length > 0
    ? rawUrl.trim()
    : eventId && eventAppId
      ? `https://store.steampowered.com/news/app/${eventAppId}/view/${eventId}`
      : announcementId && eventAppId
        ? `https://steamcommunity.com/ogg/${eventAppId}/announcements/detail/${announcementId}`
        : null;
  const buildId = typeof raw.build_id === "number" && Number.isSafeInteger(raw.build_id)
    ? raw.build_id
    : typeof raw.build_id === "string" && raw.build_id !== "" ? raw.build_id : null;
  return {
    eventId,
    announcementId,
    appid: eventAppId,
    ...eventCategory,
    title,
    url,
    startAt: isoFromEpoch(raw.rtime32_start_time),
    publicationAt: isoFromEpoch(body?.posttime),
    endAt: isoFromEpoch(raw.rtime32_end_time),
    visibilityStartAt: isoFromEpoch(raw.rtime32_visibility_start),
    visibilityEndAt: isoFromEpoch(raw.rtime32_visibility_end),
    lastModifiedAt: isoFromEpoch(raw.rtime32_last_modified ?? body?.updatetime),
    buildId,
    observedAt,
    source: "steam.news_hub",
    provenance,
  };
}

interface ResponseText {
  ok: true;
  body: string;
  observedAt: string;
}

async function responseText(
  response: Response,
  endpoint: string,
  requestedAt: string,
  maxBodyBytes: number
): Promise<ResponseText | SteamEventsFailure> {
  const observedAt = requestedAt;
  if (response.status === 429) return failure(endpoint, "Steam rate limit", 429, true, observedAt);
  if (!response.ok) return failure(endpoint, `Steam request failed with HTTP ${response.status}`, response.status, false, observedAt);
  let body: string;
  try {
    body = await response.text();
  } catch {
    return failure(endpoint, "Steam returned an unreadable response", response.status, false, observedAt);
  }
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    return failure(endpoint, "Steam News Hub response exceeded the configured bound", response.status, false, observedAt);
  }
  return { ok: true, body, observedAt };
}

/** Discovers bounded structured event models from Store News Hub's initial event payload. */
export async function fetchSteamNewsHubEvents(
  appid: number,
  optionsOrFetch?: NewsHubOptions | typeof fetch
): Promise<SteamEventsResult> {
  const options = optionsFor(optionsOrFetch);
  const requestedAt = isoFromDate(options.observedAt);
  const endpoint = NEWS_HUB_ENDPOINT + appid;
  if (requestedAt === null) return failure(endpoint, "Invalid observedAt", null, false, null);
  if (!validAppId(appid)) return failure(endpoint, "Invalid Steam AppID", null, false, requestedAt);
  const maxEvents = options.maxEvents ?? DEFAULT_NEWS_HUB_MAX_EVENTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_NEWS_HUB_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    return failure(endpoint, "Invalid News Hub bounds", null, false, requestedAt);
  }
  const language = options.language ? `?l=${encodeURIComponent(options.language)}` : "";
  let response: Response;
  try {
    response = await (options.customFetch ?? fetch)(endpoint + language, { signal: options.signal });
  } catch (error) {
    return failure(endpoint, error instanceof Error ? error.message : "Steam request failed", null, false, requestedAt);
  }
  const text = await responseText(response, endpoint, requestedAt, maxBodyBytes);
  if (!text.ok) return text;
  const json = initialEventsJson(text.body);
  if (!json) return failure(endpoint, "Steam News Hub initial events were not found", response.status, false, text.observedAt);
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return failure(endpoint, "Steam News Hub initial events were invalid JSON", response.status, false, text.observedAt);
  }
  const models = eventArray(decoded);
  if (!models) return failure(endpoint, "Steam News Hub event models were not found", response.status, false, text.observedAt);
  const bounded = models.slice(0, maxEvents);
  const events = bounded.flatMap((model) => {
    const event = eventRecord(model, appid, text.observedAt, "steam.news_hub.initialevents");
    return event ? [event] : [];
  });
  return {
    ok: true,
    outcome: "success",
    value: {
      appid,
      events,
      observedAt: text.observedAt,
      truncated: models.length > maxEvents,
      source: "steam.news_hub",
      interpretationVersion: STEAM_EVENTS_INTERPRETATION_VERSION,
    },
  };
}

/** Resolves canonical Store event records from bounded announcement-body GIDs. */
export async function fetchSteamNewsHubBatchEvents(
  announcementGids: string[],
  appid: number,
  options: NewsHubOptions = {}
): Promise<SteamEventsResult> {
  const requestedAt = isoFromDate(options.observedAt);
  const endpoint = BATCH_EVENT_ENDPOINT;
  if (requestedAt === null) return failure(endpoint, "Invalid observedAt", null, false, null);
  if (!validAppId(appid)) return failure(endpoint, "Invalid Steam AppID", null, false, requestedAt);
  const maxBatchIds = options.maxBatchIds ?? DEFAULT_NEWS_HUB_MAX_BATCH_IDS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_NEWS_HUB_MAX_BODY_BYTES;
  const maxEvents = options.maxEvents ?? DEFAULT_NEWS_HUB_MAX_EVENTS;
  if (!Number.isSafeInteger(maxBatchIds) || maxBatchIds < 1) {
    return failure(endpoint, "Invalid News Hub batch bound", null, false, requestedAt);
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    return failure(endpoint, "Invalid News Hub body bound", null, false, requestedAt);
  }
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    return failure(endpoint, "Invalid News Hub event bound", null, false, requestedAt);
  }
  const validIds = announcementGids.filter((id) => /^\d+$/.test(id));
  const uniqueIds = [...new Set(validIds)];
  const ids = uniqueIds.slice(0, maxBatchIds);
  if (ids.length === 0) return failure(endpoint, "No valid announcement GIDs", null, false, requestedAt);
  const url = new URL(endpoint);
  url.searchParams.set("announcement_gids", ids.join(","));
  url.searchParams.set("lang_list", "0");
  url.searchParams.set("origin", "https://store.steampowered.com");
  let response: Response;
  try {
    response = await (options.customFetch ?? fetch)(url.toString(), { signal: options.signal });
  } catch (error) {
    return failure(endpoint, error instanceof Error ? error.message : "Steam request failed", null, false, requestedAt);
  }
  const text = await responseText(response, endpoint, requestedAt, maxBodyBytes);
  if (!text.ok) return text;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.body);
  } catch {
    return failure(endpoint, "Steam News Hub batch response was invalid JSON", response.status, false, text.observedAt);
  }
  if (!isRecord(decoded) || !(decoded.success === 1 || decoded.success === true || decoded.success === "1")) {
    return failure(endpoint, "Steam News Hub batch response was unsuccessful", response.status, false, text.observedAt);
  }
  const models = eventArray(decoded);
  if (!models) return failure(endpoint, "Steam News Hub batch event models were not found", response.status, false, text.observedAt);
  const bounded = models.slice(0, maxEvents);
  const events = bounded.flatMap((model) => {
    const event = eventRecord(model, appid, text.observedAt, "steam.news_hub.batched");
    return event ? [event] : [];
  });
  return {
    ok: true,
    outcome: "success",
    value: {
      appid,
      events,
      observedAt: text.observedAt,
      truncated: uniqueIds.length > ids.length || (models?.length ?? 0) > maxEvents,
      source: "steam.news_hub",
      interpretationVersion: STEAM_EVENTS_INTERPRETATION_VERSION,
    },
  };
}

/** Discovers page events and, when requested, resolves their announcement IDs independently. */
export async function discoverSteamNewsHubEvents(
  appid: number,
  options: NewsHubOptions & { resolveAnnouncements?: boolean } = {}
): Promise<SteamEventsDiscovery> {
  const discovery = await fetchSteamNewsHubEvents(appid, options);
  if (!options.resolveAnnouncements || !discovery.ok) return { discovery };
  const ids = discovery.value.events.flatMap((event) => event.announcementId ? [event.announcementId] : []);
  const resolution = await fetchSteamNewsHubBatchEvents(ids, appid, options);
  return { discovery, resolution };
}

