import type {
  PriceHistoryEntry,
  PriceHistoryRange,
  PriceState,
} from "./prices";
import { isPriceDiscounted } from "./price-presentation";

export interface PriceChartPoint {
  timestamp: number;
  observedAt: string;
  sourceTimestamp: string;
  inferred: boolean;
  currency: string;
  isAvailable: boolean;
  isFree: boolean;
  discountPercent: number;
  finalPriceCents: number | null;
  initialPriceCents: number | null;
  priceCents: number | null;
  basePriceCents: number | null;
  savingsCents: number | null;
  isDiscounted: boolean;
}

export interface PriceChartDomain {
  start: number;
  end: number;
}

export interface PriceChartGeometryOptions {
  width?: number;
  height?: number;
  padLeft?: number;
  padRight?: number;
  padTop?: number;
  padBottom?: number;
}

export interface PriceChartCoordinate {
  point: PriceChartPoint;
  x: number;
  y: number | null;
}

export interface PriceChartPath {
  d: string;
  inferred: boolean;
  from: PriceChartPoint;
  to: PriceChartPoint;
}

export interface PriceChartSavingsArea {
  d: string;
  from: PriceChartPoint;
  to: PriceChartPoint;
  savingsCents: number;
}

export interface PriceChartGeometry {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  plotWidth: number;
  plotHeight: number;
  minPriceCents: number;
  maxPriceCents: number;
  coordinates: PriceChartCoordinate[];
  paths: PriceChartPath[];
  savingsAreas: PriceChartSavingsArea[];
  isolatedPoints: PriceChartCoordinate[];
}

type PriceRecord = PriceHistoryEntry | PriceState;

function timestamp(value: string | Date | null | undefined): number | null {
  const result = value instanceof Date ? value.getTime() : new Date(value ?? "").getTime();
  return Number.isFinite(result) ? result : null;
}

function toPoint(
  record: PriceRecord,
  at: number,
  inferred = false,
  sourceTimestamp = record.observed_at
): PriceChartPoint {
  const available = Boolean(record.is_available);
  const free = Boolean(record.is_free);
  const finalPrice = record.final_price;
  const initialPrice = record.initial_price;
  const priceCents = !available ? null : free ? 0 : finalPrice;
  const basePriceCents = available ? initialPrice : null;
  const discounted = isPriceDiscounted(record);

  return {
    timestamp: at,
    observedAt: inferred ? new Date(at).toISOString() : record.observed_at,
    sourceTimestamp,
    inferred,
    currency: record.currency || "USD",
    isAvailable: available,
    isFree: free,
    discountPercent: record.discount_percent ?? 0,
    finalPriceCents: finalPrice,
    initialPriceCents: initialPrice,
    priceCents,
    basePriceCents,
    savingsCents: discounted ? initialPrice! - finalPrice! : null,
    isDiscounted: discounted,
  };
}

/** Builds actual observations plus one carried-forward response-anchor point. */
export function buildPriceChartPoints(
  history: readonly PriceHistoryEntry[],
  currentPrice: PriceState | null | undefined,
  anchorTimestamp?: string | null
): PriceChartPoint[] {
  const anchor = timestamp(anchorTimestamp);
  const rows: PriceRecord[] = [...history];
  if (currentPrice) {
    const currentTime = timestamp(currentPrice.observed_at);
    if (currentTime !== null && (anchor === null || currentTime <= anchor)) {
      if (!rows.some((row) => row.observed_at === currentPrice.observed_at)) rows.push(currentPrice);
    }
  }

  const points = rows
    .map((row) => {
      const at = timestamp(row.observed_at);
      return at === null ? null : toPoint(row, at);
    })
    .filter((point): point is PriceChartPoint => point !== null)
    .filter((point) => anchor === null || point.timestamp <= anchor)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (points.length === 0) return [];
  const end = anchor ?? points[points.length - 1].timestamp;
  const last = points[points.length - 1];
  if (end > last.timestamp) {
    points.push({
      ...last,
      timestamp: end,
      observedAt: new Date(end).toISOString(),
      inferred: true,
      sourceTimestamp: last.sourceTimestamp,
    });
  }
  return points;
}

export function getPriceChartDomain(
  points: readonly PriceChartPoint[],
  range: PriceHistoryRange,
  anchorTimestamp?: string | null
): PriceChartDomain {
  const actual = points.filter((point) => !point.inferred);
  const anchor = timestamp(anchorTimestamp) ?? actual[actual.length - 1]?.timestamp ?? Date.now();
  const first = actual[0]?.timestamp ?? anchor;
  const start = range === "all"
    ? first
    : anchor - (range === "30d" ? 30 : range === "6m" ? 180 : 365) * 24 * 60 * 60 * 1000;
  return { start: Math.min(start, anchor), end: anchor };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function validConnection(from: PriceChartPoint, to: PriceChartPoint) {
  return (
    from.priceCents !== null &&
    to.priceCents !== null &&
    from.currency === to.currency
  );
}

/** Converts points to stable SVG paths; no browser measurement or locale is involved. */
export function buildPriceChartGeometry(
  points: readonly PriceChartPoint[],
  domain: PriceChartDomain,
  options: PriceChartGeometryOptions = {}
): PriceChartGeometry {
  const width = options.width ?? 900;
  const height = options.height ?? 260;
  const padLeft = options.padLeft ?? 44;
  const padRight = options.padRight ?? 18;
  const padTop = options.padTop ?? 18;
  const padBottom = options.padBottom ?? 34;
  const plotWidth = Math.max(1, width - padLeft - padRight);
  const plotHeight = Math.max(1, height - padTop - padBottom);
  const maxObserved = points.reduce(
    (max, point) => Math.max(max, point.priceCents ?? 0, point.basePriceCents ?? 0),
    100
  );
  const maxPriceCents = Math.max(100, maxObserved);
  const span = Math.max(1, domain.end - domain.start);
  const xFor = (at: number) =>
    padLeft + (clamp(at, domain.start, domain.end) - domain.start) / span * plotWidth;
  const yFor = (cents: number) => padTop + plotHeight - cents / maxPriceCents * plotHeight;
  const coordinates = points.map((point) => ({
    point,
    x: xFor(point.timestamp),
    y: point.priceCents === null ? null : yFor(point.priceCents),
  }));
  const paths: PriceChartPath[] = [];
  const savingsAreas: PriceChartSavingsArea[] = [];
  const solidNeighbors = new Set<PriceChartPoint>();

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!validConnection(from, to)) continue;
    const fromX = xFor(from.timestamp);
    const toX = xFor(to.timestamp);
    const fromY = yFor(from.priceCents!);
    const toY = yFor(to.priceCents!);
    paths.push({
      d: `M ${fromX.toFixed(2)} ${fromY.toFixed(2)} H ${toX.toFixed(2)} V ${toY.toFixed(2)}`,
      inferred: from.inferred || to.inferred,
      from,
      to,
    });
    if (!from.inferred && !to.inferred) {
      solidNeighbors.add(from);
      solidNeighbors.add(to);
      if (
        from.isDiscounted &&
        to.isAvailable &&
        to.priceCents !== null &&
        to.basePriceCents !== null &&
        from.basePriceCents !== null &&
        from.currency === to.currency
      ) {
        const baseY = yFor(from.basePriceCents);
        savingsAreas.push({
          d: `M ${fromX.toFixed(2)} ${fromY.toFixed(2)} H ${toX.toFixed(2)} V ${baseY.toFixed(2)} H ${fromX.toFixed(2)} Z`,
          from,
          to,
          savingsCents: from.savingsCents ?? 0,
        });
      }
    }
  }

  const isolatedPoints = coordinates.filter(
    ({ point, y }) => !point.inferred && y !== null && !solidNeighbors.has(point)
  );

  return {
    width,
    height,
    padLeft,
    padRight,
    padTop,
    padBottom,
    plotWidth,
    plotHeight,
    minPriceCents: 0,
    maxPriceCents,
    coordinates,
    paths,
    savingsAreas,
    isolatedPoints,
  };
}
