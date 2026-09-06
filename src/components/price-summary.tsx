import React from "react";
import { formatLocalDateTime } from "../lib/format";
import { formatPriceCents, type PriceState } from "../lib/prices";
import { formatCurrentPrice, isPriceDiscounted } from "../lib/price-presentation";

export type PriceSummaryVariant = "card" | "hero";
export type PriceSummaryStatus = "loading" | "error" | "success";

export interface PriceSummaryProps {
  price: PriceState | null;
  variant: PriceSummaryVariant;
  status?: PriceSummaryStatus;
}

export function PriceSummary({
  price,
  variant,
  status = "success",
}: PriceSummaryProps) {
  const offer = status === "success" && isPriceDiscounted(price);
  const value =
    status === "loading"
      ? "Loading"
      : status === "error"
        ? "Live data unavailable"
        : formatCurrentPrice(price);
  const isNumeric = /\d/.test(value);
  const discount = price?.discount_percent ?? 0;
  const initialPrice = price?.initial_price ?? null;
  const finalPrice = price?.final_price ?? null;
  const currency = price?.currency ?? "USD";
  const label = offer ? "Current offer" : "Current price";
  const observed = status === "success" && price && price.observed_at
    ? formatLocalDateTime(price.observed_at)
    : null;
  const base = offer && initialPrice !== null
    ? formatPriceCents(initialPrice, currency)
    : null;
  const savings =
    offer && initialPrice !== null && finalPrice !== null
      ? formatPriceCents(initialPrice - finalPrice, currency)
      : null;
  const zeroOffer = offer && finalPrice === 0;
  const tone = offer
    ? "border-orange-500/40 bg-orange-500/10"
    : "border-zinc-800 bg-zinc-950";
  const labelTone = offer ? "text-orange-300" : "text-zinc-400";

  if (variant === "hero") {
    return (
      <section className={`border p-5 ${tone}`} aria-label="Current price">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className={`text-[10px] uppercase tracking-[0.25em] ${labelTone}`}>
                {label}
              </p>
              {offer && (
                <span className="border border-orange-400/40 px-1.5 py-0.5 text-[10px] text-orange-200">
                  -{discount}%
                </span>
              )}
            </div>
            <h2 className="mt-1 text-3xl font-bold tracking-tight text-zinc-100">
              {value}
            </h2>
            {observed && (
              <p className="mt-2 max-w-xl text-xs text-zinc-400" suppressHydrationWarning>{observed}</p>
            )}
          </div>
          {offer && base && savings && (
            <div className="text-right">
              <p className="text-xs text-zinc-400">
                <s>{base}</s> base price
              </p>
              <p className="text-xl font-mono text-zinc-100">{value}</p>
              <p className="text-xs text-emerald-300">Save {savings}</p>
              {zeroOffer && (
                <p className="mt-1 text-xs text-zinc-400">Limited-time offer</p>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <article className={`border p-5 space-y-3 ${tone}`} aria-label="Current price">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 whitespace-nowrap">
          {label}
          {" "}
          <span className="hidden sm:inline">(US / USD)</span>
        </p>
        <span className="flex items-center gap-2">
          {offer && (
            <span className="border border-orange-400/40 px-1.5 py-0.5 text-[10px] text-orange-200">
              -{discount}%
            </span>
          )}
          <span aria-hidden="true" className="w-2 h-2 bg-emerald-500 inline-block shrink-0"></span>
        </span>
      </div>
      <div className="pt-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {offer && savings && <span className="text-xs text-emerald-300">Save {savings}</span>}
          <p
            className={`text-3xl font-mono font-bold tabular-nums text-zinc-100 ${
              isNumeric ? "text-right ml-auto" : "text-left"
            }`}
          >
            {value}
          </p>
        </div>
        {offer && base && (
          <p className="mt-1 text-xs text-zinc-400">
            <s>{base}</s> base price
          </p>
        )}
        {zeroOffer && (
          <p className="mt-1 text-[11px] text-zinc-400">Limited-time offer</p>
        )}
        {observed && <p className="mt-1 text-[11px] font-mono text-zinc-500" suppressHydrationWarning>{observed}</p>}
      </div>
    </article>
  );
}
