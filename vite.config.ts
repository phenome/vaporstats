import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { optimizeAll } from "./scripts/optimize-images";

let optimized = false;
function imageOptimizerPlugin() {
  return {
    name: "vite-plugin-image-optimizer",
    async buildStart() {
      if (!optimized) {
        optimized = true;
        await optimizeAll();
      }
    },
  };
}

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
    imageOptimizerPlugin(),
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
