import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { listPublishers } from "../lib/publishers";
import { getDb } from "../lib/db-access";
import { getPageCacheHeaders } from "../lib/cache";
import { PublishersIndexView } from "../components/publisher-page";

const getPublishers = createServerFn({ method: "GET" }).handler(async () => {
  const db = await getDb();
  return listPublishers(db);
});
export const Route = createFileRoute("/publishers/")({
  headers: () => getPageCacheHeaders(),
  loader: async () => {
    return { publishers: await getPublishers() };
  },
  component: PublishersRouteComponent,
});

function PublishersRouteComponent() {
  const { publishers } = Route.useLoaderData();
  return <PublishersIndexView publishers={publishers} />;
}
