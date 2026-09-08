import type { AppDatabase } from "../src/lib/db";
import { getCheckpoint, setCheckpoint } from "../src/lib/catalog";
import type { CriticFetchResult, CriticRecord } from "../src/lib/critics";
import { persistCriticRecord } from "../src/lib/critic-store";
import {
  fetchOpenCriticAggregate,
  type OpenCriticFetchOptions,
} from "./opencritic-source";
import {
  fetchMetacriticAggregate,
  type MetacriticFetchOptions,
} from "./metacritic-source";

export const OPENCRITIC_SITEMAP_CHECKPOINT_KEY = "critic:opencritic:sitemap";
export const CRITIC_CHECKPOINT_PREFIX = "critic:collection";
export const DEFAULT_CRITIC_MAX_REQUESTS = 8;
export const DEFAULT_CRITIC_MAX_GAMES = 2;
export const CRITIC_SITEMAP_CACHE_DAYS = 30;
export const CRITIC_RECENT_TITLE_DAYS = 180;

const OPENCRITIC_INDEX_URL = "https://opencritic.com/sitemap.xml";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COLLECTION_CAP = 1000;

function boundedCap(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_COLLECTION_CAP) : fallback;
}

type CriticFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type CatalogApp = {
  appid: number;
  name: string;
  slug: string;
  releaseDate: string | null;
  metacriticUrl: string | null;
  opencriticAttempt: string | null;
  metacriticAttempt: string | null;
};

type CriticAttempt = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextDueAt: string;
  lastStatus: string;
  lastError: string | null;
};

type GoodSitemap = {
  fetchedAt: string;
  gameUrls: string[];
};

type RefreshSitemap = {
  startedAt: string;
  sitemapUrls: string[];
  cursor: number;
  gameUrls: string[];
};

type SitemapCheckpoint = {
  good: GoodSitemap | null;
  refresh: RefreshSitemap | null;
  lastFailure: string | null;
};

type RequestResult = {
  status: number | null;
  body: string | null;
  rateLimited: boolean;
  budgetExhausted: boolean;
  error: string | null;
};

export interface CriticCollectionOptions {
  now?: string | Date;
  maxRequests?: number;
  maxGames?: number;
  recentTitleDays?: number;
  fetch?: CriticFetch;
  signal?: AbortSignal;
}

export interface CriticCollectionResult {
  requests: number;
  games: number;
  successes: number;
  negativeLookups: number;
  failures: number;
  rateLimited: boolean;
  sitemapRefreshed: boolean;
}

export function getCriticCheckpointKey(source: "opencritic" | "metacritic", appid: number): string {
  return `${CRITIC_CHECKPOINT_PREFIX}:${source}:${appid}`;
}


function asIso(value: string | Date | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid collector time");
  return date.toISOString();
}

function parseCheckpoint<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function normalizeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function allowedGameUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.hostname !== "opencritic.com" && url.hostname !== "www.opencritic.com")) return null;
    const match = url.pathname.match(/^\/game\/(\d+)\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!match || url.search || url.hash) return null;
    return `https://opencritic.com/game/${match[1]}/${match[2].toLowerCase()}`;
  } catch {
    return null;
  }
}

function allowedGameSitemapUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || (url.hostname !== "opencritic.com" && url.hostname !== "www.opencritic.com")) return null;
    const match = url.pathname.match(/^\/sitemap_games_([1-5])\.xml$/i);
    if (!match || url.search || url.hash) return null;
    return `https://opencritic.com/sitemap_games_${match[1]}.xml`;
  } catch {
    return null;
  }
}

function parseLocs(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) values.push(decodeXml(match[1].trim()));
  return values;
}

function parseSitemapIndex(xml: string): string[] {
  return [...new Set(parseLocs(xml).map(allowedGameSitemapUrl).filter((url): url is string => url !== null))]
    .sort((a, b) => a.localeCompare(b));
}

function parseGameSitemap(xml: string): string[] {
  return [...new Set(parseLocs(xml).map(allowedGameUrl).filter((url): url is string => url !== null))];
}

function validGoodSitemap(value: unknown): GoodSitemap | null {
  const state = value as Partial<GoodSitemap> | null;
  if (!state || typeof state.fetchedAt !== "string" || !Array.isArray(state.gameUrls)) return null;
  const gameUrls = state.gameUrls.filter((url): url is string => typeof url === "string" && allowedGameUrl(url) !== null);
  return { fetchedAt: state.fetchedAt, gameUrls: [...new Set(gameUrls)] };
}

function readSitemapState(value: string | null | undefined): SitemapCheckpoint {
  const parsed = parseCheckpoint<Partial<SitemapCheckpoint>>(value);
  return {
    good: validGoodSitemap(parsed?.good),
    refresh: parsed?.refresh && Array.isArray(parsed.refresh.sitemapUrls) && Array.isArray(parsed.refresh.gameUrls)
      ? {
          startedAt: typeof parsed.refresh.startedAt === "string" ? parsed.refresh.startedAt : new Date(0).toISOString(),
          sitemapUrls: parsed.refresh.sitemapUrls.filter((url): url is string => typeof url === "string" && allowedGameSitemapUrl(url) !== null),
          cursor: Math.max(0, Number.isInteger(parsed.refresh.cursor) ? parsed.refresh.cursor : 0),
          gameUrls: parsed.refresh.gameUrls.filter((url): url is string => typeof url === "string" && allowedGameUrl(url) !== null),
        }
      : null,
    lastFailure: typeof parsed?.lastFailure === "string" ? parsed.lastFailure : null,
  };
}

async function saveSitemapState(db: AppDatabase, state: SitemapCheckpoint): Promise<void> {
  await setCheckpoint(db, OPENCRITIC_SITEMAP_CHECKPOINT_KEY, JSON.stringify(state));
}

function cacheFresh(good: GoodSitemap, now: string): boolean {
  const age = Date.parse(now) - Date.parse(good.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < CRITIC_SITEMAP_CACHE_DAYS * DAY_MS;
}

function parseAttempt(value: string | null | undefined): CriticAttempt | null {
  const parsed = parseCheckpoint<Partial<CriticAttempt>>(value);
  if (!parsed || typeof parsed.nextDueAt !== "string") return null;
  return {
    lastAttemptAt: typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : null,
    lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
    nextDueAt: parsed.nextDueAt,
    lastStatus: typeof parsed.lastStatus === "string" ? parsed.lastStatus : "unknown",
    lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
  };
}

function isDue(attempt: CriticAttempt | null, now: string): boolean {
  return attempt === null || Date.parse(attempt.nextDueAt) <= Date.parse(now);
}

function releaseYear(value: string | null): number | null {
  const match = value?.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function cadenceFor(app: CatalogApp, now: string, recentTitleDays: number): "weekly" | "monthly" {
  if (!app.releaseDate) return "monthly";
  const release = Date.parse(app.releaseDate);
  const current = Date.parse(now);
  return Number.isFinite(release) && release <= current && current - release <= recentTitleDays * DAY_MS ? "weekly" : "monthly";
}

function nextDue(now: string, cadence: "weekly" | "monthly"): string {
  return new Date(Date.parse(now) + (cadence === "weekly" ? 7 : 30) * DAY_MS).toISOString();
}

function nativeEvidenceExists(record: CriticRecord): boolean {
  return record.score !== null || record.tier !== null || record.reviewCount !== null || record.percentRecommended !== null;
}

function candidateUrls(gameUrls: readonly string[], title: string): string[] {
  const expected = normalizeSlug(title);
  return gameUrls.filter((url) => {
    const match = url.match(/^https:\/\/opencritic\.com\/game\/\d+\/([^/]+)$/);
    return match !== null && match[1] === expected;
  });
}

async function requestText(
  url: string,
  fetcher: CriticFetch,
  signal: AbortSignal | undefined,
): Promise<RequestResult> {
  try {
    const response = await fetcher(url, { redirect: "manual", signal, headers: { accept: "text/xml,text/html,application/xhtml+xml" } });
    if (response.status === 429) return { status: 429, body: null, rateLimited: true, budgetExhausted: false, error: "rate_limited" };
    if (!response.ok) return { status: response.status, body: null, rateLimited: false, budgetExhausted: false, error: `http_${response.status}` };
    return { status: response.status, body: await response.text(), rateLimited: false, budgetExhausted: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "network_error";
    return { status: null, body: null, rateLimited: false, budgetExhausted: message === "request_budget_exhausted", error: message };
  }
}

async function ensureOpenCriticIndex(
  db: AppDatabase,
  state: SitemapCheckpoint,
  now: string,
  request: (url: string) => Promise<RequestResult>,
): Promise<{ state: SitemapCheckpoint; gameUrls: string[]; complete: boolean; refreshed: boolean; rateLimited: boolean; failed: boolean }> {
  if (state.good && !state.refresh && cacheFresh(state.good, now)) return { state, gameUrls: state.good.gameUrls, complete: true, refreshed: false, rateLimited: false, failed: false };

  let refresh = state.refresh;
  if (!refresh) {
    const index = await request(OPENCRITIC_INDEX_URL);
    if (index.budgetExhausted) return { state, gameUrls: state.good?.gameUrls ?? [], complete: false, refreshed: false, rateLimited: false, failed: false };
    if (index.rateLimited) return { state, gameUrls: state.good?.gameUrls ?? [], complete: false, refreshed: false, rateLimited: true, failed: false };
    if (!index.body) {
      state.lastFailure = index.error ?? "sitemap_index_unavailable";
      await saveSitemapState(db, state);
      return { state, gameUrls: state.good?.gameUrls ?? [], complete: false, refreshed: false, rateLimited: false, failed: true };
    }
    const sitemapUrls = parseSitemapIndex(index.body);
    if (sitemapUrls.length === 0) {
      state.lastFailure = "sitemap_index_empty";
      await saveSitemapState(db, state);
      return { state, gameUrls: state.good?.gameUrls ?? [], complete: false, refreshed: false, rateLimited: false, failed: true };
    }
    refresh = { startedAt: now, sitemapUrls, cursor: 0, gameUrls: [] };
    state.refresh = refresh;
    await saveSitemapState(db, state);
  }

  while (refresh.cursor < refresh.sitemapUrls.length) {
    const child = await request(refresh.sitemapUrls[refresh.cursor]);
    if (child.budgetExhausted) {
      await saveSitemapState(db, state);
      return { state, gameUrls: state.good?.gameUrls ?? refresh.gameUrls, complete: false, refreshed: false, rateLimited: false, failed: false };
    }
    if (child.rateLimited) {
      await saveSitemapState(db, state);
      return { state, gameUrls: state.good?.gameUrls ?? refresh.gameUrls, complete: false, refreshed: false, rateLimited: true, failed: false };
    }
    if (!child.body) {
      state.refresh = null;
      state.lastFailure = child.error ?? "sitemap_child_unavailable";
      await saveSitemapState(db, state);
      return { state, gameUrls: state.good?.gameUrls ?? [], complete: false, refreshed: false, rateLimited: false, failed: true };
    }
    refresh.gameUrls.push(...parseGameSitemap(child.body));
    refresh.gameUrls = [...new Set(refresh.gameUrls)];
    refresh.cursor += 1;
    await saveSitemapState(db, state);
  }

  state.good = { fetchedAt: now, gameUrls: [...new Set(refresh.gameUrls)] };
  state.refresh = null;
  state.lastFailure = null;
  await saveSitemapState(db, state);
  return { state, gameUrls: state.good.gameUrls, complete: true, refreshed: true, rateLimited: false, failed: false };
}

async function markAttempt(
  db: AppDatabase,
  source: "opencritic" | "metacritic",
  appid: number,
  now: string,
  cadence: "weekly" | "monthly",
  status: string,
  error: string | null,
  previous: CriticAttempt | null,
  successful: boolean,
): Promise<void> {
  await setCheckpoint(
    db,
    getCriticCheckpointKey(source, appid),
    JSON.stringify({
      lastAttemptAt: now,
      lastSuccessAt: successful ? now : previous?.lastSuccessAt ?? null,
      nextDueAt: nextDue(now, cadence),
      lastStatus: status,
      lastError: error,
    } satisfies CriticAttempt),
  );
}
async function catalogApps(db: AppDatabase, now: string, limit: number): Promise<CatalogApp[]> {
  const rows = await db.prepare(
    "SELECT apps.appid, apps.name, apps.slug, apps.release_date AS releaseDate, apps.metacritic_url AS metacriticUrl, oc.value AS opencriticAttempt, mc.value AS metacriticAttempt FROM apps LEFT JOIN tracked_games ON tracked_games.appid = apps.appid LEFT JOIN checkpoints AS oc ON oc.key = 'critic:collection:opencritic:' || apps.appid LEFT JOIN checkpoints AS mc ON mc.key = 'critic:collection:metacritic:' || apps.appid WHERE apps.is_eligible = 1 AND apps.is_playable = 1 AND ((oc.key IS NULL OR json_valid(oc.value) = 0 OR json_type(oc.value, '$.nextDueAt') IS NULL OR julianday(json_extract(oc.value, '$.nextDueAt')) IS NULL OR julianday(json_extract(oc.value, '$.nextDueAt')) <= julianday(?)) OR (mc.key IS NULL OR json_valid(mc.value) = 0 OR json_type(mc.value, '$.nextDueAt') IS NULL OR julianday(json_extract(mc.value, '$.nextDueAt')) IS NULL OR julianday(json_extract(mc.value, '$.nextDueAt')) <= julianday(?) OR (apps.metacritic_url IS NOT NULL AND json_extract(mc.value, '$.lastError') = 'missing_steam_metacritic_url'))) ORDER BY CASE WHEN tracked_games.appid IS NULL THEN 1 ELSE 0 END, tracked_games.latest_players IS NULL, tracked_games.latest_players DESC, apps.appid LIMIT ?",
  ).bind(now, now, limit).all<CatalogApp>();
  return rows.results;
}


async function fetchOpenCritic(
  app: CatalogApp,
  urls: readonly string[],
  cadence: "weekly" | "monthly",
  fetcher: CriticFetch,
  signal: AbortSignal | undefined,
): Promise<CriticFetchResult> {
  const candidates = candidateUrls(urls, app.name);
  if (candidates.length !== 1) return { status: "missing", error: candidates.length === 0 ? "no_unique_sitemap_match" : "ambiguous_sitemap_match", httpStatus: null };
  const providerGameId = Number(candidates[0].match(/^https:\/\/opencritic\.com\/game\/(\d+)\//)?.[1]);
  const options: OpenCriticFetchOptions = {
    sourceUrl: candidates[0],
    expected: { steamAppId: app.appid, title: app.name, slug: app.name, providerGameId },
    fetch: fetcher,
    signal,
  };
  const result = await fetchOpenCriticAggregate(options);
  if (result.status === "ok") result.record.cadence = cadence;
  return result;
}

async function fetchMetacritic(
  app: CatalogApp,
  cadence: "weekly" | "monthly",
  fetcher: CriticFetch,
): Promise<CriticFetchResult> {
  if (!app.metacriticUrl) return { status: "missing", error: "missing_steam_metacritic_url", httpStatus: null };
  const options: MetacriticFetchOptions = {
    title: app.name,
    steamAppId: app.appid,
    releaseYear: releaseYear(app.releaseDate),
    metacriticUrl: app.metacriticUrl,
    cadence,
  };
  const result = await fetchMetacriticAggregate(options, fetcher);
  if (result.status === "ok") result.record.cadence = cadence;
  return result;
}

/**
 * Runs a small, resumable public-page collection slice. The worker has no
 * access-control bypass and never requests provider search, review, or outlet
 * pages.
 */
export async function runCriticCollection(
  db: AppDatabase,
  options: CriticCollectionOptions = {},
): Promise<CriticCollectionResult> {
  const now = asIso(options.now);
  const maxRequests = boundedCap(options.maxRequests, DEFAULT_CRITIC_MAX_REQUESTS);
  const maxGames = boundedCap(options.maxGames, DEFAULT_CRITIC_MAX_GAMES);
  const recentTitleDays = Math.max(1, boundedCap(options.recentTitleDays, CRITIC_RECENT_TITLE_DAYS));
  const fetcher = options.fetch ?? fetch;
  let requests = 0;
  let rateLimited = false;
  const countedFetcher: CriticFetch = async (input, init) => {
    if (requests >= maxRequests) throw new Error("request_budget_exhausted");
    requests += 1;
    return fetcher(input, init);
  };
  const request = async (url: string): Promise<RequestResult> => {
    return requestText(url, countedFetcher, options.signal);
  };
  const result: CriticCollectionResult = {
    requests: 0,
    games: 0,
    successes: 0,
    negativeLookups: 0,
    failures: 0,
    rateLimited: false,
    sitemapRefreshed: false,
  };
  const apps = await catalogApps(db, now, maxGames);
  const attempts = new Map<string, CriticAttempt | null>();
  for (const app of apps) {
    attempts.set("opencritic:" + app.appid, parseAttempt(app.opencriticAttempt));
    attempts.set("metacritic:" + app.appid, parseAttempt(app.metacriticAttempt));
  }
  const dueApps = apps;
  let sitemapUrls: string[] | null = null;
  let sitemapState = readSitemapState((await getCheckpoint(db, OPENCRITIC_SITEMAP_CHECKPOINT_KEY))?.value);

  for (const app of dueApps) {
    if (result.games >= maxGames || rateLimited || requests >= maxRequests) break;
    result.games += 1;
    const cadence = cadenceFor(app, now, recentTitleDays);
    const openDue = isDue(attempts.get(`opencritic:${app.appid}`) ?? null, now);
    const metaAttempt = attempts.get(`metacritic:${app.appid}`) ?? null;
    const metaDue =
      isDue(metaAttempt, now) ||
      (app.metacriticUrl !== null && metaAttempt?.lastError === "missing_steam_metacritic_url");

    if (openDue) {
      let openAvailable = true;
      if (sitemapUrls === null) {
        const index = await ensureOpenCriticIndex(db, sitemapState, now, request);
        sitemapState = index.state;
        sitemapUrls = index.gameUrls;
        result.sitemapRefreshed ||= index.refreshed;
        if (index.rateLimited) {
          rateLimited = true;
          result.rateLimited = true;
          break;
        }
        if (index.failed && !index.gameUrls.length) {
          await markAttempt(db, "opencritic", app.appid, now, cadence, "error", "sitemap_unavailable", attempts.get("opencritic:" + app.appid) ?? null, false);
          result.failures += 1;
          openAvailable = false;
        } else if (requests >= maxRequests && !index.complete) {
          break;
        }
      }
      if (openAvailable && sitemapUrls !== null) {
        const fetched = await fetchOpenCritic(app, sitemapUrls, cadence, countedFetcher, options.signal);
        if (fetched.status === "ok" && nativeEvidenceExists(fetched.record)) {
          await persistCriticRecord(db, fetched.record);
          await markAttempt(db, "opencritic", app.appid, now, cadence, "success", null, attempts.get("opencritic:" + app.appid) ?? null, true);
          result.successes += 1;
        } else {
          const isRate = fetched.status === "rate_limited";
          const failureStatus = fetched.status === "ok" ? "missing" : fetched.status;
          const failureError = fetched.status === "ok" ? "native_metrics_missing" : fetched.error;
          await markAttempt(db, "opencritic", app.appid, now, cadence, isRate ? "rate_limited" : failureStatus, failureError, attempts.get("opencritic:" + app.appid) ?? null, false);
          if (isRate) {
            rateLimited = true;
            result.rateLimited = true;
            break;
          }
          result.negativeLookups += 1;
        }
      }
    }
    if (rateLimited || requests >= maxRequests) break;
    if (metaDue) {
      if (!app.metacriticUrl) {
        await markAttempt(db, "metacritic", app.appid, now, cadence, "missing", "missing_steam_metacritic_url", attempts.get(`metacritic:${app.appid}`) ?? null, false);
        result.negativeLookups += 1;
        continue;
      }
      if (requests >= maxRequests) break;
      const fetched = await fetchMetacritic(app, cadence, countedFetcher);
      if (fetched.status === "ok" && nativeEvidenceExists(fetched.record)) {
        await persistCriticRecord(db, fetched.record);
        await markAttempt(db, "metacritic", app.appid, now, cadence, "success", null, attempts.get(`metacritic:${app.appid}`) ?? null, true);
        result.successes += 1;
      } else {
        const isRate = fetched.status === "rate_limited";
        const failureStatus = fetched.status === "ok" ? "missing" : fetched.status;
        const failureError = fetched.status === "ok" ? "native_metrics_missing" : fetched.error;
        await markAttempt(db, "metacritic", app.appid, now, cadence, isRate ? "rate_limited" : failureStatus, failureError, attempts.get(`metacritic:${app.appid}`) ?? null, false);
        if (isRate) {
          rateLimited = true;
          result.rateLimited = true;
          break;
        }
        result.negativeLookups += 1;
      }
    }
  }
  result.requests = requests;
  return result;
}

