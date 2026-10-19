# Contribuer à Clip

Avant toute modification, lisez [docs/PRODUCT.md](docs/PRODUCT.md) (produit) et [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (tech).

## Prise en main en 5 commandes

Prérequis : [Vite+](https://viteplus.dev) (`vp`, qui fournit Node et pnpm), Docker, et ffmpeg pour les vidéos de démo (`brew install ffmpeg`).

```bash
vp install                          # dépendances (et hooks git)
cp .env.example .env.local          # base de dev : le Postgres Docker ci-dessous
vp run db:up                        # Postgres 17 sur localhost:5433
vp run dev                          # les trois Workers sur http://localhost:5173
vp run db:seed                      # dans un autre terminal : migrations + 3 vidéos de démo
```

Le seed affiche les liens d'admin des vidéos de démo. Il est rejouable : il remplace les vidéos de démo (identifiants fixes) sans toucher aux autres. Il applique les migrations lui-même ; `vp run db:migrate` les applique seules.

En dev, Stream et l'IA sont simulés : l'upload va en tus dans un R2 local (« faux Stream »), la transcription et le résumé sont factices. `CLIP_REMOTE=1` branche le vrai Stream et Workers AI (après `cf auth login` dans `apps/api`).

### Quelle base en dev ?

| Base                         | Mise en place                                                                     | Quand                                      |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| Postgres Docker (par défaut) | `vp run db:up`, `DATABASE_URL=postgres://clip:clip@localhost:5433/clip`           | tous les jours                             |
| Votre branche Neon           | `neon checkout --create dev-<prénom>` (écrit `.env.local`), expire au bout de 7 j | tester contre Neon (latence, Hyperdrive)   |
| Mémoire                      | pas de `.env.local`, ou `CLIP_STORE=memory`                                       | front seul, données perdues au redémarrage |

**Jamais la production.** Un `.env.local` qui pointe sur la branche Neon `production` (ancien `neon env pull`) est ignoré hors production, avec un avertissement : le dev retombe en mémoire. Remplacez-le par le contenu de `.env.example`. `CLIP_ALLOW_PRODUCTION_DB=1` lève la garde, en connaissance de cause.

La TTL de 7 jours des branches `dev-*` vient de [neon.ts](neon.ts).

## Avant de pousser

```bash
vp check          # format (Oxfmt), lint (Oxlint + règles Effect), types (TypeScript 7)
vp run -r test    # tests de tous les paquets
```

Le hook `pre-commit` lance `vp check --fix` sur les fichiers indexés. Après une modification de `cloudflare.config.ts` ou d'un `worker.ts`, régénérez les types `Env` : `vp run -r types`.

Toutes les commandes du dépôt :

| Commande                           | Effet                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `vp run dev`                       | `cf dev` : web, api et jobs ensemble (api et jobs en Workers auxiliaires)          |
| `vp run db:up`                     | Postgres Docker (`compose.yaml`)                                                   |
| `vp run db:migrate`                | migrations Drizzle sur la base de dev                                              |
| `vp run db:seed`                   | migrations + vidéos de démo (+ envoi des MP4 au faux Stream si `dev` tourne)       |
| `vp run smoke <url>`               | test de fumée de bout en bout (faux Stream) : `vp run smoke http://localhost:5173` |
| `vp run pr:up <n>` / `pr:down <n>` | environnement de PR (normalement lancé par la CI)                                  |
| `vp run @clip/<app>#deploy`        | déploiement en production (normalement lancé par la CI)                            |

`cf` et les tâches ci-dessus sont des tâches Vite+ (`vite.config.ts`), pas des scripts npm : `vp run` les lance sans cache et avec tout l'environnement.

## Conventions

### Effect v4

- **Effect v4 uniquement** : `Context.Service`, `Result`, `effect/http-api`, `effect/rpc`, `effect/sql`. La plupart des exemples en ligne sont en v3 ; la doc fiable est locale : `node_modules/effect/AGENTS.md` et `node_modules/effect/ai-docs/`.
- **Le domaine est pur** (`packages/domain`) : aucune I/O, l'heure est passée en argument. Les transitions passent par `decide(video, event, now)`.
- **Un service par binding** (`packages/platform`), avec une Layer réelle et une Layer de test ou factice. Les handlers ne lisent jamais `env` : seul le point d'entrée d'un Worker (`src/index.ts`) compose les Layers.
- **Un seul écrivain** : clip-api écrit les vidéos et les commentaires. clip-jobs écrit les enrichissements et demande tout le reste à api par la RPC interne (`InternalRpcs` dans `packages/contract`).
- **L'IA est une couche** : une étape IA en échec ou coupée ne bloque jamais la lecture.
- **Base** : Drizzle 1.0 RC (API Effect), toujours via le query builder, jamais de SQL brut non typé. Après une modification de `packages/db/src/schema.ts` : `pnpm exec drizzle-kit generate` dans `packages/db`, et commitez la migration générée.
- **Versions** : uniquement via le `catalog` de `pnpm-workspace.yaml`, figées exactement. Pas de dépendance directe sur `vite` dans les apps (sinon `cf` lance `npx vite` et contourne Vite+).

### Erreurs

- Les erreurs métier sont des `Schema.TaggedError` (dans `packages/domain` ou `packages/contract`), avec leur statut HTTP (`httpApiStatus`). Elles traversent l'API et la RPC typées.
- Un défaut (bug, binding cassé) reste un défaut (`Effect.orDie`) : on ne le transforme pas en erreur métier.
- Côté front, les messages viennent **uniquement** de `apps/web/src/api/errors.ts` : le `Record` des messages est exhaustif, une erreur ajoutée au contrat sans message ne compile pas.
- Textes de l'interface dans `apps/web/src/copy.ts`, au vous.

### Tests

- `@effect/vitest` (`it.effect`, `layer(...)`) ; les doubles partagés (Stream, Mailer, Queue, IA) sont dans `packages/testing`.
- L'API HTTP est testée de bout en bout sans Worker (`apps/api/test`), le pipeline étape par étape sans Workflow (`apps/jobs/test`).
- Le stockage est testé contre un vrai Postgres en WASM (PGlite, `packages/db/test/support/pglite.ts`), migrations du dépôt appliquées.
- Le temps se contrôle avec `TestClock` ; jamais de `Date.now()` dans le domaine.

## Pull requests

Chaque PR ouverte depuis une branche du dépôt reçoit son environnement complet, mis à jour à chaque push. Il sert à valider le vrai produit : **vrai Stream et vraie IA**, comme en production.

1. `vp check` et `vp run -r test` ;
2. `vp run pr:up <n>` : branche Neon `pr-<n>` (copie de production, vidée à sa création, expire seule au bout de 7 jours), migrations, Hyperdrive `clip-neon-pr-<n>`, Queue `clip-notifications-pr-<n>`, puis `cf deploy --mode pr-<n>` de clip-jobs, clip-api et clip-web ;
3. `vp run smoke <url>` : dépôt d'un vrai MP4 en tus, encodage par Stream, pipeline jusqu'à la transcription, commentaire, suppression ;
4. un commentaire sur la PR donne l'URL, `https://pr-<n>.clipshare.dev`.

**Vidéos Stream étiquetées par environnement.** Chaque dépôt porte le créateur Stream de son environnement (`clip-production`, `clip-pr-12`, `clip-dev`) et le nom `<créateur>/<id de la vidéo>`, visible dans le tableau de bord. Hors production, Stream les supprime de lui-même au bout de 30 jours. Un environnement ne supprime jamais une vidéo Stream d'un autre créateur.

**Webhook « vidéo prête ».** Stream n'accepte qu'un webhook par compte : `https://clipshare.dev/api/stream/webhook`. Le Worker `clip-hooks` (`apps/hooks`), sur une route qui passe avant clip-web, vérifie la signature et relaie la requête à l'environnement de la vidéo, d'après son créateur : clip-api en production, clip-web de la PR par son URL `workers.dev` sinon.

Emails, Email Routing et Container restent coupés en PR. À la fermeture de la PR, `vp run pr:down <n>` supprime tout : vidéos Stream `clip-pr-<n>`, Workers (et leurs Durable Objects), Workflow, Queue, bucket R2, Hyperdrive, branche Neon. Les PR venues d'un fork n'ont ni secrets ni environnement.

La CI teste l'environnement par l'URL `workers.dev` de clip-web : le Bot Fight Mode de `clipshare.dev` répond 403 aux runners GitHub.

## Release

Un merge sur `main` déclenche, après les vérifications :

1. `vp run db:migrate:production` : migrations sur la branche Neon `production` (URL demandée à l'API Neon, jamais stockée) ;
2. le déploiement, dans l'ordre `clip-jobs` → `clip-api` → `clip-web` → `clip-hooks` (`cf deploy --mode production`) ;
3. un contrôle de `https://clipshare.dev/api/health`.

Les migrations doivent donc rester compatibles avec le code déjà en production pendant le déploiement : ajouter une colonne nullable avant de l'utiliser, supprimer une colonne une release après avoir cessé de la lire.

### Secrets GitHub (une fois, par le propriétaire du dépôt)

À créer dans **Settings → Secrets and variables → Actions**, sans jamais les coller ailleurs :

| Secret                 | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Token de compte (Manage Account → Account API Tokens), limité au compte Clip et à la zone `clipshare.dev`. Compte : Account Settings Read, Workers Admin (ex-« Workers Scripts Write »), R2 Storage Write, Queues Write, Hyperdrive Write, Workers Containers Write, Secrets Store Read, Email Sending Write, Stream Write (vidéos des PR supprimées à leur fermeture). Zone `clipshare.dev` : Workers Routes Write, DNS Write, Email Routing Rules Write. |
| `NEON_API_KEY`         | Clé d'API Neon limitée au projet Clip (Project-scoped API key).                                                                                                                                                                                                                                                                                                                                                                                            |

Un environnement GitHub `production` (Settings → Environments) peut ajouter une validation manuelle avant le déploiement.
