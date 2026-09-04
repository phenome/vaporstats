import React from "react";
import type { CatalogEntity } from "../lib/catalog";
import type { GroupedRelatedApps, RelatedAppEntity } from "../lib/related";
import { getCanonicalChildPath } from "../lib/related";
import { toSlug } from "../lib/slug";

export interface RelatedAppsProps {
  parent: CatalogEntity | { appid: number; name: string; slug?: string };
  grouped: GroupedRelatedApps;
  className?: string;
}

export function RelatedApps({ parent, grouped, className = "" }: RelatedAppsProps) {
  const parentSlug = parent.slug || toSlug(parent.name);

  if (grouped.total_count === 0) {
    return (
      <section
        aria-label="Related applications"
        className={`border border-zinc-800 bg-zinc-950 p-6 space-y-2 font-mono ${className}`}
      >
        <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
            Related Content
          </h2>
          <span className="text-xs text-zinc-600">0 ITEMS</span>
        </div>
        <div className="py-6 text-center text-xs text-zinc-500">
          No related DLC, expansions, or accessory applications cataloged yet.
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Related applications"
      className={`border border-zinc-800 bg-zinc-950 p-6 space-y-6 font-mono ${className}`}
    >
      <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
            Related Content
          </h2>
          <span className="text-xs text-orange-400 font-bold tabular-nums">
            [{grouped.total_count}]
          </span>
        </div>
        <div className="text-xs text-zinc-500 uppercase">
          Parent: {parent.name} (#{parent.appid})
        </div>
      </div>

      {/* Promoted Major Expansions Section */}
      {grouped.expansions.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-orange-500 inline-block"></span>
            <h3 className="text-xs font-bold uppercase tracking-wider text-orange-400">
              Major Expansions & Content
            </h3>
            <span className="text-xs text-zinc-600">
              ({grouped.expansions.length})
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {grouped.expansions.map((child) => {
              const childSlug = child.slug || toSlug(child.name);
              const href = getCanonicalChildPath(parent.appid, parent.name, child.appid, child.name);
              return (
                <a
                  key={child.appid}
                  href={href}
                  className="group block border-2 border-orange-500/60 hover:border-orange-500 bg-zinc-900/80 p-4 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-orange-500/20 text-orange-400 border border-orange-500/40">
                          Major Expansion
                        </span>
                        <span className="text-[10px] text-zinc-500 tabular-nums">
                          #{child.appid}
                        </span>
                      </div>
                      <div className="text-sm font-bold text-zinc-100 group-hover:text-orange-400 truncate transition-colors">
                        {child.name}
                      </div>
                      {child.release_date && (
                        <div className="text-[11px] text-zinc-400">
                          RELEASE: <span className="text-zinc-300">{child.release_date}</span>
                        </div>
                      )}
                    </div>
                    {child.header_image && (
                      <img
                        src={child.header_image}
                        alt=""
                        className="w-24 h-11 object-cover border border-zinc-800 shrink-0 hidden sm:block"
                        loading="lazy"
                      />
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Downloadable Content (DLC) */}
      {grouped.dlc.length > 0 && (
        <RelatedSection
          title="Downloadable Content (DLC)"
          items={grouped.dlc}
          parent={parent}
          badgeText="DLC"
          badgeClass="bg-zinc-800 text-zinc-300 border-zinc-700"
        />
      )}

      {/* Soundtracks */}
      {grouped.soundtracks.length > 0 && (
        <RelatedSection
          title="Official Soundtracks"
          items={grouped.soundtracks}
          parent={parent}
          badgeText="Soundtrack"
          badgeClass="bg-indigo-950/40 text-indigo-300 border-indigo-800"
        />
      )}

      {/* Dedicated Servers */}
      {grouped.servers.length > 0 && (
        <RelatedSection
          title="Dedicated Servers & Server Tools"
          items={grouped.servers}
          parent={parent}
          badgeText="Dedicated Server"
          badgeClass="bg-amber-950/40 text-amber-300 border-amber-800"
        />
      )}

      {/* Tools */}
      {grouped.tools.length > 0 && (
        <RelatedSection
          title="Tools & Editors"
          items={grouped.tools}
          parent={parent}
          badgeText="Tool"
          badgeClass="bg-zinc-800 text-zinc-400 border-zinc-700"
        />
      )}

      {/* Demos */}
      {grouped.demos.length > 0 && (
        <RelatedSection
          title="Demos & Samplers"
          items={grouped.demos}
          parent={parent}
          badgeText="Demo"
          badgeClass="bg-emerald-950/40 text-emerald-300 border-emerald-800"
        />
      )}

      {/* Tests */}
      {grouped.tests.length > 0 && (
        <RelatedSection
          title="Test Builds & Betas"
          items={grouped.tests}
          parent={parent}
          badgeText="Test / Beta"
          badgeClass="bg-rose-950/40 text-rose-300 border-rose-800"
        />
      )}

      {/* Other */}
      {grouped.other.length > 0 && (
        <RelatedSection
          title="Other Associated Apps"
          items={grouped.other}
          parent={parent}
          badgeText="Other"
          badgeClass="bg-zinc-800 text-zinc-400 border-zinc-700"
        />
      )}
    </section>
  );
}

function RelatedSection({
  title,
  items,
  parent,
  badgeText,
  badgeClass,
}: {
  title: string;
  items: RelatedAppEntity[];
  parent: CatalogEntity | { appid: number; name: string; slug?: string };
  badgeText: string;
  badgeClass: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
          {title}
        </h3>
        <span className="text-xs text-zinc-600">({items.length})</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {items.map((child) => {
          const href = getCanonicalChildPath(parent.appid, parent.name, child.appid, child.name);
          return (
            <a
              key={child.appid}
              href={href}
              className="group flex items-center justify-between gap-2 border border-zinc-800 hover:border-zinc-700 bg-zinc-900/50 p-2.5 transition-colors"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className={`px-1 py-0.2 text-[9px] uppercase font-mono border ${badgeClass}`}>
                    {badgeText}
                  </span>
                  <span className="text-[10px] text-zinc-500 tabular-nums">
                    #{child.appid}
                  </span>
                </div>
                <div className="text-xs text-zinc-200 group-hover:text-orange-400 truncate font-mono transition-colors">
                  {child.name}
                </div>
              </div>
              {child.release_date && (
                <div className="text-[10px] text-zinc-500 shrink-0 tabular-nums hidden sm:block">
                  {child.release_date}
                </div>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}

export default RelatedApps;
