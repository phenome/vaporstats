import { useEffect } from "react";

// Throwaway development control; the compared page owns no variant labels.
export function PrototypeSwitcher({ variants, current, onChange }: {
  variants: { key: string; name: string }[];
  current: string;
  onChange: (key: string) => void;
}) {
  const index = variants.findIndex(variant => variant.key === current);
  const cycle = (direction: number) => onChange(variants[(index + direction + variants.length) % variants.length].key);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="tablist"]')) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      cycle(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, variants, onChange]);
  if (!import.meta.env.DEV) return null;
  return <nav aria-label="Prototype variants" className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center border border-zinc-600 bg-zinc-100 text-zinc-950 shadow-xl">
    <button type="button" aria-label="Previous variant" onClick={() => cycle(-1)} className="h-11 w-11 shrink-0 hover:bg-zinc-300 focus-visible:outline-2 focus-visible:outline-orange-500">←</button>
    <span aria-live="polite" className="px-2 text-center text-xs font-mono">{current} · {variants[index].name}</span>
    <button type="button" aria-label="Next variant" onClick={() => cycle(1)} className="h-11 w-11 shrink-0 hover:bg-zinc-300 focus-visible:outline-2 focus-visible:outline-orange-500">→</button>
  </nav>;
}
