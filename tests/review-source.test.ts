import { describe, expect, it } from "bun:test";
import {
  fetchSteamReviewHistogram,
  fetchSteamReviewSummary,
  type ReviewSourceOptions,
} from "../workers/review-source";

const observedAt = "2026-09-07T12:00:00.000Z";
const epoch = (value: string) => Math.floor(Date.parse(value) / 1000);

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function summaryBody(): unknown {
  return {
    success: 1,
    reviews: [{ recommendationid: "never-retained" }],
    query_summary: {
      num_reviews: 18,
      review_score: 8,
      review_score_desc: "Very Positive",
      total_positive: 80,
      total_negative: 20,
      total_reviews: 100,
    },
  };
}

function histogramBody(): unknown {
  return {
    success: 1,
    count_all_reviews: false,
    expand_graph: true,
    results: {
      start_date: epoch("2026-01-01T00:00:00.000Z"),
      end_date: epoch("2026-09-07T00:00:00.000Z"),
      rollup_type: "month",
      recent: [
        { date: epoch("2026-09-06T00:00:00.000Z"), recommendations_up: 4, recommendations_down: 1 },
        { date: epoch("2026-09-07T00:00:00.000Z"), recommendations_up: 7, recommendations_down: 2 },
      ],
      weeks: [],
      rollups: [
        { date: epoch("2026-08-01T00:00:00.000Z"), recommendations_up: 40, recommendations_down: 10 },
        { date: epoch("2026-09-01T00:00:00.000Z"), recommendations_up: 2, recommendations_down: 1 },
      ],
    },
    past_events: [{ type: 77, start_date: epoch("2026-08-01T00:00:00.000Z"), end_date: epoch("2026-08-03T00:00:00.000Z") }],
  };
}

describe("Steam aggregate review sources", () => {
  it("requests only query_summary with explicit population provenance", async () => {
    let requestedUrl = "";
    const customFetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return response(summaryBody(), 200, { date: "Wed, 01 Jan 2099 00:00:00 GMT" });
    }) as unknown as typeof fetch;

    const result = await fetchSteamReviewSummary(440, {
      customFetch,
      observedAt,
      filter: "all",
      language: "all",
      purchaseType: "all",
      dayRange: 30,
      filterOfftopicActivity: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(requestedUrl);
    expect(url.searchParams.get("num_per_page")).toBe("0");
    expect(url.searchParams.get("filter_offtopic_activity")).toBe("1");
    expect(url.searchParams.get("purchase_type")).toBe("all");
    expect(result.value.lifetimeTotalCount).toBe(100);
    expect(result.value.provenance.interpretationVersion).toBe("steam-review-source-v1");
    expect(result.value.provenance.identityKey).toContain("purchase_type=all");
    expect(result.value.provenance.endpoint).toBe("appreviews");
    expect(result.value.sourceId).toBe(result.value.provenance.identityKey);
    expect(result.value.observedAt).toBe(observedAt);
    expect("reviews" in result.value).toBe(false);
  });


  it("normalizes completed UTC day/month intervals and keeps open intervals separate", async () => {
    const options: ReviewSourceOptions = { customFetch: (async () => response(histogramBody())) as unknown as typeof fetch, observedAt };
    const result = await fetchSteamReviewHistogram(440, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets.map((bucket) => [bucket.granularity, bucket.periodStart])).toEqual([
      ["day", "2026-09-06T00:00:00.000Z"],
      ["month", "2026-08-01T00:00:00.000Z"],
    ]);
    expect(result.value.openBuckets.map((bucket) => bucket.periodStart)).toEqual([
      "2026-09-07T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    expect(result.value.buckets[1]?.periodEnd).toBe("2026-09-01T00:00:00.000Z");
    expect(result.value.events[0]?.type).toBe(77);
    expect(result.value.provenance.requestFilter).toBe("none");
    expect(result.value.provenance.population).toBe("filtered_reviews");
    expect(result.value.provenance.endpoint).toBe("appreviewhistogram");
    expect(result.value.sourceId).toBe(result.value.provenance.identityKey);
    expect(result.value.buckets[0]?.sourceId).toBe(result.value.provenance.identityKey);
  });

  it("keeps histogram identities stable across field order but changes semantic populations", async () => {
    const firstBody = histogramBody() as Record<string, unknown>;
    const reorderedBody = {
      past_events: firstBody.past_events,
      results: firstBody.results,
      expand_graph: firstBody.expand_graph,
      count_all_reviews: firstBody.count_all_reviews,
      success: firstBody.success,
    };
    const first = await fetchSteamReviewHistogram(440, {
      customFetch: (async () => response(firstBody)) as unknown as typeof fetch,
      observedAt,
    });
    const reordered = await fetchSteamReviewHistogram(440, {
      customFetch: (async () => response(reorderedBody)) as unknown as typeof fetch,
      observedAt,
    });
    expect(first.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(reordered.value.provenance.identityKey).toBe(first.value.provenance.identityKey);
    expect(reordered.value.sourceId).toBe(reordered.value.provenance.identityKey);

    const changedBody = histogramBody() as Record<string, unknown>;
    changedBody.count_all_reviews = true;
    const changed = await fetchSteamReviewHistogram(440, {
      customFetch: (async () => response(changedBody)) as unknown as typeof fetch,
      observedAt,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.provenance.identityKey).not.toBe(first.value.provenance.identityKey);
  });

  it("rejects inconsistent aggregate totals without unsafe integer summation", async () => {
    const body = summaryBody() as Record<string, unknown>;
    const summary = body.query_summary as Record<string, unknown>;
    summary.total_positive = Number.MAX_SAFE_INTEGER;
    summary.total_negative = 1;
    summary.total_reviews = Number.MAX_SAFE_INTEGER;
    const result = await fetchSteamReviewSummary(440, {
      customFetch: (async () => response(body)) as unknown as typeof fetch,
      observedAt,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("Steam review summary counts are inconsistent");
    expect(result.observedAt).toBe(observedAt);
  });

  it("fails before fetching when observedAt is invalid", async () => {
    let calls = 0;
    const result = await fetchSteamReviewSummary(440, {
      observedAt: "not-a-date",
      customFetch: (async () => {
        calls += 1;
        return response(summaryBody());
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("Invalid observedAt");
    expect(result.observedAt).toBeNull();
    expect(calls).toBe(0);
  });

  it("preserves unknown histogram flags and does not invent boundaries", async () => {
    const body = histogramBody() as Record<string, unknown>;
    const results = body.results as Record<string, unknown>;
    results.recent = [{ date: epoch("2026-09-06T03:00:00.000Z"), recommendations_up: 1, recommendations_down: 1 }];
    results.weeks = [];
    results.rollups = [];
    delete body.count_all_reviews;
    body.future_flag = "keep-observed-for-review";
    const result = await fetchSteamReviewHistogram(440, {
      customFetch: (async () => response(body)) as unknown as typeof fetch,
      observedAt,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets).toHaveLength(0);
    expect(result.value.unknownBuckets).toHaveLength(1);
    expect(result.value.provenance.population).toBe("unknown");
    expect(result.value.unknownFlags.count_all_reviews).toBeNull();
  });

  it("returns ordinary failures for invalid JSON and schema drift without retrying", async () => {
    let calls = 0;
    const invalidJson = (async () => {
      calls += 1;
      return new Response("not-json", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchSteamReviewSummary(440, { customFetch: invalidJson, observedAt });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("failure");
    expect(result.rateLimited).toBe(false);
    expect(calls).toBe(1);

    const schemaDrift = await fetchSteamReviewSummary(440, {
      customFetch: (async () => response({ success: 1, query_summary: { total_positive: "80" } })) as unknown as typeof fetch,
      observedAt,
    });
    expect(schemaDrift.ok).toBe(false);
    if (schemaDrift.ok) return;
    expect(schemaDrift.outcome).toBe("failure");
  });
});
