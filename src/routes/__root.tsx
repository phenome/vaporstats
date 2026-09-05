import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { SiteHeader } from "../components/site-header";
import { AppLink } from "../components/app-link";
import { ConsentBanner, FooterPrivacyControl } from "../components/consent-banner";
import { initAnalyticsIfConsented } from "../lib/analytics";
import "../styles.css";

export interface RootRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RootRouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "VaporStats - Steam Analytics" },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  notFoundComponent: RootNotFoundComponent,
  component: RootComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <RootDocument>
        <Outlet />
      </RootDocument>
    </QueryClientProvider>
  );
}

function RootNotFoundComponent() {
  return (
    <section className="mx-auto flex min-h-[50vh] max-w-7xl flex-col items-center justify-center gap-4 px-4 py-16 text-center font-mono">
      <p className="text-4xl font-bold text-orange-500">404</p>
      <h1 className="text-xl font-semibold text-zinc-100">Page Not Found</h1>
      <p className="max-w-md text-sm text-zinc-500">
        VaporStats could not find this page.
      </p>
      <AppLink
        href="/"
        className="inline-flex min-h-[44px] items-center justify-center bg-orange-600 px-4 text-xs font-semibold uppercase tracking-wider text-white transition-colors hover:bg-orange-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      >
        Return home
      </AppLink>
    </section>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    // Attempt dynamic init exclusively if explicit consent was previously stored
    void initAnalyticsIfConsented();
  }, []);

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans antialiased">
        <SiteHeader />
        <main className="flex-1">
          {children}
        </main>
        <footer className="border-t border-zinc-900 bg-zinc-950 py-6 text-center text-xs font-mono text-zinc-600">
          <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div>VAPORSTATS © 2026 — AGPL-3.0</div>
            <div className="flex items-center gap-4">
              <AppLink
                href="/privacy"
                className="text-zinc-500 hover:text-zinc-300 transition-colors underline decoration-zinc-800 underline-offset-4 min-h-[44px] inline-flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              >
                Privacy Notice
              </AppLink>
              <FooterPrivacyControl />
            </div>
          </div>
        </footer>
        <ConsentBanner />
        <Scripts />
      </body>
    </html>
  );
}
