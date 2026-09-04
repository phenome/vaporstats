import { describe, test, expect, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONSENT_STORAGE_KEY,
  getConsentStatus,
  setConsentStatus,
  withdrawConsent,
  initAnalyticsIfConsented,
  captureEvent,
  isAnalyticsLoaded,
  setStorageAdapter,
  setAnalyticsLoader,
  setAnalyticsAdapter,
  resetAnalyticsState,
  subscribeConsentChange,
  type StorageAdapter,
  type AnalyticsAdapter,
} from "../src/lib/analytics";
import { ConsentBanner, FooterPrivacyControl } from "../src/components/consent-banner";
import { PrivacyNoticeView, handlePrivacyHttpRequest } from "../src/routes/privacy";
import { CACHE_POLICIES } from "../src/lib/cache";

/**
 * In-memory storage adapter simulating browser localStorage.
 */
class MemoryStorageAdapter implements StorageAdapter {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = value;
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

describe("Analytics Consent and Privacy Foundation", () => {
  let memoryStorage: MemoryStorageAdapter;

  beforeEach(() => {
    resetAnalyticsState();
    memoryStorage = new MemoryStorageAdapter();
    setStorageAdapter(memoryStorage);
  });

  test("analytics absent before consent", async () => {
    let dynamicLoaderCalled = false;
    let posthogCaptureCalled = false;

    const mockPostHog: AnalyticsAdapter = {
      init: () => {},
      capture: () => {
        posthogCaptureCalled = true;
      },
      opt_out_capturing: () => {},
      reset: () => {},
    };

    setAnalyticsLoader(async () => {
      dynamicLoaderCalled = true;
      return mockPostHog;
    });

    // 1. Storage is empty initially
    expect(memoryStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(getConsentStatus()).toBe("unset");
    expect(isAnalyticsLoaded()).toBe(false);

    // 2. Attempting initialization without consent must fail and must not invoke the dynamic loader
    const initResult = await initAnalyticsIfConsented();
    expect(initResult).toBe(false);
    expect(dynamicLoaderCalled).toBe(false);
    expect(isAnalyticsLoaded()).toBe(false);

    // 3. Attempting to capture any event before consent must be blocked
    const captureResult = await captureEvent("initial_pageview", { path: "/games" });
    expect(captureResult).toBe(false);
    expect(dynamicLoaderCalled).toBe(false);
    expect(posthogCaptureCalled).toBe(false);
    expect(isAnalyticsLoaded()).toBe(false);

    console.log("analytics absent before consent");
  });

  test("equal consent choices", async () => {
    // With unset consent, the banner renders both Accept and Reject choices
    expect(getConsentStatus()).toBe("unset");

    const html = renderToString(React.createElement(ConsentBanner));

    // Must render accessible region
    expect(html).toContain('aria-label="Privacy and Analytics Consent"');

    // Both actions must exist
    expect(html).toContain('data-action="accept-consent"');
    expect(html).toContain('data-action="reject-consent"');

    // Equal visual weight: both buttons must share equal min-height and styling characteristics
    const acceptMatch = html.match(/data-action="accept-consent"[^>]*class="([^"]+)"/);
    const rejectMatch = html.match(/data-action="reject-consent"[^>]*class="([^"]+)"/);

    expect(acceptMatch).not.toBeNull();
    expect(rejectMatch).not.toBeNull();

    const acceptClasses = acceptMatch ? acceptMatch[1].split(/\s+/) : [];
    const rejectClasses = rejectMatch ? rejectMatch[1].split(/\s+/) : [];

    // Check equal touch target min-height (>= 44px)
    expect(acceptClasses).toContain("min-h-[44px]");
    expect(rejectClasses).toContain("min-h-[44px]");

    // Check equal typography and sizing classes
    expect(acceptClasses).toContain("text-xs");
    expect(rejectClasses).toContain("text-xs");
    expect(acceptClasses).toContain("font-mono");
    expect(rejectClasses).toContain("font-mono");
    expect(acceptClasses).toContain("bg-zinc-900");
    expect(rejectClasses).toContain("bg-zinc-900");

    // Explanation tooltip must exist and be accessible
    expect(html).toContain('id="consent-explanation-tooltip"');
    expect(html).toContain('aria-controls="consent-explanation-tooltip"');

    // Link to privacy notice
    expect(html).toContain('href="/privacy"');

    // Deterministic consent-neutral SSR: server renders banner markup consistently
    // to prevent hydration mismatch; persistence is evaluated post-mount in client effect
    memoryStorage.setItem(CONSENT_STORAGE_KEY, "accepted");
    const ssrAcceptedHtml = renderToString(React.createElement(ConsentBanner));
    expect(ssrAcceptedHtml).toContain('aria-label="Privacy and Analytics Consent"');

    memoryStorage.setItem(CONSENT_STORAGE_KEY, "rejected");
    const ssrRejectedHtml = renderToString(React.createElement(ConsentBanner));
    expect(ssrRejectedHtml).toContain('aria-label="Privacy and Analytics Consent"');

    console.log("equal consent choices");
  });

  test("privacy notice", async () => {
    const request = new Request("http://localhost/privacy");
    const response = handlePrivacyHttpRequest(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe(CACHE_POLICIES.entity);

    const body = await response.text();

    // Plain-language notice must cover necessary storage and optional tracking
    expect(body).toContain("Privacy Notice");
    expect(body).toContain("Necessary Local Storage");
    expect(body).toContain("vaporstats_consent");
    expect(body).toContain("Essential Storage");
    expect(body).toContain("Optional Tracking");
    expect(body).toContain("PostHog");

    // Must include reversible consent explanation
    expect(body).toContain("Withdrawing consent");

    console.log("privacy notice");
  });

  test("acceptance controls loading", async () => {
    let loaderCalls = 0;
    const capturedEvents: Array<{ event: string; props?: Record<string, unknown> }> = [];

    const mockPostHog: AnalyticsAdapter = {
      init: () => {},
      capture: (event, props) => {
        capturedEvents.push({ event, props });
      },
      opt_out_capturing: () => {},
      reset: () => {},
    };

    setAnalyticsLoader(async () => {
      loaderCalls++;
      return mockPostHog;
    });

    // 1. Rejection test: setting rejected state must leave analytics unloaded
    await setConsentStatus("rejected");
    expect(memoryStorage.getItem(CONSENT_STORAGE_KEY)).toBe("rejected");
    expect(getConsentStatus()).toBe("rejected");
    expect(loaderCalls).toBe(0);
    expect(isAnalyticsLoaded()).toBe(false);

    const eventWhenRejected = await captureEvent("game_view", { appid: 570 });
    expect(eventWhenRejected).toBe(false);
    expect(loaderCalls).toBe(0);
    expect(capturedEvents.length).toBe(0);

    // 2. Acceptance test: explicit acceptance dynamically loads analytics
    await setConsentStatus("accepted");
    expect(memoryStorage.getItem(CONSENT_STORAGE_KEY)).toBe("accepted");
    expect(getConsentStatus()).toBe("accepted");
    expect(loaderCalls).toBe(1);
    expect(isAnalyticsLoaded()).toBe(true);

    const eventWhenAccepted = await captureEvent("game_view", { appid: 570 });
    expect(eventWhenAccepted).toBe(true);
    expect(capturedEvents.length).toBe(1);
    expect(capturedEvents[0].event).toBe("game_view");
    expect(capturedEvents[0].props?.appid).toBe(570);

    console.log("acceptance controls loading");
  });

  test("consent persistence", async () => {
    let loaderCalls = 0;
    const mockPostHog: AnalyticsAdapter = {
      init: () => {},
      capture: () => {},
      opt_out_capturing: () => {},
      reset: () => {},
    };

    setAnalyticsLoader(async () => {
      loaderCalls++;
      return mockPostHog;
    });

    // Scenario A: Visitor accepts consent
    await setConsentStatus("accepted");
    expect(memoryStorage.getItem(CONSENT_STORAGE_KEY)).toBe("accepted");
    expect(loaderCalls).toBe(1);

    // Simulate browser reload: memory runtime state is reset, but storage persists
    resetAnalyticsState();
    setStorageAdapter(memoryStorage);
    setAnalyticsLoader(async () => {
      loaderCalls++;
      return mockPostHog;
    });

    // On reload, remembered decision is "accepted"
    expect(getConsentStatus()).toBe("accepted");
    expect(isAnalyticsLoaded()).toBe(false);

    // Initial check on reload restores analytics without re-prompting
    const readyOnReload = await initAnalyticsIfConsented();
    expect(readyOnReload).toBe(true);
    expect(isAnalyticsLoaded()).toBe(true);
    expect(loaderCalls).toBe(2);

    // Scenario B: Visitor rejects consent
    await setConsentStatus("rejected");
    expect(memoryStorage.getItem(CONSENT_STORAGE_KEY)).toBe("rejected");

    // Simulate browser reload again
    resetAnalyticsState();
    setStorageAdapter(memoryStorage);
    setAnalyticsLoader(async () => {
      loaderCalls++;
      return mockPostHog;
    });

    // On reload, remembered decision is "rejected"
    expect(getConsentStatus()).toBe("rejected");
    const readyAfterRejectReload = await initAnalyticsIfConsented();
    expect(readyAfterRejectReload).toBe(false);
    expect(isAnalyticsLoaded()).toBe(false);
    expect(loaderCalls).toBe(2); // no new loader call

    console.log("consent persistence");
  });

  test("consent withdrawal", async () => {
    let optOutCalled = false;
    let resetCalled = false;
    const capturedEvents: string[] = [];

    const mockPostHog: AnalyticsAdapter = {
      init: () => {},
      capture: (event) => {
        capturedEvents.push(event);
      },
      opt_out_capturing: () => {
        optOutCalled = true;
      },
      reset: () => {
        resetCalled = true;
      },
    };

    setAnalyticsAdapter(mockPostHog);
    await setConsentStatus("accepted");
    expect(isAnalyticsLoaded()).toBe(true);

    // Events work while consented
    const ok = await captureEvent("active_event");
    expect(ok).toBe(true);
    expect(capturedEvents).toEqual(["active_event"]);

    // Withdraw consent via persistent control
    await withdrawConsent();

    // Storage is updated to rejected
    expect(memoryStorage.getItem(CONSENT_STORAGE_KEY)).toBe("rejected");
    expect(getConsentStatus()).toBe("rejected");
    expect(isAnalyticsLoaded()).toBe(false);

    // Adapter opt_out and reset were triggered
    expect(optOutCalled).toBe(true);
    expect(resetCalled).toBe(true);

    // Future events are strictly blocked
    const blockedEvent = await captureEvent("subsequent_event");
    expect(blockedEvent).toBe(false);
    expect(capturedEvents).toEqual(["active_event"]);

    // Deterministic consent-neutral SSR: footer renders control container on server;
    // client-side withdrawal UI state transition is verified in browser gates
    const footerHtml = renderToString(React.createElement(FooterPrivacyControl));
    expect(footerHtml).toContain('data-testid="footer-privacy-control"');

    console.log("consent withdrawal");
  });
  test("consent notification state propagation", async () => {
    const notifications: string[] = [];

    // Subscribe two separate listeners (simulating banner and footer controls)
    const unsubscribe1 = subscribeConsentChange((status) => {
      notifications.push(`listener1:${status}`);
    });
    const unsubscribe2 = subscribeConsentChange((status) => {
      notifications.push(`listener2:${status}`);
    });

    // Accept consent triggers notification to all subscribers
    await setConsentStatus("accepted");
    expect(notifications).toEqual(["listener1:accepted", "listener2:accepted"]);

    // Withdraw consent triggers notification to all subscribers
    await withdrawConsent();
    expect(notifications).toEqual([
      "listener1:accepted",
      "listener2:accepted",
      "listener1:rejected",
      "listener2:rejected",
    ]);

    // Unsubscribe removes listener from subsequent notifications
    unsubscribe1();
    await setConsentStatus("accepted");
    expect(notifications).toEqual([
      "listener1:accepted",
      "listener2:accepted",
      "listener1:rejected",
      "listener2:rejected",
      "listener2:accepted",
    ]);

    unsubscribe2();
  });


  test("consent scope boundary", async () => {
    const routesDir = resolve(import.meta.dir, "../src/routes");
    const routeFiles = readdirSync(routesDir);

    // Strictly forbidden secondary policy pages
    const forbiddenPagePatterns = [
      /^terms\./i,
      /^cookie\./i,
      /^cookies\./i,
      /^about\./i,
      /^accessibility\./i,
      /^api\.tsx$/i,
      /^api-docs\./i,
    ];

    for (const file of routeFiles) {
      for (const pattern of forbiddenPagePatterns) {
        expect(pattern.test(file)).toBe(false);
      }
    }

    // Privacy route must exist
    expect(existsSync(resolve(routesDir, "privacy.tsx"))).toBe(true);

    console.log("consent scope boundary");
  });
});
