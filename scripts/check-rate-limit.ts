import assert from "node:assert/strict";
import server, { enforceApiRateLimit, type ServerEnv } from "../src/server";
import { CACHE_POLICIES } from "../src/lib/cache";

interface MockCall {
  key: string;
}

class MockRateLimiter implements RateLimit {
  private limitCount: number;
  private currentRequests = new Map<string, number>();
  public calls: MockCall[] = [];
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

async function runTests() {
  const limiter = new MockRateLimiter(30);

  // 1. Non-API requests should never be rate limited
  {
    const reqHome = new Request("https://vaporstats.com/", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const resHome = await enforceApiRateLimit(reqHome, limiter);
    assert.equal(resHome, null, "Homepage should not be rate limited");
    assert.equal(limiter.calls.length, 0, "Limiter should not be called for non-API route");

    const reqGame = new Request("https://vaporstats.com/games/730", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const resGame = await enforceApiRateLimit(reqGame, limiter);
    assert.equal(resGame, null, "Game route should not be rate limited");
  }

  // 2. Missing IP header should skip limiting (not block shared unknown bucket)
  {
    limiter.reset();
    const reqNoIp = new Request("https://vaporstats.com/api/catalog");
    const resNoIp = await enforceApiRateLimit(reqNoIp, limiter);
    assert.equal(resNoIp, null, "Request without IP should be allowed");
    assert.equal(limiter.calls.length, 0, "Limiter should not be called when IP is absent");
  }

  // 3. Undefined limiter should fail open
  {
    const req = new Request("https://vaporstats.com/api/catalog", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await enforceApiRateLimit(req, undefined);
    assert.equal(res, null, "Request without limiter binding should fail open");
  }

  // 4. Failing limiter service should fail open
  {
    limiter.reset();
    limiter.shouldThrow = true;
    const req = new Request("https://vaporstats.com/api/search?q=portal", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    const res = await enforceApiRateLimit(req, limiter);
    assert.equal(res, null, "Limiter error should fail open to preserve availability");
    assert.equal(limiter.calls.length, 1);
  }

  // 5. Normal burst: 30 requests succeed, 31st returns 429
  {
    limiter.reset();
    const ip = "198.51.100.25";

    for (let i = 1; i <= 30; i++) {
      const req = new Request(`https://vaporstats.com/api/rankings?i=${i}`, {
        headers: { "cf-connecting-ip": ip },
      });
      const res = await enforceApiRateLimit(req, limiter);
      assert.equal(res, null, `Request ${i} within limit should succeed`);
    }
    assert.equal(limiter.calls.length, 30);

    // 31st request exceeds limit
    const req31 = new Request("https://vaporstats.com/api/rankings?i=31", {
      headers: { "cf-connecting-ip": ip },
    });
    const res31 = await enforceApiRateLimit(req31, limiter);
    assert.ok(res31 instanceof Response, "31st request must return a Response");
    assert.equal(res31.status, 429, "Rate-limited response status must be 429");
    assert.equal(res31.headers.get("retry-after"), "10", "Retry-After header must be 10");
    assert.equal(res31.headers.get("cache-control"), CACHE_POLICIES.noStore, "Must have no-store cache control");
    assert.equal(
      res31.headers.get("content-type"),
      "application/json; charset=utf-8",
      "Content-Type must be application/json"
    );

    const body = (await res31.json()) as { status: string; error: string };
    assert.equal(body.status, "error");
    assert.equal(body.error, "Too many requests. Please retry shortly.");

    // Independent IP is still allowed
    const differentIpReq = new Request("https://vaporstats.com/api/rankings", {
      headers: { "cf-connecting-ip": "203.0.113.88" },
    });
    const diffRes = await enforceApiRateLimit(differentIpReq, limiter);
    assert.equal(diffRes, null, "Different IP should have independent allowance");
  }

  // 6. Server integration check: 429 response handled at worker entrypoint
  {
    limiter.reset();
    const blockedLimiter: RateLimit = {
      limit: async () => ({ success: false }),
    };

    const dummyAssets: Fetcher = {
      fetch: async () => new Response("asset"),
      connect: () => {
        throw new Error("unimplemented");
      },
    };

    const env: ServerEnv = {
      ASSETS: dummyAssets,
      API_RATE_LIMITER: blockedLimiter,
    };

    const req = new Request("https://vaporstats.com/api/deals", {
      headers: { "cf-connecting-ip": "192.0.2.1" },
    });

    const response = await server.fetch(req, env);
    assert.equal(response.status, 429, "Worker fetch must return 429 on rate limit");
    assert.equal(response.headers.get("retry-after"), "10");
  }

  console.log("rate limit checks passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
