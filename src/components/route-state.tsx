import React from "react";
import { CatalogSkeleton } from "./route-skeletons";

export function RouteLoading({ label = "Loading live data..." }: { label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <CatalogSkeleton />
    </div>
  );
}

export function RouteDataError() {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-7xl flex-col items-center justify-center gap-3 px-4 py-16 text-center font-mono">
      <h1 className="text-xl font-semibold text-zinc-100">Live data unavailable</h1>
      <p className="max-w-md text-sm text-zinc-500">
        VaporStats could not load the current Steam data. Try again shortly.
      </p>
    </div>
  );
}
