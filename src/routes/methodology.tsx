import React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CACHE_POLICIES } from "../lib/cache";
import { MediaMethodologyView } from "../components/media-methodology";

export const Route = createFileRoute("/methodology")({
  head: () => ({
    meta: [{ title: "How media coverage works - VaporStats" }],
  }),
  headers: () => ({
    "Cache-Control": CACHE_POLICIES.entity,
    "Vary": "Accept-Encoding",
  }),
  component: MethodologyRouteComponent,
});

function MethodologyRouteComponent(): React.JSX.Element {
  return <MediaMethodologyView />;
}
