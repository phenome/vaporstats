import { describe, expect, test } from "bun:test";
import {
  classifyCriticRecord,
  classifyPlayerScore,
  compareCriticSources,
  evaluateCriticAlignment,
  getCriticFreshness,
  normalizeCriticRecord,
  normalizeSteamMetacriticReference,
  type CriticRecord,
  type CriticComparisonContext,
  type RetainedPlayerSnapshot,
} from "../src/lib/critics";

const reviewTimeSnapshot: RetainedPlayerSnapshot = {
  score: 72,
  reviewCount: 80,
  observedAt: "2024-01-20T12:00:00Z",
  source: "steam-histogram",
  population: "all",
};

function makeRecord(overrides: Partial<CriticRecord> = {}): CriticRecord {
  return {
    source: "metacritic",
    sourceUrl: "https://www.metacritic.com/game/example/",
    sourceId: "example",
    steamAppId: 10,
    title: "Example",
    slug: "example",
    edition: "base",
    platforms: ["PC"],
    platformScope: "pc",
    score: 86,
    tier: null,
    reviewCount: 106,
    percentRecommended: null,
    reviewPeriodStart: "2024-01-01",
    reviewPeriodEnd: "2024-01-31",
    observedAt: "2026-09-01T00:00:00Z",
    collectionBasis: "public_page",
    matchedIdentity: {
      steamAppId: 10,
      platformScope: "pc",
      edition: "base",
      evidence: "Steam-linked PC page",
    },
    identityVerified: true,
    cadence: "weekly",
    ...overrides,
  };
}

function makeContext(overrides: Partial<CriticComparisonContext> = {}): CriticComparisonContext {
  return {
    steamAppId: 10,
    currentPlayer: { score: 72, reviewCount: 80, observedAt: "2026-09-07T00:00:00Z" },
    retainedPlayerSnapshots: [reviewTimeSnapshot],
    asOf: "2026-09-08T00:00:00Z",
    ...overrides,
  };
}

describe("source-native critic categories", () => {
  test("uses full precision at player and Metacritic boundaries", () => {
    expect(classifyPlayerScore(39.999999)).toBe("unfavorable");
    expect(classifyPlayerScore(40)).toBe("mixed");
    expect(classifyPlayerScore(69.999999)).toBe("mixed");
    expect(classifyPlayerScore(70)).toBe("favorable");

    expect(classifyCriticRecord(makeRecord({ score: 49.999999 }))).toBe("unfavorable");
    expect(classifyCriticRecord(makeRecord({ score: 50 }))).toBe("mixed");
    expect(classifyCriticRecord(makeRecord({ score: 74.999999 }))).toBe("mixed");
    expect(classifyCriticRecord(makeRecord({ score: 75 }))).toBe("favorable");
  });

  test("uses OpenCritic's native tier rather than converting its score", () => {
    expect(
      classifyCriticRecord(
        makeRecord({
          source: "opencritic",
          score: 100,
          tier: "Weak",
        }),
      ),
    ).toBe("unfavorable");
    expect(classifyCriticRecord(makeRecord({ source: "opencritic", score: null, tier: "Fair" }))).toBe("mixed");
    expect(classifyCriticRecord(makeRecord({ source: "opencritic", score: 76, tier: "Strong" }))).toBe("favorable");
    expect(classifyCriticRecord(makeRecord({ source: "opencritic", score: null, tier: null }))).toBeNull();
    expect(classifyCriticRecord(makeRecord({ source: "opencritic", score: 88, tier: null }))).toBe("favorable");
  });

  test("normalizes blank and -1 provider values to absent values", () => {
    const record = normalizeCriticRecord({
      ...makeRecord(),
      score: -1,
      reviewCount: -1,
      percentRecommended: "",
      reviewPeriodStart: "",
      reviewPeriodEnd: "not-a-date",
      observedAt: "",
    });
    expect(record).not.toBeNull();
    expect(record?.score).toBeNull();
    expect(record?.reviewCount).toBeNull();
    expect(record?.percentRecommended).toBeNull();
    expect(record?.reviewPeriodStart).toBeNull();
    expect(record?.reviewPeriodEnd).toBeNull();
    expect(record?.observedAt).toBeNull();
  });

  test("rejects coercible non-numeric provider values", () => {
    const record = normalizeCriticRecord({
      ...makeRecord(),
      score: false,
      reviewCount: true,
      percentRecommended: [],
    });
    expect(record).not.toBeNull();
    expect(record?.score).toBeNull();
    expect(record?.reviewCount).toBeNull();
    expect(record?.percentRecommended).toBeNull();
  });
});

describe("critic identity and evidence gates", () => {
  test("accepts public-page critic evidence when exact PC edition identity is verified", () => {
    const record = normalizeCriticRecord(makeRecord());
    expect(record).not.toBeNull();
    expect(record && evaluateCriticAlignment(record, makeContext()).state).toBe("classified");
  });

  test("does not classify critic evidence when collection basis is unavailable", () => {
    const record = makeRecord({ collectionBasis: "unavailable" });
    const outcome = evaluateCriticAlignment(record, makeContext());

    expect(outcome.state).toBe("unavailable");
    expect(outcome.alignment).toBeNull();
    expect(outcome.currentContrast.state).toBe("unavailable");
    expect(outcome.currentContrast.alignment).toBeNull();
    expect(outcome.reasons).toContain("permission_missing");
    expect(outcome.currentContrast.reasons).toContain("permission_missing");
    expect(outcome.reasons).not.toContain("critic_metric_missing");
    expect(outcome.currentContrast.reasons).not.toContain("critic_metric_missing");
  });

  test("reports missing metrics when calibration cannot classify", () => {
    const outcome = evaluateCriticAlignment(makeRecord({ score: null }), makeContext());
    expect(outcome.state).toBe("unavailable");
    expect(outcome.currentContrast.state).toBe("unavailable");
    expect(outcome.reasons).toContain("critic_metric_missing");
    expect(outcome.currentContrast.reasons).toContain("critic_metric_missing");
  });

  test("accepts a mixed-platform OpenCritic aggregate", () => {
    const record = makeRecord({
      source: "opencritic",
      score: 76,
      tier: "Strong",
      platformScope: "mixed",
      platforms: ["PC", "PlayStation 5", "Xbox Series"],
      matchedIdentity: {
        steamAppId: 10,
        platformScope: "mixed",
        edition: "base",
        evidence: "mixed provider page",
      },
    });
    const outcome = evaluateCriticAlignment(record, makeContext());
    expect(outcome.state).toBe("classified");
    expect(outcome.alignment).toBe("broadly_aligned");
    expect(outcome.reasons).not.toContain("platform_not_pc");
  });

  test("requires at least 20 player and 5 critic reviews", () => {
    const tooFewCritics = evaluateCriticAlignment(makeRecord({ reviewCount: 4 }), makeContext());
    expect(tooFewCritics.state).toBe("unavailable");
    expect(tooFewCritics.reasons).toContain("critic_reviews_insufficient");

    const tooFewPlayers = evaluateCriticAlignment(
      makeRecord(),
      makeContext({
        retainedPlayerSnapshots: [{ ...reviewTimeSnapshot, reviewCount: 19 }],
      }),
    );
    expect(tooFewPlayers.state).toBe("unavailable");
    expect(tooFewPlayers.reasons).toContain("player_reviews_insufficient");
  });
});

describe("review-time and current comparisons", () => {
  test("uses an actual retained snapshot inside the source review period", () => {
    const outcome = evaluateCriticAlignment(makeRecord(), makeContext());
    expect(outcome.state).toBe("classified");
    expect(outcome.evidence.reviewTimePlayerSnapshot).toEqual(reviewTimeSnapshot);
    expect(outcome.alignment).toBe("broadly_aligned");
  });

  test("does not fabricate a historical snapshot from the current score", () => {
    const outcome = evaluateCriticAlignment(
      makeRecord(),
      makeContext({
        currentPlayer: { score: 72, reviewCount: 80, observedAt: "2026-09-08T00:00:00Z" },
        retainedPlayerSnapshots: [],
      }),
    );
    expect(outcome.state).toBe("unavailable");
    expect(outcome.evidence.reviewTimePlayerSnapshot).toBeNull();
    expect(outcome.reasons).toContain("player_snapshot_missing");
    expect(outcome.currentContrast.state).toBe("classified");
    expect(outcome.currentContrast.alignment).toBe("broadly_aligned");
  });

  test("keeps current contrast separate from primary review-time alignment", () => {
    const outcome = evaluateCriticAlignment(
      makeRecord(),
      makeContext({
        currentPlayer: { score: 30, reviewCount: 80 },
        retainedPlayerSnapshots: [reviewTimeSnapshot],
      }),
    );
    expect(outcome.state).toBe("classified");
    expect(outcome.alignment).toBe("broadly_aligned");
    expect(outcome.currentContrast.alignment).toBe("clearly_divergent");
  });

  test("uses review publication dates only for review-time matching, not freshness", () => {
    const outcome = evaluateCriticAlignment(
      makeRecord({
        reviewPeriodStart: "2019-01-01",
        reviewPeriodEnd: "2019-01-31",
        observedAt: "2026-09-01T00:00:00Z",
      }),
      makeContext({
        retainedPlayerSnapshots: [{ ...reviewTimeSnapshot, observedAt: "2019-01-20T12:00:00Z" }],
      }),
    );
    expect(outcome.state).toBe("classified");
    expect(outcome.freshness.state).toBe("fresh");
  });

  test("suppresses labels after retrieval freshness cutoff while retaining evidence", () => {
    const weeklyAtCutoff = makeRecord({ observedAt: "2026-08-25T00:00:00Z", cadence: "weekly" });
    expect(getCriticFreshness(weeklyAtCutoff, "2026-09-08T00:00:00Z").state).toBe("fresh");
    expect(
      evaluateCriticAlignment(makeRecord({ observedAt: "2026-08-24T23:59:59Z" }), makeContext()).state,
    ).toBe("unavailable");
    expect(
      evaluateCriticAlignment(makeRecord({ observedAt: "2026-07-10T00:00:00Z", cadence: "monthly" }), makeContext()).state,
    ).toBe("classified");
    expect(
      evaluateCriticAlignment(makeRecord({ observedAt: "2026-07-09T23:59:59Z", cadence: "monthly" }), makeContext()).state,
    ).toBe("unavailable");
  });
});

describe("source-specific conclusions", () => {
  test("keeps Metacritic and OpenCritic outcomes separate when directions differ", () => {
    const metacritic = makeRecord({ source: "metacritic", score: 86, tier: null });
    const opencritic = makeRecord({
      source: "opencritic",
      sourceId: "opencritic-example",
      sourceUrl: "https://opencritic.com/game/example",
      score: 76,
      tier: "Weak",
    });
    const result = compareCriticSources([metacritic, opencritic], makeContext());
    expect(result.outcomes.map((outcome) => outcome.source)).toEqual(["metacritic", "opencritic"]);
    expect(result.outcomes.every((outcome) => outcome.state === "classified")).toBe(true);
    expect(result.sourcesDiffer).toBe(true);
    expect(result.combinedConclusion).toBeNull();
    expect(result.reasons).toContain("critic_sources_differ");
  });
});

describe("Steam attribution", () => {
  test("keeps a Steam-provided Metacritic score displayable but ineligible for alignment", () => {
    const reference = normalizeSteamMetacriticReference({
      source: "steam",
      provider: "metacritic",
      steamAppId: 10,
      score: 86,
      url: "https://www.metacritic.com/game/example/",
    });
    expect(reference).toEqual({
      source: "steam",
      provider: "metacritic",
      steamAppId: 10,
      score: 86,
      url: "https://www.metacritic.com/game/example/",
    });
    expect(normalizeCriticRecord(reference)).toBeNull();
    expect(
      normalizeSteamMetacriticReference({ steamAppId: 10, score: -1, url: "https://www.metacritic.com/game/example/" }),
    ).toBeNull();
  });
});
