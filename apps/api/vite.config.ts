import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Les tests unitaires tournent dans Node avec des Layers en mémoire : pas de runtime
  // Workers. Le dev local passe par apps/web (les trois Workers ensemble).
  plugins: process.env.VITEST ? [] : [cloudflare()],
  run: {
    tasks: {
      deploy: { command: "cf deploy --mode production", cache: false },
      // cloudflare.config.ts lit CLIP_* et DATABASE_URL : ils font partie de l'empreinte.
      build: {
        command: "cf build",
        cache: { env: ["CLIP_*", "DATABASE_URL"], input: [{ auto: true }, "!.cloudflare/**"] },
      },
    },
  },
});
