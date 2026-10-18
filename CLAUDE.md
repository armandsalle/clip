<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Clip

Lire `docs/PRODUCT.md` (produit) et `docs/ARCHITECTURE.md` (tech) avant toute modification.

- Effect **v4** uniquement (`Context.Service`, `Result`, `effect/http-api`, `effect/sql`). La doc fiable est locale : `node_modules/effect/AGENTS.md` et `node_modules/effect/ai-docs/`. La plupart des exemples en ligne sont en v3.
- `packages/domain` reste pur : aucune I/O, l'heure est passée en argument.
- Les handlers n'accèdent jamais à `env` : un service Effect par binding, avec une Layer en mémoire pour les tests.
- Pas de compte : les droits d'admin passent par le secret `x-clip-admin`, stocké haché.
- L'IA est une couche : une étape IA en échec ou coupée ne bloque jamais la lecture.
- Versions : uniquement via le `catalog` de `pnpm-workspace.yaml`, figées exactement.
- Pas de dépendance directe sur `vite` dans `apps/api` (sinon `cf` lance `npx vite` et contourne Vite+).
- Commandes `cf` du Worker : tâches Vite+ (`vp run @clip/api#dev|build|deploy`), pas des scripts npm.
- Base : Drizzle 1.0 RC (API Effect). Toute requête passe par le query builder, jamais par du SQL brut non typé. Schéma, migrations et `Store` vivent dans `packages/db` : après une modif de `src/schema.ts`, `pnpm exec drizzle-kit generate` dans `packages/db`. Le dépôt est testé contre PGlite (`packages/db/test/support/pglite.ts`).
- Un Layer par binding dans `packages/platform` ; fakes et recorders de test partagés dans `packages/testing`.
