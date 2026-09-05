import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/developer/$developer")({
  loader: ({ params }) => {
    throw redirect({
      href: `/publisher/${params.developer}`,
      statusCode: 301,
    });
  },
});
