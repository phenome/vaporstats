import React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { CACHE_POLICIES } from "../lib/cache";
import { PrivacyNoticeView } from "../components/privacy-notice";

export const Route = createFileRoute("/privacy")({
  headers: () => ({
    "Cache-Control": CACHE_POLICIES.entity,
    "Vary": "Accept-Encoding",
  }),
  component: PrivacyRouteComponent,
});

function PrivacyRouteComponent(): React.JSX.Element {
  return <PrivacyNoticeView />;
}

export function handlePrivacyHttpRequest(_request: Request): Response {
  const content = renderToString(<PrivacyNoticeView />);
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Notice - VaporStats</title>
  </head>
  <body class="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans antialiased">
    <main class="flex-1">${content}</main>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": CACHE_POLICIES.entity,
      "Vary": "Accept-Encoding",
    },
  });
}
