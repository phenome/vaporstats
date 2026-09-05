import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import serverEntry from "@tanstack/react-start/server-entry";
import { startIngestionScheduler } from "../workers/ingestion";
import { CACHE_POLICIES } from "./lib/cache";
import { getDb } from "./lib/db";

export const API_RATE_LIMIT_MAX_REQUESTS = 30;
export const API_RATE_LIMIT_WINDOW_MS = 10_000;
export const API_RATE_LIMIT_MAX_ENTRIES = 10_000;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface InMemoryRateLimiterOptions {
  maxRequests?: number;
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface ApiRateLimiter {
  limit(ip: string): boolean | Promise<boolean>;
}

/** A bounded fixed-window limiter for the trusted Cloudflare client IP header. */
export class InMemoryRateLimiter implements ApiRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(options: InMemoryRateLimiterOptions = {}) {
    this.maxRequests = positiveInteger(options.maxRequests ?? API_RATE_LIMIT_MAX_REQUESTS, "maxRequests");
    this.windowMs = positiveInteger(options.windowMs ?? API_RATE_LIMIT_WINDOW_MS, "windowMs");
    this.maxEntries = positiveInteger(options.maxEntries ?? API_RATE_LIMIT_MAX_ENTRIES, "maxEntries");
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  limit(ip: string): boolean {
    const now = this.now();
    const existing = this.buckets.get(ip);

    if (existing && existing.resetAt > now) {
      existing.count += 1;
      return existing.count <= this.maxRequests;
    }

    if (!existing && this.buckets.size >= this.maxEntries) {
      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(key);
      }
      if (this.buckets.size >= this.maxEntries) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }

    this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
    return true;
  }
}

const apiRateLimiter = new InMemoryRateLimiter();
const clientRoot = resolve(process.cwd(), "dist/client");
const realClientRoot = realpath(clientRoot).catch(() => clientRoot);

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function isApiRequest(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function rateLimitResponse(): Response {
  return new Response(
    JSON.stringify({
      status: "error",
      error: "Too many requests. Please retry shortly.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": CACHE_POLICIES.noStore,
        "Retry-After": "10",
      },
    }
  );
}

export async function enforceApiRateLimit(
  request: Request,
  limiter: ApiRateLimiter = apiRateLimiter
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isApiRequest(url.pathname)) return null;

  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip) return null;

  try {
    if (!(await limiter.limit(ip))) return rateLimitResponse();
  } catch {
    // Availability wins when the in-process limiter cannot evaluate a request.
  }

  return null;
}

interface StaticAsset {
  path: string;
  immutable: boolean;
}

function getStaticAsset(pathname: string): StaticAsset | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0")) return null;

  const immutable = decodedPath.startsWith("/assets/");
  const isPublicStaticFile =
    decodedPath === "/favicon.ico" ||
    decodedPath === "/site.webmanifest" ||
    /\.(?:ico|png|svg|webp|webmanifest)$/i.test(decodedPath);
  if (!immutable && !isPublicStaticFile) return null;

  const relativePath = decodedPath.slice(1);
  if (!relativePath) return null;

  const candidate = resolve(clientRoot, relativePath);
  const relativePathFromRoot = relative(clientRoot, candidate);
  if (
    !relativePathFromRoot ||
    relativePathFromRoot === ".." ||
    relativePathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativePathFromRoot)
  ) {
    return null;
  }

  return { path: candidate, immutable };
}

async function serveStaticAsset(url: URL): Promise<Response | null> {
  const asset = getStaticAsset(url.pathname);
  if (!asset) return null;

  try {
    const [rootPath, filePath] = await Promise.all([
      realClientRoot,
      realpath(asset.path),
    ]);
    const relativeFilePath = relative(rootPath, filePath);
    if (
      !relativeFilePath ||
      relativeFilePath === ".." ||
      relativeFilePath.startsWith(`..${sep}`) ||
      isAbsolute(relativeFilePath)
    ) {
      return null;
    }

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) return null;

    const file = Bun.file(filePath);
    const headers = new Headers({
      "Cache-Control": asset.immutable ? CACHE_POLICIES.immutableAsset : "public, max-age=86400",
    });
    if (file.type) headers.set("Content-Type", file.type);
    return new Response(file, { headers });
  } catch {
    return null;
  }
}

export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === "www.vaporstats.com") {
    url.protocol = "https:";
    url.hostname = "vaporstats.com";
    return Response.redirect(url.toString(), 301);
  }

  const rateLimitResponseResult = await enforceApiRateLimit(request);
  if (rateLimitResponseResult) return rateLimitResponseResult;

  const staticResponse = await serveStaticAsset(url);
  if (staticResponse) return staticResponse;
  if (url.pathname.startsWith("/assets/")) return new Response("Not Found", { status: 404 });

  return serverEntry.fetch(request);
}

export interface StartServerOptions {
  port?: number;
  hostname?: string;
}

interface StartedServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}
let serverPromise: Promise<StartedServer> | undefined;

function getPort(): number {
  const configuredPort = process.env.PORT;
  if (configuredPort === undefined) return 3000;

  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function startServer(options: StartServerOptions = {}) {
  serverPromise ??= (async () => {
    const db = await getDb();
    startIngestionScheduler({
      db,
      steamApiKey: process.env.STEAM_API_KEY,
      runImmediately: true,
    });

    return Bun.serve({
      hostname: options.hostname ?? process.env.HOST ?? "0.0.0.0",
      port: options.port ?? getPort(),
      fetch: handleRequest,
    });
  })();
  return serverPromise;
}

const server = { fetch: handleRequest };
export default server;

if (import.meta.main) {
  void startServer().catch((error) => {
    console.error("Failed to start VaporStats server", error);
    process.exitCode = 1;
  });
}
