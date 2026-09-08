import React, { useRef, useState } from "react";
import { Check, CaretDown } from "@phosphor-icons/react";
import type { FacetDictionaryEntry, FacetGroup } from "../lib/taxonomy";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

interface RankingFacetSelectProps {
  group: FacetGroup;
  entries: FacetDictionaryEntry[];
  selected: number[];
  onChange: (values: number[]) => void;
}

function facetGroupLabel(group: FacetGroup): string {
  if (group === "community_tag") return "Community tags";
  return group === "genre" ? "Genres" : "Features";
}

function normalizeSelection(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}


export function RankingFacetSelect({ group, entries, selected, onChange }: RankingFacetSelectProps) {
  const label = facetGroupLabel(group);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(() => normalizeSelection(selected));
  const closeReason = useRef<"commit" | "cancel" | null>(null);
  const displaySelection = open ? draft : normalizeSelection(selected);
  const visible = entries.filter((entry) => entry.facet_group === group && entry.name && entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  const startDraft = () => {
    setDraft(normalizeSelection(selected));
    setSearch("");
  };

  const commitAndClose = () => {
    closeReason.current = "commit";
    setOpen(false);
    const next = normalizeSelection(draft);
    const current = normalizeSelection(selected);
    if (next.length !== current.length || next.some((value, index) => value !== current[index])) onChange(next);
  };

  const cancelAndClose = () => {
    closeReason.current = "cancel";
    setDraft(normalizeSelection(selected));
    setSearch("");
    setOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      closeReason.current = null;
      startDraft();
      setOpen(true);
      return;
    }
    if (closeReason.current) {
      closeReason.current = null;
      setOpen(false);
      return;
    }
    commitAndClose();
  };

  const toggle = (id: number, checked: boolean) => {
    setDraft((current) => normalizeSelection(checked ? [...current, id] : current.filter((value) => value !== id)));
  };

  return (
    <fieldset className="facet-group">
      <legend>{label}</legend>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label} filter`}
            aria-haspopup="dialog"
            className="flex min-h-[2.3rem] w-full items-center justify-between gap-2 border border-[#3f3f46] bg-[#09090b] px-2 py-1.5 text-left text-xs hover:border-[#a78bfa] hover:text-[#c4b5fd]"
          >
            <span className="min-w-0 truncate">{displaySelection.length ? `${displaySelection.length} selected` : "All"}</span>
            <CaretDown aria-hidden="true" size={14} weight="bold" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            cancelAndClose();
          }}
          className="w-[min(22rem,calc(100vw-2rem))] border-[#3f3f46] bg-[#111113] p-3 text-[#f4f4f5] shadow-xl"
        >
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${label.toLocaleLowerCase()}`}
              aria-label={`Search ${label}`}
              className="min-h-9 min-w-0 flex-1 border border-[#3f3f46] bg-[#09090b] px-2 py-1.5 text-xs outline-none placeholder:text-[#71717a] focus:border-[#a78bfa] focus:ring-1 focus:ring-[#a78bfa]"
            />
            <button
              type="button"
              onClick={() => setDraft([])}
              disabled={!draft.length}
              className="min-h-9 border border-[#3f3f46] px-2 text-xs text-[#a1a1aa] hover:border-[#a78bfa] hover:text-[#c4b5fd] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Clear
            </button>
          </div>
          <div role="group" aria-label={`${label} options`} className="mt-3 flex max-h-60 flex-col gap-1 overflow-y-auto">
            {visible.map((entry) => {
              const id = Number(entry.source_id);
              if (!Number.isSafeInteger(id) || id <= 0 || !entry.name) return null;
              const checked = draft.includes(id);
              return (
                <label key={`${entry.facet_group}:${entry.source_id}`} className="flex cursor-pointer items-center gap-2 border border-transparent px-2 py-1.5 text-xs hover:border-[#a78bfa55] hover:bg-[#a78bfa0a]">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggle(id, event.target.checked)}
                    className="size-4 accent-[#a78bfa]"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {checked && <Check aria-hidden="true" size={14} weight="bold" className="shrink-0 text-[#c4b5fd]" />}
                </label>
              );
            })}
            {!visible.length && <span className="px-2 py-2 text-xs text-[#a1a1aa]">No matching facets.</span>}
          </div>
          <div className="mt-3 flex justify-end border-t border-[#27272a] pt-3">
            <button
              type="button"
              onClick={commitAndClose}
              className="min-h-9 border border-[#a78bfa] bg-[#a78bfa] px-3 text-xs font-bold text-[#18181b] hover:border-[#c4b5fd] hover:bg-[#c4b5fd]"
            >
              OK
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </fieldset>
  );
}
