import React from "react";
import { renderToString } from "react-dom/server";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getPublisherGames } from "../lib/publishers";
import { getDb } from "../lib/db-access";
import type { AppDatabase } from "../lib/db";
import { parsePublisherSlug, getCanonicalPublisherPath } from "../lib/slug";
import { CACHE_POLICIES, getEntityCacheHeaders } from "../lib/cache";
import { PublisherPageView } from "../components/publisher-page";
import { AppLink } from "../components/app-link";
import { RouteDataError, RouteLoading } from "../components/route-state";
const getPublisher = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => {
    if (!data || typeof data.slug !== "string") {
      throw new Error("Invalid publisher slug");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const db = await getDb();
    return getPublisherGames(db, data.slug);
  });

export function publisherQueryOptions(slug: string) {
  return {
    queryKey: ["publisher", slug],
    queryFn: () => getPublisher({ data: { slug } }),
  };
}

export const Route = createFileRoute("/publisher/$publisher")({
  headers: () => getEntityCacheHeaders(),
  loader: ({ params, context }) => {
    const parsed = parsePublisherSlug(params.publisher);
    if (!parsed || !parsed.slug) {
      throw notFound();
    }

    void context.queryClient.prefetchQuery(publisherQueryOptions(parsed.slug));
    return {
      slug: parsed.slug,
      requestPath: "/publisher/" + params.publisher,
    };
  },
  component: PublisherRouteComponent,
  notFoundComponent: PublisherNotFoundComponent,
});

function PublisherRouteComponent() {
  const { slug, requestPath } = Route.useLoaderData();
  const { data: publisher, isLoading, isError } = useQuery(publisherQueryOptions(slug));
  const navigate = Route.useNavigate();

  React.useEffect(() => {
    if (!publisher) return;
    const canonicalPath = getCanonicalPublisherPath(publisher.name);
    if (requestPath !== canonicalPath) {
      void navigate({ to: canonicalPath, replace: true });
    }
  }, [navigate, publisher, requestPath]);

  if (isLoading) {
    return <RouteLoading label="Loading publisher data..." />;
  }
  if (isError) {
    return <RouteDataError />;
  }
  if (!publisher) {
    return <PublisherNotFoundComponent />;
  }

  const canonicalPath = getCanonicalPublisherPath(publisher.name);
  if (requestPath !== canonicalPath) {
    return <RouteLoading label="Redirecting to the canonical publisher page..." />;
  }

  return <PublisherPageView publisher={publisher} />;
}

function PublisherNotFoundComponent() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-16 text-center space-y-4 font-mono">
      <div className="text-4xl font-bold text-orange-500">404</div>
      <h1 className="text-xl text-zinc-200">Publisher or Developer Not Found</h1>
      <p className="text-xs text-zinc-500 max-w-md mx-auto">
        The requested publisher or developer does not exist in the catalog or has no eligible games.
      </p>
      <div className="pt-4">
        <AppLink
          href="/publishers"
          className="px-4 py-2 bg-zinc-900 border border-zinc-800 text-zinc-300 text-xs hover:border-orange-500 transition-colors"
        >
          View All Publishers
        </AppLink>
      </div>
    </div>
  );
}

function wrapHtml(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased font-sans">
  ${bodyContent}
</body>
</html>`;
}

/**
 * Pure route HTTP request handler for the canonical publisher route.
 */
export async function handlePublisherHttpRequest(
  request: Request,
  db: AppDatabase
): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/publisher\/([^/]+)$/);

  if (!match) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const rawParam = match[1];
  const parsed = parsePublisherSlug(rawParam);

  if (!parsed || !parsed.slug) {
    const notFoundHtml = renderToString(<PublisherNotFoundComponent />);
    return new Response(wrapHtml("Publisher Not Found", notFoundHtml), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const publisher = await getPublisherGames(db, parsed.slug);
  if (!publisher) {
    const notFoundHtml = renderToString(<PublisherNotFoundComponent />);
    return new Response(wrapHtml("Publisher Not Found", notFoundHtml), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_POLICIES.noStore },
    });
  }

  const canonicalPath = getCanonicalPublisherPath(publisher.name);
  if (url.pathname !== canonicalPath) {
    return new Response(null, {
      status: 301,
      headers: {
        Location: canonicalPath,
        "Cache-Control": CACHE_POLICIES.entity,
      },
    });
  }

  const pageHtml = renderToString(<PublisherPageView publisher={publisher} />);
  return new Response(wrapHtml(`${publisher.name} - VaporStats`, pageHtml), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...getEntityCacheHeaders(),
    },
  });
}
