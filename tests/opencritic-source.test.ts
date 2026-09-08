import { describe, expect, test } from "bun:test";
import {
  fetchOpenCriticAggregate,
  parseOpenCriticAggregate,
  type OpenCriticParseResult,
} from "../workers/opencritic-source";
import type { CriticRecord } from "../src/lib/critics";

const SOURCE_URL = "https://opencritic.com/game/8525/cyberpunk-2077";

const EMBEDDED_PAGE = `<!doctype html>
<html>
  <head>
    <title>Cyberpunk 2077 - OpenCritic</title>
    <link rel="canonical" href="${SOURCE_URL}">
    <meta name="description" content="Cyberpunk 2077 is rated 'Strong' after being reviewed by 230 critics, with an overall average score of 76. It's ranked in the top 33% of games and recommended by 66% of critics.">
    <meta property="article:published_time" content="2020-12-10T00:00:00Z">
    <meta property="article:modified_time" content="2025-12-04T00:00:00Z">
  </head>
  <body>
    <a href="/review/12345">Review</a>
    <script id="__NEXT_DATA__" type="application/json">
      {"props":{"pageProps":{"game":{
        "id":8525,
        "name":"Cyberpunk 2077",
        "slug":"cyberpunk-2077",
        "url":"${SOURCE_URL}",
        "steamId":1091500,
        "topCriticScore":76,
        "tier":"Strong",
        "numReviews":230,
        "percentRecommended":66,
        "platforms":[{"name":"PC"},{"name":"PlayStation 5"},{"name":"Xbox Series X|S"}]
      }}}}
    </script>
  </body>
</html>`;

const MISSING_FIELDS_PAGE = `<!doctype html>
<html>
  <head>
    <title>Cyberpunk 2077 - OpenCritic</title>
    <link rel="canonical" href="${SOURCE_URL}">
  </head>
  <script type="application/ld+json">{"@type":"VideoGame","name":"Cyberpunk 2077","url":"${SOURCE_URL}","identifier":8525,"steamId":1091500}</script>
</html>`;

const LIVE_PAGE_FRAGMENT = `<title>Cyberpunk 2077 Reviews - OpenCritic</title>
  <meta name="description" content="Cyberpunk 2077 review details truncated...">
  <meta property="og:description" content="OpenCritic score 76, Strong, 230 reviews, 66% recommended">
  <script type="application/ld+json">{"@type":"VideoGame","url":"/game/8525/cyberpunk-2077","name":"Cyberpunk 2077","gamePlatform":["PC","Google Stadia","Xbox Series X/S"],"aggregateRating":{"ratingValue":76,"reviewCount":230}}</script>
  <img src="//img.opencritic.com/mighty-man/strong-man.png" alt="Strong">`;

function expectSuccess(result: OpenCriticParseResult): CriticRecord {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result.record;
}

describe("OpenCritic public aggregate source", () => {
  test("prefers embedded structured aggregate values and preserves mixed platforms", () => {
    const record = expectSuccess(
      parseOpenCriticAggregate(EMBEDDED_PAGE, SOURCE_URL, {
        title: "Cyberpunk 2077",
        slug: "cyberpunk-2077",
        providerGameId: 8525,
        steamAppId: 1091500,
      }),
    );

    expect(record).toMatchObject({
      source: "opencritic",
      sourceId: "8525",
      steamAppId: 1091500,
      title: "Cyberpunk 2077",
      slug: "cyberpunk-2077",
      score: 76,
      tier: "Strong",
      reviewCount: 230,
      percentRecommended: 66,
      collectionBasis: "public_page",
      cadence: "monthly",
      identityVerified: true,
      matchedIdentity: {
        steamAppId: 1091500,
        platformScope: "mixed",
        edition: "",
        evidence: "canonical_url",
      },
    });
    expect(record.platforms).toEqual(["PC", "PlayStation 5", "Xbox Series X|S"]);
    expect(record.platformScope).toBe("mixed");
    expect(record.reviewPeriodStart).toBeNull();
    expect(record.reviewPeriodEnd).toBeNull();
    expect(record.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("accepts the live JSON-LD aggregate without claiming a Steam crosslink", () => {
    const record = expectSuccess(parseOpenCriticAggregate(LIVE_PAGE_FRAGMENT, SOURCE_URL, {
      title: "Cyberpunk 2077",
      steamAppId: 1091500,
    }));

    expect(record.score).toBe(76);
    expect(record.tier).toBe("Strong");
    expect(record.reviewCount).toBe(230);
    expect(record.percentRecommended).toBe(66);
    expect(record.platforms).toEqual(["PC", "Google Stadia", "Xbox Series X/S"]);
    expect(record.platformScope).toBe("mixed");
    expect(record.identityVerified).toBe(false);
    expect(record.matchedIdentity).toBeNull();
  });

  test("returns null for unsupported aggregate fields instead of inventing zeroes or dates", () => {
    const record = expectSuccess(parseOpenCriticAggregate(MISSING_FIELDS_PAGE, SOURCE_URL, { steamAppId: 1091500 }));

    expect(record.sourceId).toBe("8525");
    expect(record.title).toBe("Cyberpunk 2077");
    expect(record.steamAppId).toBe(1091500);
    expect(record.platforms).toEqual([]);
    expect(record.platformScope).toBe("mixed");
    expect(record.score).toBeNull();
    expect(record.tier).toBeNull();
    expect(record.reviewCount).toBeNull();
    expect(record.percentRecommended).toBeNull();
    expect(record.reviewPeriodStart).toBeNull();
    expect(record.reviewPeriodEnd).toBeNull();
  });

  test("rejects a page whose verified identity does not match", () => {
    const wrongTitle = parseOpenCriticAggregate(EMBEDDED_PAGE, SOURCE_URL, { title: "Other Game" });
    expect(wrongTitle.ok).toBe(false);
    if (!wrongTitle.ok) expect(wrongTitle.failure.error).toBe("identity_mismatch");

    const wrongCanonical = parseOpenCriticAggregate(
      EMBEDDED_PAGE.replace(SOURCE_URL, "https://opencritic.com/game/1/other-game"),
      SOURCE_URL,
    );
    expect(wrongCanonical.ok).toBe(false);
    if (!wrongCanonical.ok) expect(wrongCanonical.failure.error).toBe("identity_mismatch");
  });

  test("uses an injected fetch once and stops on ordinary errors or 429", async () => {
    let calls = 0;
    const success = await fetchOpenCriticAggregate({
      sourceUrl: SOURCE_URL,
      expected: { providerGameId: 8525, steamAppId: 1091500 },
      fetch: async () => {
        calls += 1;
        return new Response(EMBEDDED_PAGE, { status: 200 });
      },
    });
    expect(success.status).toBe("ok");
    if (success.status !== "ok") throw new Error(success.error);
    expect(calls).toBe(1);

    calls = 0;
    const rateLimited = await fetchOpenCriticAggregate({
      sourceUrl: SOURCE_URL,
      expected: { steamAppId: 1091500 },
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 429, headers: { "retry-after": "30" } });
      },
    });
    expect(rateLimited.status).toBe("rate_limited");
    if (rateLimited.status === "rate_limited") expect(rateLimited.httpStatus).toBe(429);
    expect(calls).toBe(1);

    const ordinaryError = await fetchOpenCriticAggregate({
      sourceUrl: SOURCE_URL,
      expected: { steamAppId: 1091500 },
      fetch: async () => new Response("", { status: 503 }),
    });
    expect(ordinaryError.status).toBe("error");
    if (ordinaryError.status === "error") expect(ordinaryError.httpStatus).toBe(503);
  });

  test("rejects SSRF targets and reports network failures without retrying", async () => {
    const invalidUrl = await fetchOpenCriticAggregate({ sourceUrl: "https://example.com/game/8525/cyberpunk-2077", expected: { steamAppId: 1091500 } });
    expect(invalidUrl.status).toBe("missing");
    if (invalidUrl.status === "missing") expect(invalidUrl.httpStatus).toBeNull();

    let calls = 0;
    const failed = await fetchOpenCriticAggregate({
      sourceUrl: SOURCE_URL,
      expected: { steamAppId: 1091500 },
      fetch: async () => {
        calls += 1;
        throw new Error("connection refused");
      },
    });
    expect(failed.status).toBe("error");
    if (failed.status === "error") expect(failed.httpStatus).toBeNull();
    expect(calls).toBe(1);
  });
});
