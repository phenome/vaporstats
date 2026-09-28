import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/developer/$developer")({
  loader: ({ params }) => {
    throw redirect({
      href: `/publisher/~${encodeURIComponent(params.developer)}`,
      statusCode: 301,
    });
  },
});
