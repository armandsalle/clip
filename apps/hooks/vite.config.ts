import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Pas de dev local : Stream ne peut pas joindre localhost (le dev sonde l'encodage).
  plugins: process.env.VITEST ? [] : [cloudflare()],
  run: {
    tasks: {
      deploy: { command: "cf deploy --mode production", cache: false },
      build: {
        command: "cf build",
        cache: { env: ["CLIP_*"], input: [{ auto: true }, "!.cloudflare/**"] },
      },
    },
  },
});
