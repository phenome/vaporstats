import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/developers/")({
  loader: () => {
    throw redirect({
      href: "/publishers",
      statusCode: 301,
    });
  },
});
