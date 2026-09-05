import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
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
    tanstackStart({
      server: {
        entry: "./server",
      },
      prerender: {
        enabled: false,
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
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start", "@tanstack/react-query"],
  },
  ssr: {
    noExternal: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start", "@tanstack/react-query"],
  },
  environments: {
    ssr: {
      optimizeDeps: {
        include: ["react-dom/server"],
      },
    },
  },
});
