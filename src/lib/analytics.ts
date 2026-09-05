/**
 * Analytics and consent management for VaporStats.
 *
 * Enforces strict consent: PostHog or any optional tracking dependency
 * remains completely unloaded until explicit stored acceptance.
 * Rejection and withdrawal prevent loading, disable active capturing,
 * and block all future tracking events.
 */

export const CONSENT_STORAGE_KEY = "vaporstats_consent";

export type ConsentStatus = "unset" | "accepted" | "rejected";

export interface AnalyticsAdapter {
  init(key?: string, options?: Record<string, unknown>): void;
  capture(event: string, properties?: Record<string, unknown>): void;
  opt_out_capturing(): void;
  reset(): void;
  has_opted_out_capturing?(): boolean;
}

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let customStorage: StorageAdapter | null = null;
let customLoader: (() => Promise<AnalyticsAdapter>) | null = null;
let activeAdapter: AnalyticsAdapter | null = null;
let isLoaded = false;
let isWithdrawn = false;

export type ConsentListener = (status: ConsentStatus) => void;
const consentListeners = new Set<ConsentListener>();

export function subscribeConsentChange(listener: ConsentListener): () => void {
  consentListeners.add(listener);
  return () => {
    consentListeners.delete(listener);
  };
}

function notifyConsentChange(status: ConsentStatus): void {
  for (const listener of consentListeners) {
    try {
      listener(status);
    } catch {
      // ignore subscriber error
    }
  }
}

export function setStorageAdapter(storage: StorageAdapter | null): void {
  customStorage = storage;
}

export function setAnalyticsLoader(loader: (() => Promise<AnalyticsAdapter>) | null): void {
  customLoader = loader;
}

export function setAnalyticsAdapter(adapter: AnalyticsAdapter | null): void {
  activeAdapter = adapter;
  isLoaded = adapter !== null;
  if (adapter) {
    isWithdrawn = false;
  }
}

function getStorage(): StorageAdapter | null {
  if (customStorage) return customStorage;
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (
    typeof globalThis !== "undefined" &&
    "localStorage" in globalThis &&
    typeof globalThis.localStorage === "object" &&
    globalThis.localStorage !== null
  ) {
    const candidate = globalThis.localStorage;
    if ("getItem" in candidate && "setItem" in candidate) {
      return candidate as StorageAdapter;
    }
  }
  return null;
}

export function getConsentStatus(): ConsentStatus {
  const storage = getStorage();
  if (!storage) return "unset";
  const raw = storage.getItem(CONSENT_STORAGE_KEY);
  if (raw === "accepted") return "accepted";
  if (raw === "rejected") return "rejected";
  return "unset";
}

export async function setConsentStatus(status: "accepted" | "rejected"): Promise<void> {
  const storage = getStorage();
  if (storage) {
    storage.setItem(CONSENT_STORAGE_KEY, status);
  }

  if (status === "accepted") {
    isWithdrawn = false;
    await initAnalyticsIfConsented();
    notifyConsentChange("accepted");
  } else {
    await withdrawConsent();
  }
}

export async function withdrawConsent(): Promise<void> {
  const storage = getStorage();
  if (storage) {
    storage.setItem(CONSENT_STORAGE_KEY, "rejected");
  }
  isWithdrawn = true;
  if (activeAdapter) {
    try {
      activeAdapter.opt_out_capturing();
      activeAdapter.reset();
    } catch {
      // ignore client errors during cleanup
    }
    activeAdapter = null;
  }
  isLoaded = false;
  notifyConsentChange("rejected");
}

export async function initAnalyticsIfConsented(): Promise<boolean> {
  if (getConsentStatus() !== "accepted" || isWithdrawn) {
    return false;
  }

  if (isLoaded && activeAdapter) {
    return true;
  }

  try {
    let adapter: AnalyticsAdapter;
    if (customLoader) {
      adapter = await customLoader();
    } else {
      // Dynamic import required by privacy gate: posthog-js must remain completely
      // absent from loaded modules, chunk manifests, and network requests prior to
      // explicit stored user acceptance. Static imports would bundle it unconditionally.
      const posthogModule = await import("posthog-js");
      if (getConsentStatus() !== "accepted" || isWithdrawn) {
        return false;
      }
      const posthogCandidate = "default" in posthogModule ? posthogModule.default : posthogModule;
      const posthog = posthogCandidate as unknown as AnalyticsAdapter;
      const apiKey =
        (typeof process !== "undefined" && process.env && (process.env.VITE_POSTHOG_KEY || process.env.POSTHOG_KEY)) ||
        "phc_tGnmyQZyk2BGREJFjCRv9H6N9nAtpDtMqft9wt5vdJeY";
      const apiHost =
        (typeof process !== "undefined" && process.env && (process.env.VITE_POSTHOG_HOST || process.env.POSTHOG_HOST)) ||
        "https://us.i.posthog.com";

      if (typeof posthog.init === "function") {
        posthog.init(apiKey, {
          api_host: apiHost,
          defaults: "2026-05-30",
        });
      }
      adapter = posthog;
    }

    if (getConsentStatus() !== "accepted" || isWithdrawn) {
      try {
        adapter.opt_out_capturing();
        adapter.reset();
      } catch {
        // ignore client errors while preserving the withdrawn state
      }
      return false;
    }

    activeAdapter = adapter;
    isLoaded = true;
    isWithdrawn = false;
    return true;
  } catch (err) {
    console.error("Failed to dynamically load optional analytics", err);
    return false;
  }
}

export async function captureEvent(
  eventName: string,
  properties?: Record<string, unknown>
): Promise<boolean> {
  // Strict gate: never capture if not explicitly accepted or if withdrawn
  if (getConsentStatus() !== "accepted" || isWithdrawn) {
    return false;
  }

  if (!isLoaded || !activeAdapter) {
    const ready = await initAnalyticsIfConsented();
    if (!ready || !activeAdapter) {
      return false;
    }
  }

  try {
    activeAdapter.capture(eventName, properties);
    return true;
  } catch {
    return false;
  }
}

export function isAnalyticsLoaded(): boolean {
  return isLoaded && activeAdapter !== null;
}

export function resetAnalyticsState(): void {
  activeAdapter = null;
  customLoader = null;
  customStorage = null;
  isLoaded = false;
  isWithdrawn = false;
  consentListeners.clear();
}
