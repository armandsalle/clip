import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Le front (@clip/web) et le Worker sont construits ensemble : le Worker sert la
  // SPA en static assets. Les tests unitaires tournent dans Node avec des Layers en
  // mémoire : pas de runtime Workers ni de session de bindings distants.
  plugins: process.env.VITEST ? [] : [react(), cloudflare()],
  run: {
    tasks: {
      dev: { command: "cf dev", cache: false },
      deploy: { command: "cf deploy --mode production", cache: false },
      // cloudflare.config.ts lit CLIP_* et DATABASE_URL : ils font partie de l'empreinte.
      build: {
        command: "cf build",
        cache: { env: ["CLIP_*", "DATABASE_URL"], input: [{ auto: true }, "!.cloudflare/**"] },
      },
    },
  },
});
