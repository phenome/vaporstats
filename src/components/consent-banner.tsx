import React, { useState, useEffect, useRef } from "react";
import {
  getConsentStatus,
  setConsentStatus,
  withdrawConsent,
  subscribeConsentChange,
  type ConsentStatus,
} from "../lib/analytics";

export function ConsentBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<ConsentStatus>("unset");
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setStatus(getConsentStatus());
    return subscribeConsentChange((nextStatus) => {
      setStatus(nextStatus);
    });
  }, []);

  // Handle escape key to close tooltip
  useEffect(() => {
    if (!tooltipOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTooltipOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tooltipOpen]);

  if (status !== "unset") {
    return null;
  }

  const handleAccept = async () => {
    await setConsentStatus("accepted");
    setStatus("accepted");
  };

  const handleReject = async () => {
    await setConsentStatus("rejected");
    setStatus("rejected");
  };

  return (
    <aside
      aria-label="Privacy and Analytics Consent"
      role="region"
      className="fixed bottom-0 inset-x-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-4 sm:py-5 shadow-2xl transition-all"
    >
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1.5 flex-1 pr-0 md:pr-6">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-300">
              Privacy Choices
            </span>
            <div className="relative inline-block">
              <button
                type="button"
                onClick={() => setTooltipOpen((prev) => !prev)}
                aria-expanded={tooltipOpen}
                aria-controls="consent-explanation-tooltip"
                aria-label="Explain optional analytics and local storage"
                className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] text-xs font-mono font-bold text-zinc-400 border border-zinc-700 bg-zinc-900 hover:text-zinc-100 hover:border-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              >
                ?
              </button>
              <div
                id="consent-explanation-tooltip"
                role="tooltip"
                ref={tooltipRef}
                aria-hidden={!tooltipOpen}
                className={`${tooltipOpen ? "block" : "hidden"} absolute left-0 bottom-full mb-2 w-72 sm:w-80 p-3 bg-zinc-900 border border-zinc-700 text-xs text-zinc-300 shadow-xl z-50 space-y-1.5`}
              >
                <p className="font-mono text-[11px] font-semibold text-zinc-200 uppercase">
                  How We Handle Your Data
                </p>
                <p className="text-[12px] leading-relaxed text-zinc-400">
                  Optional analytics measure aggregate platform visits and feature usage.
                  No personal profiles or advertising trackers are used.
                  Necessary storage is used solely to record your consent choices.
                </p>
              </div>
            </div>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">
            We use optional analytics to understand aggregate platform traffic and improve game discovery.
            Essential storage is used only to preserve your preferences. Read our{" "}
            <a
              href="/privacy"
              className="text-zinc-200 underline hover:text-white decoration-zinc-600 underline-offset-2"
            >
              Privacy Notice
            </a>{" "}
            for full details.
          </p>
        </div>

        {/* Equal-weight Accept and Reject choices */}
        <div className="flex items-center gap-3 w-full md:w-auto">
          <button
            type="button"
            onClick={handleReject}
            data-action="reject-consent"
            className="flex-1 md:flex-initial min-h-[44px] min-w-[120px] px-5 py-2.5 text-xs font-mono font-semibold uppercase tracking-wider text-zinc-200 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-850 hover:text-white active:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-zinc-400 transition-colors"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={handleAccept}
            data-action="accept-consent"
            className="flex-1 md:flex-initial min-h-[44px] min-w-[120px] px-5 py-2.5 text-xs font-mono font-semibold uppercase tracking-wider text-zinc-200 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 hover:bg-zinc-850 hover:text-white active:bg-zinc-800 focus:outline-none focus:ring-1 focus:ring-zinc-400 transition-colors"
          >
            Accept
          </button>
        </div>
      </div>
    </aside>
  );
}

export function FooterPrivacyControl(): React.JSX.Element {
  const [status, setStatus] = useState<ConsentStatus>("unset");

  useEffect(() => {
    setStatus(getConsentStatus());
    return subscribeConsentChange((nextStatus) => {
      setStatus(nextStatus);
    });
  }, []);

  const handleWithdraw = async () => {
    await withdrawConsent();
    setStatus("rejected");
  };

  const handleAccept = async () => {
    await setConsentStatus("accepted");
    setStatus("accepted");
  };

  return (
    <div className="inline-flex items-center gap-2" data-testid="footer-privacy-control">
      <span className="text-zinc-500">
        Analytics:{" "}
        <span className={status === "accepted" ? "text-zinc-300 font-semibold" : "text-zinc-500"}>
          {status === "accepted" ? "Active" : status === "rejected" ? "Disabled" : "Unset"}
        </span>
      </span>
      {status === "accepted" ? (
        <button
          type="button"
          onClick={handleWithdraw}
          aria-label="Withdraw analytics consent"
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-1 text-[11px] font-mono uppercase tracking-wider text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          Withdraw
        </button>
      ) : (
        <button
          type="button"
          onClick={handleAccept}
          aria-label="Enable analytics"
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-1 text-[11px] font-mono uppercase tracking-wider text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          {status === "rejected" ? "Enable" : "Accept"}
        </button>
      )}
    </div>
  );
}
