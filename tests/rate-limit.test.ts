import { describe, expect, it } from "bun:test";
import server, { enforceApiRateLimit, type ServerEnv } from "../src/server";
import { CACHE_POLICIES } from "../src/lib/cache";

class MockRateLimiter implements RateLimit {
  private limitCount: number;
  private currentRequests = new Map<string, number>();
  public calls: { key: string }[] = [];
  public shouldThrow = false;

  constructor(limitCount: number = 30) {
    this.limitCount = limitCount;
  }

  async limit(options: { key: string }): Promise<{ success: boolean }> {
    this.calls.push(options);
    if (this.shouldThrow) {
      throw new Error("Internal Cloudflare rate limiting service failure");
    }

    const count = (this.currentRequests.get(options.key) ?? 0) + 1;
    this.currentRequests.set(options.key, count);

    return {
      success: count <= this.limitCount,
    };
  }

  reset() {
    this.currentRequests.clear();
    this.calls = [];
    this.shouldThrow = false;
  }
}

describe("API rate limiting", () => {
  it("ignores non-API requests", async () => {
    const limiter = new MockRateLimiter(30);
    const req = new Request("https://vaporstats.com/", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await enforceApiRateLimit(req, limiter);
    expect(res).toBeNull();
    expect(limiter.calls.length).toBe(0);
  });

  it("skips rate limiting when IP header is absent", async () => {
    const limiter = new MockRateLimiter(30);
    const req = new Request("https://vaporstats.com/api/catalog");
    const res = await enforceApiRateLimit(req, limiter);
    expect(res).toBeNull();
    expect(limiter.calls.length).toBe(0);
  });

  it("fails open when limiter binding is missing", async () => {
    const req = new Request("https://vaporstats.com/api/catalog", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await enforceApiRateLimit(req, undefined);
    expect(res).toBeNull();
  });

  it("fails open when limiter service throws an error", async () => {
    const limiter = new MockRateLimiter(30);
    limiter.shouldThrow = true;
    const req = new Request("https://vaporstats.com/api/catalog", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await enforceApiRateLimit(req, limiter);
    expect(res).toBeNull();
    expect(limiter.calls.length).toBe(1);
  });

  it("allows 30 requests and rejects 31st with 429 and Retry-After 10", async () => {
    const limiter = new MockRateLimiter(30);
    const ip = "198.51.100.42";

    for (let i = 1; i <= 30; i++) {
      const req = new Request(`https://vaporstats.com/api/deals?i=${i}`, {
        headers: { "cf-connecting-ip": ip },
      });
      const res = await enforceApiRateLimit(req, limiter);
      expect(res).toBeNull();
    }

    const req31 = new Request("https://vaporstats.com/api/deals?i=31", {
      headers: { "cf-connecting-ip": ip },
    });
    const res31 = await enforceApiRateLimit(req31, limiter);
    expect(res31).not.toBeNull();
    expect(res31?.status).toBe(429);
    expect(res31?.headers.get("retry-after")).toBe("10");
    expect(res31?.headers.get("cache-control")).toBe(CACHE_POLICIES.noStore);
    expect(res31?.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const body = (await res31?.json()) as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toBe("Too many requests. Please retry shortly.");
  });

  it("worker fetch entrypoint returns 429 directly on rate limit", async () => {
    const blockedLimiter: RateLimit = {
      limit: async () => ({ success: false }),
    };

    const env: ServerEnv = {
      ASSETS: {
        fetch: async () => new Response("asset"),
        connect: () => {
          throw new Error("unimplemented");
        },
      },
      API_RATE_LIMITER: blockedLimiter,
    };

    const req = new Request("https://vaporstats.com/api/rankings", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });

    const res = await server.fetch(req, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
  });
});
