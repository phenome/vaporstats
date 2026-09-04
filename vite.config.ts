import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      pages: [
        "/",
        "/games",
        "/search",
        "/rankings",
        "/rankings/peak",
        "/deals",
        "/releases",
        "/privacy",
      ].map((path) => ({ path })),
      prerender: {
        enabled: true,
        crawlLinks: false,
        autoStaticPathsDiscovery: false,
        failOnError: true,
      },
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start"],
  },
  ssr: {
    noExternal: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start"],
  },
  environments: {
    ssr: {
      optimizeDeps: {
        include: ["react-dom/server"],
      },
    },
  },
  server: {
    watch: {
      ignored: ["**/.wrangler/**"],
    },
  },
});
