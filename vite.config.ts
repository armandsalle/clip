import { recommended as effectRules } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    // Règles Effect type-aware, injectées dans oxlint-tsgolint par `effect-tsgo patch` (script prepare).
    plugins: effectRules.plugins,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      ...effectRules.rules,
      // Les modules "unstable" d'Effect sont utilisés exprès, versions figées dans le catalog.
      "effecttsgo/unstable-api-usage": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
    // Commandes à effets de bord (base, comptes Cloudflare et Neon) : jamais en cache,
    // et l'environnement complet leur est transmis.
    tasks: {
      "db:up": { command: "docker compose up -d --wait", cache: false },
      "db:migrate": { command: "vp exec drizzle-kit migrate", cwd: "packages/db", cache: false },
      "db:seed": { command: "node scripts/seed.ts", cwd: "packages/db", cache: false },
      "db:migrate:production": { command: "node scripts/migrate-production.ts", cache: false },
      "pr:up": { command: "node scripts/env.ts up", cache: false },
      "pr:preview": { command: "node scripts/env.ts preview", cache: false },
      "pr:down": { command: "node scripts/env.ts down", cache: false },
      "staging:up": { command: "node scripts/env.ts up staging", cache: false },
      smoke: { command: "node scripts/smoke.ts", cache: false },
    },
  },
});
