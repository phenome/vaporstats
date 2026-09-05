import { useEffect } from "react";

export interface PrototypeVariant {
  key: string;
  name: string;
}

interface PrototypeSwitcherProps {
  variants: PrototypeVariant[];
  current: string;
  onChange: (variant: string) => void;
}

export function PrototypeSwitcher({ variants, current, onChange }: PrototypeSwitcherProps) {
  const currentIndex = Math.max(0, variants.findIndex((variant) => variant.key === current));
  const cycle = (offset: number) => {
    const next = variants[(currentIndex + offset + variants.length) % variants.length];
    onChange(next.key);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable]")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (import.meta.env.PROD && !import.meta.env.VITE_PROTOTYPE) return null;
  const active = variants[currentIndex];

  return (
    <nav
      aria-label="Prototype variants"
      className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center border border-zinc-600 bg-zinc-100 px-1 py-1 font-mono text-xs text-zinc-950 shadow-2xl"
    >
      <button type="button" onClick={() => cycle(-1)} className="min-h-10 min-w-10 px-3 hover:bg-zinc-300" aria-label="Previous variant">
        ←
      </button>
      <span className="min-w-56 px-4 text-center font-bold">{active.key} · {active.name}</span>
      <button type="button" onClick={() => cycle(1)} className="min-h-10 min-w-10 px-3 hover:bg-zinc-300" aria-label="Next variant">
        →
      </button>
    </nav>
  );
}
