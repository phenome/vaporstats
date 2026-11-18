import { describe, expect, test } from "bun:test";
import {
  BALDURS_GATE,
  CYBERPUNK,
  experimentWorld,
  HADES_II,
  PROCESSING_FETCH_RESENT_AFTER_RESTART,
  seedApps,
  sweepInterruptions,
  type InterruptionInvariants,
  type InterruptionScenario,
  type OutboundKind,
} from "./support/media";

// Restart and Outlet day stop sweeps at the ingestion-tick seam. Each run uses
// its own temporary SQLite file and controlled providers and outlets; nothing
// reaches a real provider. A scenario with a known defect is registered with
// `knownFailure` and runs as `test.failing`, so it reports once fixed.

const EXPERIMENT = [BALDURS_GATE, CYBERPUNK, HADES_II];
const at = (time: string, day = "2026-11-20") => `${day}T${time}:00.000Z`;
const EVERY_KIND: readonly OutboundKind[] = ["search", "outlet_fetch", "openrouter", "gemini_submit"];

interface Registered {
  scenario: InterruptionScenario;
  invariants: InterruptionInvariants;
  /** Calls of each kind the uninterrupted run makes, so a sweep never passes by sweeping nothing. */
  baseline: Record<OutboundKind, number>;
  /** Why this scenario currently breaks an invariant; it then runs as `test.failing`. */
  knownFailure?: string;
}

const SCENARIOS: Registered[] = [
  {
    // The first daily media run: 18 initial queries, 18 discovery and 18
    // processing fetches, 18 extractions and 3 Overviews, 3 embeddings.
    scenario: {
      name: "initial pass",
      seed: (native) => seedApps(native, EXPERIMENT),
      world: experimentWorld,
      ticks: [at("06:00"), at("06:15")],
    },
    invariants: { restarts: EVERY_KIND, dayStops: { days: 2 } },
    baseline: { search: 18, outlet_fetch: 72, openrouter: 21, gemini_submit: 3 },
  },
  {
    // The next daily media run takes the experiment games' later passes: 18
    // later queries, then their articles' extractions and new Overviews. The
    // controlled Overviews keep their similarity inputs, so no embedding is
    // submitted again.
    scenario: {
      name: "later pass",
      seed: (native) => seedApps(native, EXPERIMENT),
      world: experimentWorld,
      before: [at("06:00"), at("06:15")],
      ticks: [at("06:00", "2026-11-21"), at("06:15", "2026-11-21")],
    },
    invariants: { restarts: EVERY_KIND, dayStops: { days: 2 } },
    baseline: { search: 18, outlet_fetch: 72, openrouter: 21, gemini_submit: 0 },
  },
  {
    // Discovery accepts every article while no paid request may be sent;
    // the queue then takes three items per provider a tick, so restarts fall
    // between and within ticks of OpenRouter text requests and Gemini
    // embedding submissions.
    scenario: {
      name: "paid processing on both providers",
      seed: (native) => seedApps(native, EXPERIMENT),
      world: experimentWorld,
      before: [at("06:00")],
      beforeOptions: { paidSubmissionsPerTick: 0 },
      ticks: [at("06:15"), at("06:30"), at("06:45"), at("07:00"), at("07:15"), at("07:30"), at("07:45")],
      options: { paidSubmissionsPerTick: 3 },
    },
    invariants: { restarts: ["outlet_fetch", "openrouter", "gemini_submit"], dayStops: { days: 2 } },
    baseline: { search: 0, outlet_fetch: 18, openrouter: 21, gemini_submit: 3 },
  },
];

describe("interruption sweeps", () => {
  for (const { scenario, invariants, baseline, knownFailure } of SCENARIOS) {
    const run = knownFailure ? test.failing : test;
    run(`${scenario.name}: ${[invariants.restarts ? "no request is sent twice across a restart after any outbound call" : null, invariants.dayStops ? "an Outlet day stop at any outlet fetch keeps the per-query, per-day and reopening invariants" : null].filter(Boolean).join("; ")}${knownFailure ? ` (known failure: ${knownFailure})` : ""}`, async () => {
      const report = await sweepInterruptions(scenario, invariants);
      expect(report.baseline).toEqual(baseline);
      expect(report.violations).toEqual([]);
      // Discovery fetches answered 429 hold their queries, which shows the day-stop sweep checks reopening at all.
      if (invariants.dayStops && baseline.search > 0) expect(report.dayStoppedQueries).toBeGreaterThan(0);
      // A restart during a processing fetch resends it under the one named
      // exception, which shows the sweep observes resends at all.
      if (invariants.restarts?.includes("outlet_fetch") && baseline.outlet_fetch > 0) {
        expect(report.resentUnderException.length).toBeGreaterThan(0);
        expect(report.resentUnderException.every((resend) => resend.includes("outlet_fetch processing:"))).toBe(true);
      }
    }, 600_000);
  }

  test("the processing-fetch exception is the only one, and it is named once", () => {
    expect(PROCESSING_FETCH_RESENT_AFTER_RESTART).toContain("ADR 0020");
  });
});
