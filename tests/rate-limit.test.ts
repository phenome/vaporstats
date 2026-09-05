import { describe, expect, it } from "bun:test";
import {
  enforceApiRateLimit,
  InMemoryRateLimiter,
  type ApiRateLimiter,
} from "../src/server";
import { CACHE_POLICIES } from "../src/lib/cache";

function apiRequest(ip?: string): Request {
  return new Request("https://vaporstats.com/api/catalog", {
    headers: ip ? { "cf-connecting-ip": ip } : undefined,
  });
}

describe("API rate limiting", () => {
  it("ignores non-API requests", async () => {
    const limiter = new InMemoryRateLimiter();
    const request = new Request("https://vaporstats.com/", {
      headers: { "cf-connecting-ip": "198.51.100.1" },
    });

    expect(await enforceApiRateLimit(request, limiter)).toBeNull();
    expect(limiter.size).toBe(0);
  });

  it("skips rate limiting when the trusted IP header is absent", async () => {
    const calls: string[] = [];
    const limiter: ApiRateLimiter = {
      limit(ip) {
        calls.push(ip);
        return false;
      },
    };

    expect(await enforceApiRateLimit(apiRequest(), limiter)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("fails open when the in-memory limiter cannot evaluate a request", async () => {
    const limiter: ApiRateLimiter = {
      limit() {
        throw new Error("internal limiter failure");
      },
    };

    expect(await enforceApiRateLimit(apiRequest("203.0.113.1"), limiter)).toBeNull();
  });

  it("allows 30 requests and rejects the 31st with 429 and Retry-After 10", async () => {
    const limiter = new InMemoryRateLimiter();
    const ip = "198.51.100.42";

    for (let requestNumber = 1; requestNumber <= 30; requestNumber += 1) {
      expect(await enforceApiRateLimit(apiRequest(ip), limiter)).toBeNull();
    }

    const response = await enforceApiRateLimit(apiRequest(ip), limiter);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("10");
    expect(response?.headers.get("cache-control")).toBe(CACHE_POLICIES.noStore);
    expect(response?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await response?.json()) as { status: string; error: string } | undefined;
    expect(body?.status).toBe("error");
    expect(body?.error).toBe("Too many requests. Please retry shortly.");
  });

  it("keeps independent allowances for different IPs and resets after 10 seconds", async () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter({ now: () => now });
    const firstIp = "192.0.2.10";

    for (let requestNumber = 1; requestNumber <= 30; requestNumber += 1) {
      expect(await enforceApiRateLimit(apiRequest(firstIp), limiter)).toBeNull();
    }
    expect((await enforceApiRateLimit(apiRequest(firstIp), limiter))?.status).toBe(429);
    expect(await enforceApiRateLimit(apiRequest("192.0.2.11"), limiter)).toBeNull();

    now = 10_000;
    expect(await enforceApiRateLimit(apiRequest(firstIp), limiter)).toBeNull();
  });

  it("bounds retained IP buckets", async () => {
    const limiter = new InMemoryRateLimiter({ maxEntries: 2 });

    await enforceApiRateLimit(apiRequest("192.0.2.20"), limiter);
    await enforceApiRateLimit(apiRequest("192.0.2.21"), limiter);
    await enforceApiRateLimit(apiRequest("192.0.2.22"), limiter);

    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});
