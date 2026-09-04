import React, { useState, useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import {
  getConsentStatus,
  setConsentStatus,
  withdrawConsent,
  subscribeConsentChange,
  type ConsentStatus,
} from "../lib/analytics";
import { CACHE_POLICIES } from "../lib/cache";

export const Route = createFileRoute("/privacy")({
  headers: () => ({
    "Cache-Control": CACHE_POLICIES.entity,
    "Vary": "Accept-Encoding",
  }),
  component: PrivacyRouteComponent,
});

export function PrivacyNoticeView(): React.JSX.Element {
  const [status, setStatus] = useState<ConsentStatus>("unset");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setStatus(getConsentStatus());
    return subscribeConsentChange((nextStatus) => {
      setStatus(nextStatus);
    });
  }, []);

  const handleAccept = async () => {
    await setConsentStatus("accepted");
    setStatus("accepted");
  };

  const handleWithdraw = async () => {
    await withdrawConsent();
    setStatus("rejected");
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12 space-y-10 font-sans">
      <header className="border-b border-zinc-800 pb-6 space-y-2">
        <div className="text-xs font-mono uppercase tracking-widest text-zinc-500">
          VaporStats Policy
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-100">
          Privacy Notice
        </h1>
        <p className="text-sm text-zinc-400">
          How VaporStats handles your privacy, necessary storage, and optional analytics.
        </p>
      </header>

      {/* Interactive Consent Control */}
      <section
        aria-label="Consent Preferences"
        className="p-6 bg-zinc-900/60 border border-zinc-800 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-mono uppercase tracking-wider text-zinc-200 font-semibold">
              Current Analytics Preference
            </h2>
            <p className="text-xs text-zinc-400 mt-1">
              Your current preference stored on this device:{" "}
              <span className="font-mono font-bold text-zinc-200 uppercase">
                {mounted ? status : "Checking..."}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {status === "accepted" ? (
              <button
                type="button"
                onClick={handleWithdraw}
                data-testid="privacy-withdraw-button"
                className="min-h-[44px] px-5 py-2 text-xs font-mono font-semibold uppercase tracking-wider text-zinc-200 bg-zinc-800 border border-zinc-700 hover:border-zinc-500 hover:text-white transition-colors focus:outline-none focus:ring-1 focus:ring-zinc-400"
              >
                Withdraw Consent
              </button>
            ) : (
              <button
                type="button"
                onClick={handleAccept}
                data-testid="privacy-accept-button"
                className="min-h-[44px] px-5 py-2 text-xs font-mono font-semibold uppercase tracking-wider text-zinc-200 bg-zinc-800 border border-zinc-700 hover:border-zinc-500 hover:text-white transition-colors focus:outline-none focus:ring-1 focus:ring-zinc-400"
              >
                Accept Optional Analytics
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Withdrawing consent takes effect immediately: tracking is disabled, session identifiers are cleared, and no further events are sent.
        </p>
      </section>

      {/* Storage and Analytics Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Necessary Storage */}
        <section className="p-6 bg-zinc-950 border border-zinc-800 space-y-3">
          <div className="text-xs font-mono uppercase tracking-wider text-zinc-400 font-semibold">
            Essential Storage
          </div>
          <h2 className="text-lg font-semibold text-zinc-100">
            Necessary Local Storage
          </h2>
          <p className="text-xs text-zinc-400 leading-relaxed">
            We use browser local storage exclusively to remember your preferences, including your analytics consent decision (<code className="text-zinc-300 font-mono">vaporstats_consent</code>).
          </p>
          <ul className="text-xs text-zinc-400 space-y-1 list-disc list-inside">
            <li>No tracking cookies are stored for site navigation.</li>
            <li>No personal identification data is stored.</li>
            <li>Used solely to avoid re-prompting on every page visit.</li>
          </ul>
        </section>

        {/* Optional Analytics */}
        <section className="p-6 bg-zinc-950 border border-zinc-800 space-y-3">
          <div className="text-xs font-mono uppercase tracking-wider text-zinc-400 font-semibold">
            Optional Tracking
          </div>
          <h2 className="text-lg font-semibold text-zinc-100">
            Analytics Measurements
          </h2>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Optional analytics (powered by PostHog) are loaded only if you explicitly choose to accept. They help us understand aggregate traffic patterns and game discovery trends.
          </p>
          <ul className="text-xs text-zinc-400 space-y-1 list-disc list-inside">
            <li>Completely unloaded until you explicitly accept.</li>
            <li>No cross-site or third-party advertising tracking.</li>
            <li>Fully reversible at any time via the control above or footer.</li>
          </ul>
        </section>
      </div>

      <section className="border-t border-zinc-800 pt-6 text-xs text-zinc-500 space-y-2">
        <p>
          VaporStats operates as an independent Steam game intelligence and catalog platform.
          Our priority is transparency and direct user control over optional analytics.
        </p>
      </section>
    </div>
  );
}

function PrivacyRouteComponent(): React.JSX.Element {
  return <PrivacyNoticeView />;
}

export function handlePrivacyHttpRequest(_request: Request): Response {
  const content = renderToString(<PrivacyNoticeView />);
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Notice - VaporStats</title>
  </head>
  <body class="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans antialiased">
    <main class="flex-1">${content}</main>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": CACHE_POLICIES.entity,
      "Vary": "Accept-Encoding",
    },
  });
}
