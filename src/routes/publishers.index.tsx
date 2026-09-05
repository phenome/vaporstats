import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { listPublishers } from "../lib/publishers";
import { getDb } from "../lib/db-access";
import { getPageCacheHeaders } from "../lib/cache";
import { PublishersIndexView } from "../components/publisher-page";
import { RouteDataError, RouteLoading } from "../components/route-state";

const getPublishers = createServerFn({ method: "GET" }).handler(async () => {
  const db = await getDb();
  return listPublishers(db);
});

export const publishersQueryOptions = {
  queryKey: ["publishers"],
  queryFn: () => getPublishers(),
};

export const Route = createFileRoute("/publishers/")({
  headers: () => getPageCacheHeaders(),
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(publishersQueryOptions);
  },
  component: PublishersRouteComponent,
});

function PublishersRouteComponent() {
  const { data: publishers, isLoading, isError } = useQuery(publishersQueryOptions);

  if (isLoading) {
    return <RouteLoading label="Loading publishers..." />;
  }
  if (isError) {
    return <RouteDataError />;
  }

  return <PublishersIndexView publishers={publishers ?? []} />;
}
