import React, { useRef, useState, useEffect, useLayoutEffect, useMemo } from "react";
import type { GameDetail } from "../lib/catalog";
import type { GroupedRelatedApps } from "../lib/related";
import type { PlayerHistoryResult } from "../lib/player-history";
import {
  type PriceState,
  type PriceHistoryResult,
} from "../lib/prices";
import { getCanonicalPublisherPath } from "../lib/slug";
import { getCommunityIconUrl } from "../lib/lqip";
import { PlayerPanel } from "./player-panel";
import { PlayerHistoryChart } from "./player-history";
import { PriceHistoryChart } from "./price-history";
import { RelatedApps } from "./related-apps";
import { AppLink } from "./app-link";
import { LifecycleHistorySection } from "./lifecycle-history";
import { GameReception, GameScoreHero } from "./game-reception";
import {
  NUMERIC_TO_HISTORY_RANGE,
  NUMERIC_TO_PRICE_RANGE,
  HISTORY_TO_NUMERIC_RANGE,
  PRICE_TO_NUMERIC_RANGE,
  DEFAULT_NUMERIC_RANGE,
  DEFAULT_NUMERIC_PRICE_RANGE,
  type NumericRange,
  type NumericPriceRange,
} from "../lib/game-params";
// The sentinel, the hero flow wrapper, and the first section below it are
// siblings spaced by the container's space-y-6 rhythm, so the sentinel sits
// HERO_ROW_GAP above the hero top and the next section sits HERO_ROW_GAP
// below the hero bottom. The morph range must span (expanded - compact) plus
// that trailing gap: the hero bottom then shrinks at exactly the rate the
// following section scrolls up, reaching compact the moment the section
// touches the compact bar.
const HERO_ROW_GAP = 24;

function useHeroScrollProgress(
  sentinelRef: React.RefObject<HTMLDivElement | null>,
  morphRange: number | null,
) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let rafId = 0;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateProgress = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const el = sentinelRef.current;
        if (!el || morphRange === null) return;
        const rect = el.getBoundingClientRect();
        const stickyTop = window.innerWidth < 768 ? 102 : 56;
        // The morph starts exactly when the hero top (sentinel plus the row
        // gap) reaches the sticky line, not 24px earlier.
        const startTop = stickyTop - HERO_ROW_GAP;
        const scrolledPastStart = startTop - rect.top;
        const rawProgress = Math.min(Math.max(scrolledPastStart / morphRange, 0), 1);
        setProgress(media.matches ? (scrolledPastStart > 0 ? 1 : 0) : rawProgress);
      });
    };

    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
    media.addEventListener?.("change", updateProgress);
    updateProgress();
    return () => {
      window.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
      media.removeEventListener?.("change", updateProgress);
      cancelAnimationFrame(rafId);
    };
  }, [sentinelRef, morphRange]);

  return progress;
}

type HeroIdentity = "title" | "status" | "date" | "store" | "artwork";
type HeroIdentityElement =
  | HTMLHeadingElement
  | HTMLSpanElement
  | HTMLTimeElement
  | HTMLAnchorElement
  | HTMLDivElement;
type HeroIdentityRef = { readonly current: HeroIdentityElement | null };
type HeroIdentityRefs = Record<HeroIdentity, HeroIdentityRef>;
type HeroBox = { left: number; top: number; width: number; height: number };
type HeroGeometry = {
  expanded: Record<HeroIdentity, HeroBox | null>;
  compact: Record<HeroIdentity, HeroBox | null>;
  expandedHeight: number;
  compactHeight: number;
};

function useHeroGeometry(
  heroRef: React.RefObject<HTMLElement | null>,
  identityRefs: HeroIdentityRefs,
  identityKey: number,
): HeroGeometry | null {
  const geometryRef = useRef<HeroGeometry | null>(null);
  const [, forceUpdate] = useState(0);

  useLayoutEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;

    const nodes = Object.values(identityRefs);
    let lastObservedWidth = 0;
    let frameId = 0;

    const capture = (layout: "expanded" | "compact") => {
      hero.dataset.morphLayout = layout;
      hero.style.height = "auto";
      const root = hero.getBoundingClientRect();
      const boxes = {} as Record<HeroIdentity, HeroBox | null>;
      (Object.keys(identityRefs) as HeroIdentity[]).forEach((identity) => {
        const node = identityRefs[identity].current;
        if (!node) {
          boxes[identity] = null;
          return;
        }
        const rect = node.getBoundingClientRect();
        boxes[identity] = {
          left: rect.left - root.left,
          top: rect.top - root.top,
          width: rect.width,
          height: rect.height,
        };
      });
      return { boxes, height: root.height };
    };

    const measure = () => {
      const previousHeight = hero.style.height;
      const previousOverflow = hero.style.overflow;
      const previousProgress = hero.style.getPropertyValue("--hero-morph-progress");
      // Capture the same expanded typography regardless of the current scroll position.
      hero.style.setProperty("--hero-morph-progress", "0");
      const previousHeroTransform = hero.style.transform;
      const previousTransforms = nodes.map((nodeRef) => nodeRef.current?.style.transform ?? "");
      nodes.forEach((nodeRef) => {
        if (nodeRef.current) nodeRef.current.style.transform = "";
      });
      hero.style.transform = "";
      hero.style.overflow = "visible";
      const expanded = capture("expanded");
      const compact = capture("compact");
      delete hero.dataset.morphLayout;
      hero.style.height = previousHeight;
      hero.style.overflow = previousOverflow;
      hero.style.transform = previousHeroTransform;
      hero.style.setProperty("--hero-morph-progress", previousProgress);
      nodes.forEach((nodeRef, index) => {
        if (nodeRef.current) nodeRef.current.style.transform = previousTransforms[index];
      });
      // The observer compares its own content-box width, so border/padding differences do not retrigger measurement.
      geometryRef.current = {
        expanded: expanded.boxes,
        compact: compact.boxes,
        expandedHeight: expanded.height,
        compactHeight: compact.height,
      };
      forceUpdate((value) => value + 1);
    };

    const requestMeasure = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastObservedWidth) > 0.5) {
        lastObservedWidth = width;
        requestMeasure();
      }
    });
    observer?.observe(hero);
    window.addEventListener("resize", requestMeasure);
    measure();

    return () => {
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      window.removeEventListener("resize", requestMeasure);
    };
  }, [heroRef, identityRefs, identityKey]);

  return geometryRef.current;
}

function heroTransform(
  geometry: HeroGeometry | null,
  identity: HeroIdentity,
  progress: number,
  visualScaleY = 1,
): React.CSSProperties | undefined {
  const first = geometry?.expanded[identity];
  const last = geometry?.compact[identity];
  // Identities that the compact layout hides on narrow screens measure as
  // zero-size boxes there; leave them in place and let CSS fade them out
  // rather than flying them toward a degenerate target.
  if (!first || !last || first.width <= 0 || first.height <= 0 || last.width <= 0 || last.height <= 0) {
    return undefined;
  }
  const left = first.left + (last.left - first.left) * progress;
  const top = (first.top + (last.top - first.top) * progress) / visualScaleY;

  // The hero root applies scaleY(visualScaleY) to squash into compact height.
  // Typography must counteract that squash with scaleY(1/visualScaleY) so glyphs
  // render at natural aspect ratio while still moving with the FLIP morph.
  if (identity === "title") {
    return {
      transformOrigin: "top left",
      transform:
        "translate3d(" + (left - first.left).toFixed(3) + "px, " +
        (top - first.top).toFixed(3) + "px, 0) scaleY(" +
        (1 / visualScaleY).toFixed(5) + ")",
      willChange: "transform",
    };
  }

  if (identity === "status" || identity === "date" || identity === "store") {
    return {
      transformOrigin: "top right",
      transform:
        "translate3d(" + (left - first.left).toFixed(3) + "px, " +
        (top - first.top).toFixed(3) + "px, 0) scaleY(" +
        (1 / visualScaleY).toFixed(5) + ")",
      willChange: "transform",
    };
  }

  // Artwork shell retains scale transformation to morph its aspect ratio
  const width = first.width + (last.width - first.width) * progress;
  const height = (first.height + (last.height - first.height) * progress) / visualScaleY;
  return {
    transformOrigin: "top left",
    transform:
      "translate3d(" + (left - first.left).toFixed(3) + "px, " +
      (top - first.top).toFixed(3) + "px, 0) scale(" +
      (width / first.width).toFixed(5) + ", " + (height / first.height).toFixed(5) + ")",
    willChange: "transform",
  };
}

// Fade-only content (and the identities the compact layout hides on narrow
// screens) must keep natural proportions while the hero root squashes: each
// block counter-scales about its own top so glyphs never flatten. The block
// keeps riding up with the root squash; whatever extends past the rising hero
// bottom edge is clipped by the root's overflow, so text never draws outside
// the container. Later blocks (developer/publisher) paint above the earlier
// description text that slides beneath them.
function fadeContentStyle(visualScaleY: number): React.CSSProperties {
  return {
    transformOrigin: "top left",
    transform: "scaleY(" + (1 / visualScaleY).toFixed(5) + ")",
    willChange: "transform",
  };
}

export interface GamePageProps {
  game: GameDetail;
  related?: GroupedRelatedApps;
  playerHistory?: PlayerHistoryResult;
  price?: PriceState | null;
  priceHistory?: PriceHistoryResult | null;
  range?: NumericRange;
  pricerange?: NumericPriceRange;
  eventId?: string | null;
  onRangeChange?: (range: NumericRange) => void;
  onPriceRangeChange?: (pricerange: NumericPriceRange) => void;
  onEventChange?: (eventId: string | null) => void;
}

export function GamePageView({
  game,
  related,
  playerHistory,
  price,
  priceHistory,
  range,
  pricerange,
  eventId,
  onRangeChange,
  onPriceRangeChange,
  onEventChange,
}: GamePageProps) {
  const historyRange = NUMERIC_TO_HISTORY_RANGE[range ?? DEFAULT_NUMERIC_RANGE];
  const priceRange = NUMERIC_TO_PRICE_RANGE[pricerange ?? DEFAULT_NUMERIC_PRICE_RANGE];
  const overviewEvents = getLifecycleOverviewEvents(game);
  const mainReleaseDate = getMainReleaseDate(game);
  const releaseStatusLabel =
    game.release_status === "upcoming"
      ? "Upcoming"
      : game.release_status === "unannounced"
        ? "Unannounced"
        : "Released";
  const isUnreleased = game.release_status === "upcoming" || game.release_status === "unannounced";
  const sentinelRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const dateRef = useRef<HTMLTimeElement>(null);
  const storeRef = useRef<HTMLAnchorElement>(null);
  const artworkRef = useRef<HTMLDivElement>(null);
  const identityRefs = useMemo<HeroIdentityRefs>(
    () => ({ title: titleRef, status: statusRef, date: dateRef, store: storeRef, artwork: artworkRef }),
    [],
  );
  const sectionNavRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = sectionNavRef.current;
    if (!nav) return;

    const links = Array.from(nav.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
    if (links.length === 0) return;
    const targets = links
      .map((link) => {
        const id = link.getAttribute("href")?.slice(1);
        return id ? document.getElementById(id) : null;
      })
      .filter((el): el is HTMLElement => el !== null);

    const updateActiveLink = (activeId: string | null) => {
      links.forEach((link) => {
        const isActive = activeId ? link.getAttribute("href") === `#${activeId}` : false;
        link.setAttribute("aria-current", isActive ? "true" : "false");
      });
    };

    const updateFromScroll = () => {
      const navRect = nav.getBoundingClientRect();
      const readingLine = navRect.bottom + 20;
      let activeId: string | null = null;

      for (const target of targets) {
        const rect = target.getBoundingClientRect();
        if (rect.top <= readingLine && rect.bottom > readingLine) {
          activeId = target.id;
          break;
        }
      }

      if (!activeId && targets.length > 0) {
        if (targets[0].getBoundingClientRect().top > readingLine) {
          activeId = targets[0].id;
        } else {
          for (let i = targets.length - 1; i >= 0; i--) {
            if (targets[i].getBoundingClientRect().top <= readingLine) {
              activeId = targets[i].id;
              break;
            }
          }
        }
      }

      if (activeId) {
        updateActiveLink(activeId);
      }
    };

    let frameId = 0;
    const onScroll = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(updateFromScroll);
    };

    updateFromScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("scroll", onScroll);
    };
  }, [related]);
  const geometry = useHeroGeometry(heroRef, identityRefs, game.appid);
  // The scroll range is measured from the captured layouts: shrinking from the
  // expanded height to the compact height takes exactly as much scroll as the
  // distance the following section needs to travel up to the compact bar.
  const morphRange = geometry
    ? Math.max(1, geometry.expandedHeight - geometry.compactHeight + HERO_ROW_GAP)
    : null;
  const scrollProgress = useHeroScrollProgress(sentinelRef, morphRange);
  // One shared 0-to-1 progress drives every morph animation: fades, FLIP
  // transforms, typography, and the artwork crossfade all start and finish
  // together.
  const progress = scrollProgress;
  const communityIconUrl = game.icon_hash ? getCommunityIconUrl(game.appid, game.icon_hash) : null;
  const compactImage = communityIconUrl ?? game.icon_lqip ?? game.header_lqip ?? game.header_image ?? null;
  const headerImage = game.header_image ?? game.header_lqip ?? compactImage;
  const dateLabel = mainReleaseDate
    ? formatReleaseDate(mainReleaseDate)
    : isUnreleased
      ? "TBA"
      : "—";
  const visualScaleY = geometry && geometry.expandedHeight > 0
    ? 1 + (geometry.compactHeight / geometry.expandedHeight - 1) * progress
    : 1;
  // The developer/publisher card chrome stays fully opaque while the
  // description slides beneath it (a fading background would let the text
  // ghost through); only its labels fade with the shared progress. The chrome
  // itself fades during the final stretch, once the rising hero edge has
  // eaten all but a small remnant of the cards.
  const publisherChromeOpacity = Math.min(1, Math.max(0, (1 - progress) / 0.15));
  const heroStyle = {
    transformOrigin: "top left",
    transform: geometry ? "scaleY(" + visualScaleY.toFixed(5) + ")" : undefined,
    // Keep the FLIP source box stable while its title changes font size.
    height: geometry ? `${geometry.expandedHeight}px` : undefined,
    willChange: "transform",
    ["--hero-morph-progress"]: progress,
  } as React.CSSProperties & Record<string, string | number | undefined>;

  return (
    <div
      className="game-page-container max-w-7xl mx-auto px-4 py-8 space-y-6"
      style={{
        ["--hero-compact-height" as string]: geometry?.compactHeight
          ? `${geometry.compactHeight}px`
          : "50px",
      }}
    >
      <div ref={sentinelRef} className="h-0 w-full pointer-events-none" aria-hidden="true" />
      <div
        className="morphing-game-hero-flow"
        style={{ height: geometry ? geometry.expandedHeight + "px" : undefined }}
      >
      <header
        ref={heroRef}
        className="morphing-game-hero relative border border-zinc-800 bg-zinc-950/95 backdrop-blur-md"
        style={heroStyle}
      >
        {/* Bottom edge of the compact sticky bar; counter-scaled so it renders 1px despite the root squash */}
        <div
          aria-hidden="true"
          className="hero-bottom-edge"
          style={{
            height: "1px",
            opacity: progress,
            transform: "scaleY(" + (1 / visualScaleY).toFixed(5) + ")",
            transformOrigin: "bottom",
          }}
        />
        <div className="hero-stage">
          <div className="hero-topbar">
            <span
              className="hero-type px-2 py-0.5 bg-orange-500/10 text-orange-400 border border-orange-500/30 text-[10px] font-mono uppercase tracking-widest"
              data-game-fade-only="type"
              style={{ ...fadeContentStyle(visualScaleY), opacity: 1 - progress }}
            >
              {game.type.toUpperCase()}
            </span>
            <span
              ref={statusRef}
              data-game-identity="status"
              className="hero-status border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-bold uppercase tracking-wider text-zinc-300 text-xs ml-auto"
              style={
                heroTransform(geometry, "status", progress, visualScaleY) ??
                fadeContentStyle(visualScaleY)
              }
            >
              {releaseStatusLabel}
            </span>
            <time
              ref={dateRef}
              data-game-identity="date"
              dateTime={mainReleaseDate && isPreciseReleaseDate(mainReleaseDate) ? mainReleaseDate : undefined}
              className="hero-date text-zinc-200 text-xs font-mono"
              style={
                heroTransform(geometry, "date", progress, visualScaleY) ??
                fadeContentStyle(visualScaleY)
              }
            >
              {dateLabel}
            </time>
            <a
              ref={storeRef}
              data-game-identity="store"
              href={"https://store.steampowered.com/app/" + game.appid + "/"}
              target="_blank"
              rel="noreferrer"
              className="hero-store text-orange-400 hover:text-orange-300 hover:underline inline-flex items-center gap-1 font-mono text-xs"
              style={
                // On narrow screens the compact layout hides the store (no FLIP
                // target) and CSS fades it with the shared progress; the
                // <=767px stylesheet rule pins pointer-events to none for the
                // whole mobile state, so restore clickability while the link is
                // visible and make it inert only once fully faded out.
                heroTransform(geometry, "store", progress, visualScaleY) ?? {
                  ...fadeContentStyle(visualScaleY),
                  pointerEvents: progress >= 1 ? "none" : "auto",
                }
              }
            >
              Steam Store ↗
            </a>
          </div>

          <div className="hero-main">
            <div
              ref={artworkRef}
              data-game-identity="artwork"
              className="hero-artwork border border-zinc-800 overflow-hidden bg-zinc-900 relative shrink-0"
              style={heroTransform(geometry, "artwork", progress, visualScaleY)}
            >
              {headerImage && (
                <img
                  src={headerImage}
                  alt={game.name}
                  className="hero-art-image hero-art-header"
                  style={{
                    opacity: compactImage === headerImage ? 1 : 1 - progress,
                    backgroundImage: game.header_lqip ? "url(" + game.header_lqip + ")" : undefined,
                  }}
                />
              )}
              {compactImage && compactImage !== headerImage && (
                <img
                  src={compactImage}
                  alt=""
                  className="hero-art-image hero-art-compact"
                  style={{ opacity: progress }}
                />
              )}
            </div>

            <div className="hero-copy">
              <h1
                ref={titleRef}
                data-game-identity="title"
                className="hero-title font-mono font-bold text-zinc-100 tracking-tight"
                style={heroTransform(geometry, "title", progress, visualScaleY)}
              >
                {game.name}
              </h1>

              {overviewEvents.length > 0 && (
                <div
                  data-game-fade-only="lifecycle"
                  className="hero-lifecycle"
                  style={{
                    ...fadeContentStyle(visualScaleY),
                    opacity: 1 - progress,
                    pointerEvents: progress >= 1 ? "none" : "auto",
                  }}
                >
                  <LifecycleTable events={overviewEvents} />
                </div>
              )}

              {game.description && (
                <div
                  data-game-fade-only="description"
                  className="hero-description"
                  style={{
                    ...fadeContentStyle(visualScaleY),
                    opacity: 1 - progress,
                    pointerEvents: progress >= 1 ? "none" : "auto",
                  }}
                >
                  <p className="text-sm text-zinc-400 leading-relaxed font-sans">{game.description}</p>
                </div>
              )}

              <div
                data-game-fade-only="publisher"
                className="hero-publishers grid grid-cols-2 gap-3 pt-2 text-xs font-mono"
                style={{
                  ...fadeContentStyle(visualScaleY),
                  pointerEvents: progress >= 1 ? "none" : "auto",
                }}
              >
                <div
                  className="border border-zinc-800 bg-zinc-900 p-2.5"
                  style={{ opacity: publisherChromeOpacity }}
                >
                  <div className="text-zinc-500 text-[10px] uppercase" style={{ opacity: 1 - progress }}>Developer</div>
                  <div className="text-zinc-200 font-medium truncate" style={{ opacity: 1 - progress }}>
                    {game.developer ? (
                      <AppLink href={getCanonicalPublisherPath(game.developer)} className="hover:text-orange-400 hover:underline transition-colors">
                        {game.developer}
                      </AppLink>
                    ) : (
                      "Unknown"
                    )}
                  </div>
                </div>
                <div
                  className="border border-zinc-800 bg-zinc-900 p-2.5"
                  style={{ opacity: publisherChromeOpacity }}
                >
                  <div className="text-zinc-500 text-[10px] uppercase" style={{ opacity: 1 - progress }}>Publisher</div>
                  <div className="text-zinc-200 font-medium truncate" style={{ opacity: 1 - progress }}>
                    {game.publisher ? (
                      <AppLink href={getCanonicalPublisherPath(game.publisher)} className="hover:text-orange-400 hover:underline transition-colors">
                        {game.publisher}
                      </AppLink>
                    ) : (
                      "Unknown"
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>
      </div>

      <LifecycleHistorySection appid={game.appid} />
      <nav
        ref={sectionNavRef}
        aria-label="Game page sections"
        className="game-section-nav flex h-8 min-h-[32px] items-center overflow-x-auto border border-zinc-800 bg-zinc-950/95 backdrop-blur-md px-1 font-mono"
      >
        <a
          href="#game-reception"
          className="inline-flex h-8 min-h-[32px] shrink-0 items-center border-b-2 border-transparent px-2.5 text-[11px] uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 transition-colors"
        >
          Reception
        </a>
        <a
          href="#player-history"
          className="inline-flex h-8 min-h-[32px] shrink-0 items-center border-b-2 border-transparent px-2.5 text-[11px] uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 transition-colors"
        >
          Player History
        </a>
        <a
          href="#price-history"
          className="inline-flex h-8 min-h-[32px] shrink-0 items-center border-b-2 border-transparent px-2.5 text-[11px] uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 transition-colors"
        >
          Price History
        </a>
        {related && (
          <a
            href="#related-content"
            className="inline-flex h-8 min-h-[32px] shrink-0 items-center border-b-2 border-transparent px-2.5 text-[11px] uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 transition-colors"
          >
            Related Content
          </a>
        )}
      </nav>

      <div className="game-activity-grid">
        <a
          href="#game-reception"
          className="group block transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          aria-label="Current Player Score - click to view Reception details"
        >
          <GameScoreHero appid={game.appid} className="transition-colors group-hover:border-zinc-700" />
        </a>
        <PlayerPanel
          key={game.appid}
          appid={game.appid}
          initialData={{
            appid: game.appid,
            latest_players: game.latest_players,
            observed_at: game.last_observed_at,
            current_price: price ?? null,
          }}
        />
      </div>

      <GameReception
        key={game.appid}
        appid={game.appid}
        range={historyRange}
        onRangeChange={(r) => {
          const nextNum = HISTORY_TO_NUMERIC_RANGE[r];
          onRangeChange?.(nextNum);
        }}
        activeEventId={eventId}
        onSelectEvent={onEventChange}
      />

      <section id="player-history" className="scroll-mt-28">
        <PlayerHistoryChart
          key={game.appid}
          appid={game.appid}
          range={historyRange}
          onRangeChange={(r) => {
            const nextNum = HISTORY_TO_NUMERIC_RANGE[r];
            onRangeChange?.(nextNum);
          }}
          initialRange={historyRange}
          initialData={playerHistory}
        />
      </section>

      <section id="price-history" className="scroll-mt-28">
        <PriceHistoryChart
          key={"price-" + game.appid}
          appid={game.appid}
          range={priceRange}
          onRangeChange={(r) => {
            const nextNum = PRICE_TO_NUMERIC_RANGE[r];
            onPriceRangeChange?.(nextNum);
          }}
          initialRange={priceRange}
          initialData={priceHistory ?? undefined}
        />
      </section>
      {related && (
        <section id="related-content" className="scroll-mt-28">
          <RelatedApps parent={game} grouped={related} />
        </section>
      )}
    </div>
  );
}

type LifecycleEventKind = "expected" | "steam-availability" | "left-ea" | "one-dot-zero" | "patch";

interface LifecycleDisplayEvent {
  kind: LifecycleEventKind;
  label: string;
  date: string | null;
  dateTime: string | null;
}

const lifecycleEventClasses: Record<LifecycleEventKind, string> = {
  expected: "border-orange-500/40 bg-orange-500/10 text-orange-300",
  "steam-availability": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "left-ea": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "one-dot-zero": "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  patch: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

function getLifecycleOverviewEvents(game: GameDetail): LifecycleDisplayEvent[] {
  const events: LifecycleDisplayEvent[] = [];
  const seen = new Set<string>();
  const storedEvents = game.release_events ?? [];

  const addEvent = (kind: LifecycleEventKind, label: string, dateTime: string | null) => {
    const key = kind + ":" + (dateTime ?? "undated");
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ kind, label, date: dateTime ? formatReleaseDate(dateTime) : null, dateTime });
  };

  if (game.release_status === "upcoming" && game.release_date) {
    addEvent("expected", "Expected release", game.release_date);
  }

  if (game.release_status === "released") {
    addEvent("steam-availability", "Available on Steam", game.original_steam_release_date ?? game.steam_release_date);
  }

  if (
    game.is_early_access !== true &&
    (Boolean(game.release_from_early_access_date) || game.has_left_early_access === true)
  ) {
    addEvent("left-ea", "Left Early Access", game.release_from_early_access_date);
  }

  const versionOneEvent = storedEvents.find((event) => (event.event_type as string) === "version_1_0");
  if (versionOneEvent) {
    addEvent("one-dot-zero", "Version 1.0", versionOneEvent.event_date);
  }

  const latestPatch = storedEvents
    .filter((event) => event.event_type === "patch" && event.event_date)
    .sort((left, right) => releaseDateValue(right.event_date) - releaseDateValue(left.event_date))[0];
  if (latestPatch) {
    addEvent("patch", "Latest patch", latestPatch.event_date);
  }

  return events.sort((left, right) => releaseDateValue(right.dateTime) - releaseDateValue(left.dateTime));
}

function getMainReleaseDate(game: GameDetail): string | null {
  if (game.release_status === "upcoming") {
    return game.release_date ?? game.original_release_date ?? game.steam_release_date;
  }
  if (game.release_status === "unannounced") {
    return game.release_date ?? null;
  }
  return game.original_release_date ?? game.steam_release_date ?? game.release_date;
}

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidDateOnly(value: string): boolean {
  if (!dateOnlyPattern.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value + "T");
}

function isPreciseReleaseDate(value: string | null): boolean {
  if (!value) return false;
  if (isValidDateOnly(value)) return true;
  return timestampPattern.test(value) && isValidDateOnly(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));
}

function formatReleaseDate(value: string): string {
  const isDateOnly = isValidDateOnly(value);
  if (!isPreciseReleaseDate(value)) return value;
  const date = new Date(isDateOnly ? value + "T00:00:00Z" : value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: isDateOnly ? "UTC" : "America/Los_Angeles",
  }).format(date);
}

function toUtcDate(value: string): string | null {
  if (isValidDateOnly(value)) return value + "T00:00:00Z";
  return isPreciseReleaseDate(value) ? value : null;
}

function releaseDateValue(value: string | null): number {
  const timestamp = value ? toUtcDate(value) : null;
  return timestamp ? Date.parse(timestamp) : Number.NEGATIVE_INFINITY;
}

function LifecycleBadge({ event }: { event: LifecycleDisplayEvent }) {
  return (
    <span className={"border py-0.5 font-bold uppercase px-1.5 text-[9px] tracking-wider " + lifecycleEventClasses[event.kind]}>
      {event.label}
    </span>
  );
}

function LifecycleTable({ events }: { events: LifecycleDisplayEvent[] }) {
  return (
    <section
      aria-label="Release lifecycle overview"
      className="w-fit max-w-full py-1 font-mono md:float-right md:mb-2 md:ml-6"
    >
      <table className="border-collapse text-xs">
        <tbody>
          {events.map((event) => (
            <tr key={event.kind + "-" + (event.dateTime ?? "undated")} className="align-middle">
              <td className="py-0.5 text-left text-zinc-400 align-middle">
                {event.date && isPreciseReleaseDate(event.dateTime) ? (
                  <time dateTime={event.dateTime ?? undefined}>{event.date}</time>
                ) : (
                  event.date && <span>{event.date}</span>
                )}
              </td>
              <td className="py-0.5 pl-4 text-right align-middle">
                <LifecycleBadge event={event} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default GamePageView;
