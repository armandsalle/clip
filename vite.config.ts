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
  },
});
