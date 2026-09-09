import { describe, expect, it } from "bun:test";
import {
  fetchMetacriticAggregate,
  parseMetacriticAggregate,
  type MetacriticExpectedIdentity,
} from "../workers/metacritic-source";

const expectedObservedAt = "2026-09-08T00:00:00.000Z";
const expected: MetacriticExpectedIdentity = {
  title: "Cyberpunk 2077",
  steamAppId: 1091500,
  observedAt: expectedObservedAt,
};

const sourceUrl = "https://www.metacritic.com/game/cyberpunk-2077/critic-reviews/?platform=pc";

const aggregatePage = `
  <html>
    <head>
      <title>Cyberpunk 2077 for PC Reviews - Metacritic</title>
      <script type="application/ld+json">
        {"@type":"VideoGame","name":"Cyberpunk 2077","aggregateRating":{"@type":"AggregateRating","name":"Metascore","ratingValue":86,"ratingCount":106}}
      </script>
    </head>
    <body>
      <h1>Cyberpunk 2077</h1>
      <div>Metascore <strong>86</strong></div>
      <div>Showing 106 Critic Reviews</div>
      <article>A visible critic review excerpt is not aggregate evidence.</article>
    </body>
  </html>
`;

describe("Metacritic public aggregate source", () => {
  it("parses the PC Metascore and aggregate critic count", () => {
    const record = parseMetacriticAggregate(aggregatePage, sourceUrl, { ...expected, releaseYear: 2020 });

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      source: "metacritic",
      sourceUrl,
      sourceId: "cyberpunk-2077",
      steamAppId: 1091500,
      title: "Cyberpunk 2077",
      platformScope: "pc",
      platforms: ["pc"],
      score: 86,
      reviewCount: 106,
      reviewPeriodStart: null,
      reviewPeriodEnd: null,
      collectionBasis: "public_page",
      edition: "",
      identityVerified: true,
    });
    expect(record?.observedAt).toBe(expectedObservedAt);
    expect(record?.matchedIdentity).toEqual({
      steamAppId: 1091500,
      platformScope: "pc",
      edition: "",
      evidence: expect.any(String),
    });
  });

  it("rejects a known conflicting release year", () => {
    const html = aggregatePage.replace('"@type":"VideoGame"', '"@type":"VideoGame","releaseYear":2021');
    expect(parseMetacriticAggregate(html, sourceUrl, { ...expected, releaseYear: 2020 })).toBeNull();
  });

  it("reads the source-owned score-card attribute before the per-review list", () => {
    const liveFragment = `
      <title>Cyberpunk 2077 critic reviews - Metacritic</title>
      <div class="score-card-left__score">
        <div class="c-siteReviewScore c-siteReviewScore_green" title="Metascore 86 out of 100" aria-label="Metascore 86 out of 100"><span>86</span></div>
        <span class="score-card-left__score-title">Metascore</span>
      </div>
      <div class="product-reviews-list">
        <div class="count">Showing 106 Critic Reviews</div>
        <div class="review-card"><div title="Metascore 100 out of 100"><span>100</span></div></div>
      </div>
    `;

    const record = parseMetacriticAggregate(liveFragment, sourceUrl, expected);

    expect(record?.score).toBe(86);
    expect(record?.reviewCount).toBe(106);
  });

  it("keeps explicitly supported aggregate review dates but ignores page metadata and visible review dates", () => {
    const html = `
      <title>Cyberpunk 2077 - Metacritic</title>
      <script type="application/json">
        {"title":"Cyberpunk 2077","platform":"PC","criticScore":86,"criticReviewCount":106,"firstReviewDate":"2020-12-10","latestReviewDate":"2021-02-01","dateModified":"2026-09-07","reviewDate":"2026-09-06"}
      </script>
      <div>Showing 106 Critic Reviews</div>
    `;

    const record = parseMetacriticAggregate(html, sourceUrl, expected);

    expect(record?.score).toBe(86);
    expect(record?.reviewCount).toBe(106);
    expect(record?.reviewPeriodStart).toBe("2020-12-10");
    expect(record?.reviewPeriodEnd).toBe("2021-02-01");
    expect(record?.observedAt).toBe(expectedObservedAt);
  });

  it("rejects absent or malformed aggregate evidence", () => {
    expect(
      parseMetacriticAggregate(
        '<title>Cyberpunk 2077 - Metacritic</title><div>User score 9.1</div>',
        sourceUrl,
        expected
      )
    ).toBeNull();
    expect(
      parseMetacriticAggregate(
        '<title>Cyberpunk 2077 - Metacritic</title><div>Metascore 101</div><div>Showing n/a Critic Reviews</div>',
        sourceUrl,
        expected
      )
    ).toBeNull();
    expect(
      parseMetacriticAggregate(
        '<title>Cyberpunk 2077 - Metacritic</title><script type="application/json">{"title":"Cyberpunk 2077","platform":"PC","criticScore":false,"criticReviewCount":true}</script>',
        sourceUrl,
        expected
      )
    ).toBeNull();
  });

  it("rejects console URLs and structured console-only aggregates", () => {
    expect(
      parseMetacriticAggregate(aggregatePage, sourceUrl.replace("platform=pc", "platform=ps5"), expected)
    ).toBeNull();

    const consolePage = `
      <title>Cyberpunk 2077 - Metacritic</title>
      <script type="application/json">
        {"title":"Cyberpunk 2077","platform":"PlayStation 5","criticScore":89,"criticReviewCount":80}
      </script>
    `;
    expect(parseMetacriticAggregate(consolePage, sourceUrl, expected)).toBeNull();
  });

  it("rejects a page whose title does not match the trusted Steam reference", () => {
    expect(
      parseMetacriticAggregate(
        aggregatePage.replace("Cyberpunk 2077", "Cyberpunk 2078"),
        sourceUrl,
        expected
      )
    ).toBeNull();
  });

  it("fetches one safe critic page derived from the Steam Metacritic URL", async () => {
    const requested: string[] = [];
    const result = await fetchMetacriticAggregate(
      { ...expected, metacriticUrl: "https://www.metacritic.com/game/pc/cyberpunk-2077?ftag=steam" },
      (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return new Response(aggregatePage, { status: 200 });
      }) as unknown as typeof fetch
    );

    expect(requested).toEqual([sourceUrl]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected aggregate success");
    expect(result.record.score).toBe(86);
  });

  it("does not request unsafe URLs and stops on 429 without retrying", async () => {
    let calls = 0;
    const unsafe = await fetchMetacriticAggregate(
      { ...expected, metacriticUrl: "https://backend.metacritic.com/games/metacritic/cyberpunk-2077" },
      (async () => {
        calls += 1;
        return new Response(aggregatePage);
      }) as unknown as typeof fetch
    );
    expect(unsafe.status).toBe("missing");
    expect(calls).toBe(0);

    const limited = await fetchMetacriticAggregate(
      { ...expected, metacriticUrl: sourceUrl },
      (async () => {
        calls += 1;
        return new Response("slow down", { status: 429 });
      }) as unknown as typeof fetch
    );
    expect(limited.status).toBe("rate_limited");
    if (limited.status !== "rate_limited") throw new Error("expected rate limit");
    expect(limited.httpStatus).toBe(429);
    expect(calls).toBe(1);
  });

  it("rejects a redirect that changes the Metacritic game identity", async () => {
    const redirected = new Response(aggregatePage, { status: 200 });
    Object.defineProperty(redirected, "url", {
      value: "https://www.metacritic.com/game/another-game/critic-reviews/?platform=pc",
    });

    const result = await fetchMetacriticAggregate(
      { ...expected, metacriticUrl: sourceUrl },
      (async () => redirected) as unknown as typeof fetch
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected redirect error");
    expect(result.error).toContain("identity");
  });
});
