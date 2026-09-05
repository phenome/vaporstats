import React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { RankedGame } from "../lib/player-history";
import type { DealItem } from "../lib/prices";
import type { WeeklyReleasesResult, ReleaseEntity } from "../lib/releases";
import { getHomeCacheHeaders } from "../lib/cache";
import { RouteDataError } from "../components/route-state";
import { HomeSkeleton } from "../components/route-skeletons";
import { HomeComponent } from "../components/home-page";

export interface HomeData {
  trending: RankedGame[];
  deals: DealItem[];
  totalDeals: number;
  currentWeekReleases: WeeklyReleasesResult | null;
  recentReleases: ReleaseEntity[];
}

export async function fetchHomeData(): Promise<HomeData> {
  const responses = await Promise.all([
    fetch("/api/rankings?type=trending"),
    fetch("/api/deals?limit=10&sort=discount"),
    fetch("/api/releases"),
    fetch("/api/releases?type=recent&limit=10"),
  ]);
  if (responses.some((response) => !response.ok)) {
    throw new Error("Home data request failed");
  }
  const [trendingResult, dealsResult, weekResult, recentResult] =
    (await Promise.all(responses.map((response) => response.json()))) as [
      { status?: string; data?: RankedGame[] },
      { status?: string; data?: { deals: DealItem[]; total: number } },
      { status?: string; data?: WeeklyReleasesResult | null },
      { status?: string; data?: ReleaseEntity[] | null },
    ];
  if (
    [trendingResult, dealsResult, weekResult, recentResult].some(
      (result) => result.status === "error"
    )
  ) {
    throw new Error("Home data request failed");
  }
  return {
    trending: trendingResult.data ?? [],
    deals: dealsResult.data?.deals ?? [],
    totalDeals: dealsResult.data?.total ?? 0,
    currentWeekReleases: weekResult.data ?? null,
    recentReleases: recentResult.data ?? [],
  };
}

export const homeQueryOptions = {
  queryKey: ["home-data"],
  queryFn: fetchHomeData,
};

export const Route = createFileRoute("/")({
  ssr: false,
  headers: () => getHomeCacheHeaders(),
  loader: ({ context }) => {
    // Start unawaited prefetch so navigation/hover proceeds immediately
    void context.queryClient.prefetchQuery(homeQueryOptions);
  },
  errorComponent: RouteDataError,
  component: HomeRouteComponent,
});

function HomeRouteComponent() {
  const { data, isLoading, isError, error } = useQuery(homeQueryOptions);

  if (isError) {
    return <RouteDataError />;
  }

  if (isLoading || !data) {
    return <HomeSkeleton />;
  }

  return (
    <HomeComponent
      initialTrending={data.trending}
      initialDeals={data.deals}
      totalDeals={data.totalDeals}
      currentWeekReleases={data.currentWeekReleases}
      recentReleases={data.recentReleases}
    />
  );
}
