import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { listPublishers, type PublisherSummary } from "../lib/publishers";
import { getDb } from "../lib/db-access";
import { getPageCacheHeaders } from "../lib/cache";
import { PublishersIndexView } from "../components/publisher-page";
import { RouteDataError, RouteLoading } from "../components/route-state";

function validPage(value: unknown): number {
  const page = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

const getPublishers = createServerFn({ method: "GET" })
  .validator((data: { page: number }) => {
    if (!data || !Number.isSafeInteger(data.page) || data.page < 1) {
      throw new Error("Invalid publisher page");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const db = await getDb();
    return listPublishers(db, data.page, 50);
  });

function publishersQueryOptions(page: number) {
  return {
    queryKey: ["publishers", page],
    queryFn: () => getPublishers({ data: { page } }),
  };
}

export const Route = createFileRoute("/publishers/")({
  headers: () => getPageCacheHeaders(),
  validateSearch: (search: Record<string, unknown>) => ({ page: validPage(search.page) }),
  loaderDeps: ({ search: { page } }) => ({ page }),
  loader: async ({ deps: { page }, context, preload }) => {
    const query = publishersQueryOptions(page);
    if (preload) {
      void context.queryClient.prefetchQuery(query);
      return;
    }
    const data = await context.queryClient.ensureQueryData(query);
    return { page, data, updatedAt: context.queryClient.getQueryState(query.queryKey)?.dataUpdatedAt };
  },
  component: PublishersRouteComponent,
});

function PublishersRouteComponent() {
  const { page } = Route.useSearch();
  const loaded = Route.useLoaderData() as
    | { page: number; data: { publishers: PublisherSummary[]; total: number }; updatedAt?: number }
    | undefined;
  const { data, isLoading, isError } = useQuery({
    ...publishersQueryOptions(page),
    initialData: loaded?.page === page ? loaded.data : undefined,
    initialDataUpdatedAt: loaded?.page === page ? loaded.updatedAt : undefined,
  });

  if (isLoading) {
    return <RouteLoading label="Loading publishers..." />;
  }
  if (isError) {
    return <RouteDataError />;
  }

  return <PublishersIndexView publishers={data?.publishers ?? []} total={data?.total ?? 0} page={page} />;
}
