import { createFileRoute } from "@tanstack/react-router";
import { listPublishers } from "../lib/publishers";
import { getDb } from "../lib/db";
import { getPageCacheHeaders } from "../lib/cache";
import { PublishersIndexView } from "../components/publisher-page";

export const Route = createFileRoute("/publishers/")({
  headers: () => getPageCacheHeaders(),
  loader: async () => {
    const db = await getDb();
    const publishers = await listPublishers(db);
    return { publishers };
  },
  component: PublishersRouteComponent,
});

function PublishersRouteComponent() {
  const { publishers } = Route.useLoaderData();
  return <PublishersIndexView publishers={publishers} />;
}
