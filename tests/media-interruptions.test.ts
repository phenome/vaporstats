import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { previewDailyAttemptShare } from "../src/lib/media-outlet-access";
import {
  BALDURS_GATE,
  GAME_NAMES,
  type MediaWorld,
  CYBERPUNK,
  controlledTavilyApi,
  discoveryArticleHtml,
  experimentWorld,
  outletFixtureUrl,
  HADES_II,
  PROCESSING_FETCH_RESENT_AFTER_RESTART,
  seedApps,
  sweepInterruptions,
  THROWING_ITEM_RETRY,
  throwingResponse,
  UNCERTAIN_PAID_RESEND,
  type InterruptionInvariants,
  type InterruptionScenario,
  type OutboundKind,
} from "./support/media";

// Restart and Outlet day stop sweeps at the ingestion-tick seam. Each run
// copies one migrated template database and uses controlled providers and
// outlets; nothing reaches a real provider. A scenario with a known defect is
// registered with `knownFailure` and runs as `test.failing`, so it reports
// once fixed.

const EXPERIMENT = [BALDURS_GATE, CYBERPUNK, HADES_II];
const at = (time: string, day = "2026-11-20") => `${day}T${time}:00.000Z`;
const EVERY_KIND: readonly OutboundKind[] = ["search", "outlet_fetch", "openrouter", "gemini_submit"];
const FIRST_DAY = [at("06:00"), at("06:15")];

/** Attempts IGN already used on 2026-11-20 in the near-cap scenario, before its first tick. */
const IGN_ATTEMPTS_USED = 25;

function seedNearIgnCap(native: Database): void {
  seedApps(native, EXPERIMENT);
  const insert = native.prepare("INSERT INTO media_discovery_attempts (appid, outlet, pass, day, kind, url, status_code, succeeded, attempted_at) VALUES (?, 'IGN', 'initial', '2026-11-20', 'fetch', ?, 200, 1, '2026-11-20T01:00:00.000Z')");
  for (let index = 0; index < IGN_ATTEMPTS_USED; index += 1) insert.run(CYBERPUNK, `https://ign.com/articles/earlier-${index}`);
}

/**
 * `experimentWorld`, except that every extraction request for Cyberpunk
 * 2077's IGN review loses its connection after it was sent, so that item is
 * uncertain at every send and reaches the three-send limit.
 */
function lostAnswerWorld() {
  const world = experimentWorld();
  world.openRouter.onChat = (record) => {
    const messages = JSON.stringify(record.body.messages);
    if (record.stage === "extraction" && messages.includes("Cyberpunk 2077 offers") && messages.includes("as IGN's first assessment")) {
      world.openRouter.reply("chat", { network: "socket closed before the response" });
    }
  };
  return world;
}

/**
 * `experimentWorld`, except that handling Cyberpunk 2077's IGN review throws
 * whenever it is fetched for processing, as the 2026-11-18 incident's
 * articles did: its discovery fetch, the first, is answered normally.
 */
function throwingItemWorld() {
  const world = experimentWorld();
  const review = "https://ign.com/articles/1091500-ign-com";
  let fetches = 0;
  const outlet = world.outlet!;
  world.outlet = (url) => {
    if (url !== review) return outlet(url);
    fetches += 1;
    return fetches === 1 ? outlet(url) : throwingResponse("Cannot destructure property 'firstElementChild' from null or undefined value");
  };
  return world;
}

const NO_LAW = 2161710;

/** NO LAW watched before the swept day, beside Hades II, an experiment game whose initial pass is due the same day. */
function seedPreviewBesideAssessment(native: Database): void {
  seedApps(native, [HADES_II]);
  native.exec(`INSERT INTO apps (appid, name, slug, release_status) VALUES (${NO_LAW}, 'NO LAW', 'no-law', 'upcoming');
    INSERT INTO media_watches (appid, watched_at) VALUES (${NO_LAW}, '2026-11-19T10:00:00.000Z');
    INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (${NO_LAW}, 'watchlist', '2026-11-19T10:00:00.000Z')`);
}

/**
 * `experimentWorld` with NO LAW: each of its preview searches finds two patch
 * notes pages, which a preview refuses, before its preview. The search and
 * the two refused fetches use the outlet's preview share of 3, so the
 * preview waits for the next UTC day while Hades II's initial queries on
 * the same outlets are served.
 */
function previewShareWorld(): MediaWorld {
  const world = experimentWorld();
  const tavily = controlledTavilyApi({ ...GAME_NAMES, [NO_LAW]: "NO LAW" });
  const experiment = world.tavily.results!;
  const noLawUrl = (domain: string, name: string) => outletFixtureUrl(domain, `articles/${NO_LAW}-${name}`);
  tavily.results = (search) => search.appid === NO_LAW
    ? ["patch-1", "patch-2", "preview"].map((name) => ({ url: noLawUrl(search.domain, name) }))
    : experiment(search);
  const outlet = world.outlet!;
  return {
    ...world, tavily,
    outlet: (url) => {
      if (!url.includes(`/articles/${NO_LAW}-`)) return outlet(url);
      const { hostname, pathname } = new URL(url);
      const kind = pathname.slice(pathname.lastIndexOf("-") + 1);
      return new Response(discoveryArticleHtml(NO_LAW, kind === "preview" ? "NO LAW Preview" : "NO LAW Patch Notes", {
        body: `NO LAW coverage from ${hostname} describes a series of missions on a cargo ship with detailed systems. `.repeat(5) + `Builds reward experimentation. This page is ${pathname}.`,
        author: `${hostname} journalist`,
      }));
    },
  };
}

interface Registered {
  scenario: InterruptionScenario;
  invariants: InterruptionInvariants;
  /** Calls of each kind the uninterrupted run's swept ticks make, so a sweep never passes by sweeping nothing. */
  baseline: Record<OutboundKind, number>;
  /** Why this scenario currently breaks an invariant; it then runs as `test.failing`. */
  knownFailure?: string;
}

const SCENARIOS: Registered[] = [
  {
    scenario: {
      name: "watched preview occurrence",
      seed(native) {
        native.exec(`INSERT INTO apps (appid, name, slug, release_status) VALUES (2161710, 'NO LAW', 'no-law', 'upcoming');
          INSERT INTO media_watches (appid, watched_at) VALUES (2161710, '2026-11-19T10:00:00.000Z');
          INSERT INTO media_enrollments (appid, reason, enrolled_at) VALUES (2161710, 'watchlist', '2026-11-19T10:00:00.000Z')`);
      },
      world() {
        const world = experimentWorld();
        const tavily = controlledTavilyApi({ 2161710: "NO LAW" });
        tavily.results = ({ domain }) => [1, 2].map((n) => ({ url: outletFixtureUrl(domain, `articles/2161710-preview-${n}`) }));
        return {
          ...world, tavily,
          outlet: (url) => new Response(discoveryArticleHtml(2161710, "NO LAW Preview", {
            body: `NO LAW coverage from ${new URL(url).hostname} describes a playable campaign with detailed systems and a series of missions on a cargo ship. `.repeat(5) +
              `Builds reward experimentation. This report is edition ${new URL(url).pathname.at(-1)} of the coverage.`,
            author: `${new URL(url).hostname} journalist`,
          })),
        };
      },
      ticks: FIRST_DAY,
      days: 1,
    },
    invariants: { restarts: ["search", "outlet_fetch"], dayStops: true, combined: 2 },
    baseline: { search: 9, outlet_fetch: 18, openrouter: 10, gemini_submit: 1 },
  },
  {
    // NO LAW's preview occurrence goes first and meets each outlet's preview
    // share (3 of 30) on its search and two refused fetches; Hades II's
    // initial queries on the same outlets are served that day (6 searches,
    // 18 discovery and 6 processing fetches, 6 extractions, 1 Overview and
    // its embedding). The next UTC day reopens the previews, which admit
    // their third candidate. Restarts and day stops must keep the share.
    scenario: { name: "preview occurrence at its daily share beside an initial pass", seed: seedPreviewBesideAssessment, world: previewShareWorld, ticks: FIRST_DAY, days: 1 },
    invariants: { restarts: ["search", "outlet_fetch"], dayStops: true, combined: 2, sample: 10 },
    baseline: { search: 15, outlet_fetch: 42, openrouter: 7, gemini_submit: 1 },
  },
  {
    // The catalog learns about a release on the day its first pass is due.
    // Each search returns no articles. Restarting between outlets must
    // preserve served queries as well as the newly recorded enrollment.
    scenario: {
      name: "new release at seven days",
      seed(native) {
        native.exec("INSERT INTO checkpoints (key, value) VALUES ('media:enrollment-start-date', '2026-11-10')");
        native.exec(`INSERT INTO apps (appid, name, slug, release_status, steam_release_date)
          VALUES (10001, 'November release', 'november-release', 'released', '2026-11-13')`);
      },
      world() {
        const tavily = controlledTavilyApi({ 10001: "November release" });
        tavily.results = () => [];
        return { ...experimentWorld(), tavily };
      },
      ticks: FIRST_DAY,
      days: 1,
    },
    invariants: { restarts: ["search"] },
    baseline: { search: 6, outlet_fetch: 0, openrouter: 0, gemini_submit: 0 },
  },
  {
    // The first daily media run: 18 initial queries, three candidates each
    // (54 discovery fetches), 18 processing fetches, 18 extractions and 3
    // Overviews, 3 embeddings. The following day takes the later passes.
    scenario: { name: "initial pass", seed: (native) => seedApps(native, EXPERIMENT), world: experimentWorld, ticks: FIRST_DAY, days: 1 },
    invariants: { restarts: EVERY_KIND, dayStops: true, combined: 3 },
    baseline: { search: 18, outlet_fetch: 72, openrouter: 21, gemini_submit: 3 },
  },
  {
    // The next daily media run takes the experiment games' later passes: 18
    // later queries, three candidates each (54 discovery fetches), 18
    // processing fetches, 18 extractions and 3 new Overviews. The controlled
    // Overviews keep their similarity inputs, so no embedding is submitted
    // again. Its `before` ticks are the initial-pass scenario's swept ticks.
    scenario: { name: "later pass", seed: (native) => seedApps(native, EXPERIMENT), world: experimentWorld, before: FIRST_DAY, ticks: [at("06:00", "2026-11-21"), at("06:15", "2026-11-21")], days: 1 },
    invariants: { restarts: EVERY_KIND, dayStops: true, combined: 2 },
    baseline: { search: 18, outlet_fetch: 72, openrouter: 21, gemini_submit: 0 },
  },
  {
    // Discovery accepts every article while no paid request may be sent; the
    // queue then takes three items per provider a tick, so day stops fall
    // on processing fetches spread across ticks. Restarts during paid work
    // are swept by the initial-pass scenario.
    scenario: {
      name: "paid processing on both providers",
      seed: (native) => seedApps(native, EXPERIMENT),
      world: experimentWorld,
      before: [at("06:00")],
      beforeOptions: { paidSubmissionsPerTick: 0 },
      ticks: [at("06:15"), at("06:30"), at("06:45"), at("07:00"), at("07:15"), at("07:30"), at("07:45")],
      options: { paidSubmissionsPerTick: 3 },
      days: 1,
    },
    invariants: { dayStops: true, combined: 2 },
    baseline: { search: 0, outlet_fetch: 18, openrouter: 21, gemini_submit: 3 },
  },
  {
    // IGN has used 25 of its 30 attempts on 2026-11-20 before the first
    // daily media run. Its last 5 serve Baldur's Gate 3's search and three
    // candidate fetches and Cyberpunk 2077's search; the cap then holds
    // Cyberpunk 2077's IGN query, Hades II's (never searched) and Baldur's
    // Gate 3's IGN processing fetch until the next day. So the swept day
    // makes 17 searches, 48 discovery and 15 processing fetches, 15
    // extractions and the 2 Overviews whose games have no waiting extraction,
    // and their 2 embeddings. Restarts and day stops around the cap must keep it.
    scenario: { name: "near IGN's daily attempt cap", seed: seedNearIgnCap, world: experimentWorld, ticks: FIRST_DAY, days: 1 },
    invariants: { restarts: ["search", "outlet_fetch"], dayStops: true, combined: 2, sample: 12 },
    baseline: { search: 17, outlet_fetch: 63, openrouter: 17, gemini_submit: 2 },
  },
  {
    // The initial pass, but Cyberpunk 2077's IGN review never gets an answer:
    // its extraction is uncertain at every send, is resent with backoff, and
    // ends uncertain_exhausted at the three-send limit, the third send on the
    // following day. Cyberpunk 2077's Overview waits for it, so the swept day
    // makes 2 Overviews and 2 embeddings, 21 text requests (18 extractions,
    // the one resend that fell on that day, and 2 Overviews) and 73 outlet
    // fetches (the 72 of the initial pass and the resend's article fetch).
    scenario: { name: "an extraction whose answer is always lost", seed: (native) => seedApps(native, EXPERIMENT), world: lostAnswerWorld, ticks: FIRST_DAY, days: 1 },
    invariants: { restarts: ["openrouter"], sample: 8 },
    baseline: { search: 18, outlet_fetch: 73, openrouter: 21, gemini_submit: 2 },
  },
  {
    // The initial pass, but handling Cyberpunk 2077's IGN review throws at
    // every processing fetch (the incident of 2026-11-18). Each occurrence is
    // caught at the item's boundary and backs it off; the third, on the
    // following day, ends it client_error_exhausted. Cyberpunk 2077's
    // Overview waits for it, so the swept day makes 17 extractions, 2
    // Overviews and 2 embeddings, and 73 outlet fetches (the 72 of the
    // initial pass and one retry of the throwing item). Every tick completes
    // with no media error, and every other item progresses.
    scenario: { name: "an extraction whose handling always throws", seed: (native) => seedApps(native, EXPERIMENT), world: throwingItemWorld, ticks: FIRST_DAY, days: 1 },
    invariants: { restarts: ["outlet_fetch"], sample: 8 },
    baseline: { search: 18, outlet_fetch: 73, openrouter: 19, gemini_submit: 2 },
  },
];

describe("interruption sweeps", () => {
  test("a scenario's before ticks are ticks another registered scenario sweeps, since the sweep never interrupts them", () => {
    for (const { scenario } of SCENARIOS) {
      if (!scenario.before) continue;
      expect(SCENARIOS.some(({ scenario: other }) => other !== scenario && scenario.before!.every((tick) => other.ticks.includes(tick)))).toBe(true);
    }
  });

  for (const { scenario, invariants, baseline, knownFailure } of SCENARIOS) {
    const run = knownFailure ? test.failing : test;
    const faults = [invariants.restarts ? `a restart after any ${invariants.restarts.join(", ")} call` : null, invariants.dayStops ? "an Outlet day stop at any outlet fetch" : null, invariants.combined ? "both at once" : null].filter(Boolean).join(", ");
    run(`${scenario.name}: send once, one article per query, the daily attempt cap, reopening and extraction hold across ${faults}${knownFailure ? ` (known failure: ${knownFailure})` : ""}`, async () => {
      const report = await sweepInterruptions(scenario, invariants);
      expect(report.baseline).toEqual(baseline);
      expect(report.violations).toEqual([]);
      // A restart during a processing fetch resends it under the one named
      // exception, which shows the sweep observes resends at all.
      if (invariants.restarts?.includes("outlet_fetch") && baseline.openrouter > 0) {
        expect(report.resentUnderException.length).toBeGreaterThan(0);
        expect(report.resentUnderException.every((resend) => resend.includes(PROCESSING_FETCH_RESENT_AFTER_RESTART.name))).toBe(true);
      }
      // A restart during a paid request leaves it uncertain, and it is resent
      // under the uncertain-resend bound (#80): at most three sends per
      // identity, which shows the sweep observes paid resends at all.
      if (invariants.restarts?.some((kind) => kind === "openrouter" || kind === "gemini_submit") && baseline.openrouter > 0) {
        expect(report.resentAfterUncertain.some((resend) => resend.includes(" openrouter "))).toBe(true);
        expect(report.resentAfterUncertain.every((resend) => resend.includes(UNCERTAIN_PAID_RESEND.name))).toBe(true);
      }
      // An item whose handling throws is taken again under its backoff, so
      // the sweep observes its retries, never more than three fetches.
      if (scenario.world === throwingItemWorld) {
        expect(report.retriedAfterItemError.some((retry) => retry.includes(THROWING_ITEM_RETRY.name))).toBe(true);
      }
      if (invariants.restarts?.includes("gemini_submit") && baseline.gemini_submit > 0) {
        expect(report.resentAfterUncertain.some((resend) => resend.includes(" gemini_submit "))).toBe(true);
      }
      // Day stops hold queries, which shows the reopening check runs at all.
      if (invariants.dayStops && baseline.search > 0) expect(report.dayStoppedQueries).toBeGreaterThan(0);
      if (scenario.seed === seedNearIgnCap) expect(report.peakOutletDayAttempts).toBe(30);
      if (scenario.seed === seedPreviewBesideAssessment) expect(report.peakPreviewOutletDayCalls).toBe(previewDailyAttemptShare());
    }, 600_000);
  }
});
