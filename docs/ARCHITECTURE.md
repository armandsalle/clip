# Clip : architecture

Clip est une démo « à la Grain » 100 % Cloudflare : on dépose une vidéo, sans compte, et elle devient un stream avec transcription, résumé, chapitres, miniatures, commentaires horodatés en direct et questions-réponses. Le produit (flows, UX, écrans) est décrit dans [PRODUCT.md](PRODUCT.md). Ce document décrit la tech.

État au 2026-10-18 : le parcours complet tourne en local (`cf dev`) contre la vraie base Neon (via l'émulation locale d'Hyperdrive), avec un faux Stream et une IA factice. Rien n'est déployé ; Stream et Workers AI n'ont pas encore été testés pour de vrai.

## Stack et versions

Toutes les versions sont figées dans le `catalog` de `pnpm-workspace.yaml`. Les modules « unstable » d'Effect, la CLI `cf`, le plugin Vite Cloudflare et Drizzle RC peuvent casser en version mineure : on les met à jour ensemble, volontairement.

| Brique                        | Version            | Rôle                                                                                                   |
| ----------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| Vite+ (`vp`)                  | 1.3.0              | Runtime Node, pnpm, monorepo, lint (Oxlint + règles Effect), format, tests (Vitest 5), cache de tâches |
| `cf`                          | 1.0.0-beta.18      | Config `cloudflare.config.ts`, dev, build, deploy                                                      |
| `@cloudflare/vite-plugin`     | 2.0.0-beta.v.1     | Runtime Workers dans Vite (`cf dev` / `cf build`)                                                      |
| `effect`                      | 4.0.5              | Cœur, Schema, `effect/http-api`, `effect/sql`                                                          |
| `drizzle-orm` / `drizzle-kit` | 1.0.0-rc.5-5935859 | ORM typé (API Effect), migrations générées                                                             |
| `@effect/sql-pg`              | 4.0.5              | Driver Postgres (via `node:net`) vers Neon via Hyperdrive                                              |
| `@effect/sql-pglite`          | 4.0.5              | Postgres en WASM pour les tests du stockage                                                            |
| `@effect/vitest`              | 4.0.5              | Tests Effect                                                                                           |
| `@effect/tsgo`                | 0.53.3             | Language service Effect pour TypeScript 7 + règles Oxlint                                              |
| TypeScript                    | 7.0.2              | Compilateur natif                                                                                      |

## Structure

```
packages/domain/     cœur pur : Video (états, miniature, expiration), Comment, decide()
packages/contract/   contrat HttpApi (VideoView, commandes) + événements temps réel (LiveEvent)
apps/web/            front React (accueil, page vidéo, Coulisses), servi par le Worker
  src/api.ts             client typé dérivé du contrat (HttpApiClient)
  src/live.ts            WebSocket vers le DO, événements décodés avec le Schema du contrat
apps/api/            Worker
  cloudflare.config.ts   bindings, exports (DO, Workflow), triggers, container
  index.html             point d'entrée du front (importe @clip/web)
  src/index.ts           composition des Layers, routes hors contrat, Workflow, Storyboard
  src/http.ts            implémentation du contrat
  src/pipeline.ts        étapes du pipeline en Effect (testables sans Workflow)
  src/room.ts            Durable Object VideoRoom (WebSockets, présence, diffusion)
  src/Store.ts           stockage : Layer Drizzle + Layer mémoire
  src/Platform.ts        services autour des bindings : Stream, Live, Pipeline, AdminKeys
  src/Ai.ts              Transcriber, Summarizer : Workers AI + versions factices
  src/db/                schéma Drizzle, service Db
  migrations/            générées par drizzle-kit
  containers/storyboard/ ffmpeg pour la planche de vignettes (placeholder)
```

## Flux d'une vidéo

```
POST /api/videos ──▶ Stream.createDirectUpload ──▶ Video(Uploading) + secret d'admin (haché)
        │                                                   │
        └── uploadUrl ◀─ le navigateur envoie la vidéo      └── Workflow VideoPipeline.create
                                                                    │
  ┌─────────────────────────────────────────────────────────────────┘
  ▼
  sondage durable de l'encodage (step.do + step.sleep 3 s) ──▶ Ready
  ▼
  en parallèle : thumbnail · suggestions · storyboard · shareCard · transcript
                                                                   └─▶ summary (titre, résumé, chapitres) · index
  ▼
  step.sleepUntil(expiration) ──▶ expire : Stream.delete + Expired
```

Chaque étape publie ses états (Running avec le numéro de tentative, Done avec la durée, Failed, Disabled) vers le Durable Object de la vidéo, qui les diffuse en WebSocket. La page vidéo et l'écran Coulisses s'en nourrissent.

## Primitives Cloudflare

| Besoin                                     | Primitive                                                                                                            | État                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| API                                        | Worker + Effect `HttpApi` (`HttpRouter.toWebHandler`)                                                                | fait, testé                                           |
| Front                                      | Static assets du même Worker (SPA, `runWorkerFirst` pour `/api`, `/dev`, `/media`), React + client dérivé du contrat | fait, vérifié dans le navigateur                      |
| Upload, encodage, lecture HLS, miniatures  | Stream (binding `stream`)                                                                                            | code écrit ; faux Stream sur R2 en local              |
| Pipeline durable                           | Workflows (`step.do`, `step.sleep`, `sleepUntil`)                                                                    | fait, vérifié en local                                |
| Temps réel, présence                       | Durable Object `VideoRoom` (WebSockets hibernables)                                                                  | fait, vérifié en local                                |
| Transcription                              | Workers AI (Whisper large v3 turbo) sur la piste audio Stream                                                        | code écrit ; factice en local                         |
| Titre, résumé, chapitres                   | Workers AI (Llama 3.3 70B, sortie JSON)                                                                              | code écrit ; factice en local                         |
| Stockage                                   | Neon (eu-central-1) via Hyperdrive `clip-neon` + Drizzle, une connexion par appel                                    | testé contre PGlite et contre Neon en local           |
| Secrets d'admin                            | SHA-256 (WebCrypto), seul le hash est stocké                                                                         | fait                                                  |
| Médias (miniatures importées, faux Stream) | R2                                                                                                                   | fait                                                  |
| Planche de vignettes                       | Container (ffmpeg) piloté par le DO `Storyboard`                                                                     | placeholder, désactivé                                |
| Notifications de commentaires              | Queues → Email Service, depuis `notifications@clip.bonjour.pizza`                                                    | bindings déclarés, handler vide                       |
| Réponse aux commentaires par email         | Email Routing sur `reply+<jeton>@clip.bonjour.pizza` (sous-adressage)                                                | handler vide                                          |
| Questions sur la vidéo                     | AI Search sur la transcription                                                                                       | binding déclaré                                       |
| Carte de partage, formats                  | Images                                                                                                               | binding déclaré                                       |
| Cache des vues publiques                   | KV                                                                                                                   | binding déclaré                                       |
| Interrupteurs IA, chaos                    | Flagship                                                                                                             | binding déclaré ; variables `CLIP_CHAOS` en attendant |
| Traces                                     | Workers Observability                                                                                                | activée ; spans Effect pas encore exportés            |

## Domaine et mise en place Cloudflare

Tout vit sur le sous-domaine `clip.bonjour.pizza` ; la racine `bonjour.pizza` (autre projet) n'est pas touchée.

| Usage                                                  | Adresse                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| App (Worker, domaine personnalisé créé au déploiement) | `https://clip.bonjour.pizza`, previews sur `*.clip.bonjour.pizza` |
| Envoi d'emails                                         | `notifications@clip.bonjour.pizza`                                |
| Réponses aux commentaires                              | `reply+<jeton>@clip.bonjour.pizza`                                |

Étapes manuelles (une fois) :

1. Compte Cloudflare avec l'offre Workers payante ; zone `bonjour.pizza` sur ce compte.
2. Activer Stream (achat de stockage).
3. Compute → Email Service → Email Sending → Onboard Domain → `clip.bonjour.pizza`.
4. Email Routing sur `clip.bonjour.pizza`, avec le sous-adressage activé. Ne pas l'activer sur la racine si l'autre projet y reçoit des emails.
5. `pnpm exec cf auth login` dans `apps/api`.
6. Neon : projet, puis URL de connexion pour la config Hyperdrive.

## Principes

1. **Le cœur est pur.** `packages/domain` n'importe qu'`effect`. L'heure est passée en argument.
2. **Les handlers ne voient jamais `env`.** Chaque binding est un service Effect avec une Layer réelle et une Layer de test (ou factice pour `cf dev`).
3. **L'IA est une couche.** Une étape IA en échec ou désactivée laisse la vidéo lisible ; `Features` la coupe d'un interrupteur.
4. **Le pipeline est testable sans Workflow.** Chaque étape est une fonction Effect ; le Workflow ne fait que les enchaîner dans des `step.do` durables.
5. **Une seule `MemoMap`** pour le handler HTTP et le Workflow, pour partager les mêmes instances de services.
6. **Pas de compte** : le droit d'admin est un secret de 24 octets aléatoires, montré une fois, stocké haché.

## Commandes

```bash
vp install
vp check
vp run -r test
CLIP_CONTAINERS=0 vp run dev           # cf dev : faux Stream, IA factice, stockage mémoire
CLIP_CONTAINERS=0 CLIP_CHAOS=0.5 vp run dev   # mode chaos : 50 % d'échecs, retries visibles
```

| Variable                | Défaut                                                  | Effet                                                                      |
| ----------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `CLIP_REMOTE`           | non défini                                              | `1` : vrai Stream, Workers AI, AI Search, Flagship (après `cf auth login`) |
| `CLIP_STORE`            | `postgres` si une URL Neon est présente, sinon `memory` | `memory` force le stockage en mémoire                                      |
| `DATABASE_URL_UNPOOLED` | lu dans `.env.local` (`neon env pull`)                  | connexion directe à Neon, utilisée en dev et pour les migrations           |
| `CLIP_HYPERDRIVE_ID`    | `db72ca80…` (`clip-neon`)                               | id de la config Hyperdrive                                                 |
| `CLIP_FLAGSHIP_APP_ID`  | vide                                                    | app Flagship                                                               |
| `CLIP_CHAOS`            | `0`                                                     | probabilité d'échec injectée dans chaque tentative d'étape                 |
| `CLIP_CONTAINERS`       | activé                                                  | `0` retire le container (pas de Docker)                                    |
| `CLIP_DOMAIN`           | `clip.bonjour.pizza`                                    | domaine de l'app et des emails                                             |

## Compatibilité vérifiée

| #   | Point                                                    | Résultat                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `cf build` / `cf deploy` dans un projet Vite+            | **OK avec contournement.** Si `vite` est une dépendance directe, `cf` détecte « Vite » et lance `npx vite build`. Or le Vite de Vite+ (`@voidzero-dev/vite-plus-core`) n'expose pas de binaire `vite` : npm télécharge alors le vrai `vite@8.3.4` et contourne Vite+. Sans dépendance directe sur `vite`, `cf` utilise son outil de repli (`cf-vite`, fourni par le plugin), qui charge le Vite de Vite+. Build vérifié. `cf deploy` non testé (pas de compte connecté). |
| 2   | `@cloudflare/vite-plugin` 2.0 beta avec le Vite de Vite+ | **OK.** Peer `vite ^7 \|\| ^8`, résolu vers `vite-plus-core@1.3.0` par l'override pnpm. `cf dev` et `cf build` fonctionnent : DO, Workflow, KV, R2, Queue en local.                                                                                                                                                                                                                                                                                                      |
| 3   | `@effect/vitest` 4.0 avec Vitest 5                       | **OK.** Peer `vitest >=5 <6`, Vite+ embarque Vitest 5.0.5. Le plugin Cloudflare est retiré pendant les tests (`process.env.VITEST`), sinon il tente d'ouvrir une session distante.                                                                                                                                                                                                                                                                                       |
| 4   | Language service Effect dans `vp check`                  | **OK.** `@effect/tsgo` 0.53.3 supporte exactement TS 7.0.2, Oxlint 1.88.0 et tsgolint 7.0.2004 (ceux de Vite+ 1.3.0). `effect-tsgo patch` (script `prepare`) ajoute les diagnostics Effect à `tsc` ; le preset `recommended` d'Effect, ajouté à la config `lint`, les fait remonter dans `vp check` (un Effect « flottant » est bien bloqué).                                                                                                                            |
| 5   | Versions figées                                          | **OK.** Tout passe par le `catalog`. pnpm 12 a ajouté `@effect/tsgo` à `minimumReleaseAgeExclude` (publié la veille).                                                                                                                                                                                                                                                                                                                                                    |
| 6   | Drizzle 1.0 RC avec Effect 4.0.5                         | **OK avec le build `1.0.0-rc.5-5935859`.** Le build étiqueté `rc` (RC.4) plante au chargement : il appelle `Schema.TaggedErrorClass`, renommé `Schema.TaggedError` dans Effect 4.0 stable. Le dernier build de la ligne RC.5 (9 septembre) corrige le runtime, mais ses `.d.ts` importent encore `effect/unstable/sql/SqlError` (chemin des bêtas) : `SqlError` devenait `any`. Pont de types dans `apps/api/src/types/drizzle-effect-compat.d.ts`.                      |
| 7   | Typage SQL à la compilation                              | **OK.** Vérifié : colonne inexistante, valeur d'enum invalide et mauvais type de retour sont refusés par `tsc`. Le JSONB `status_details` est typé avec l'encodage du Schema du domaine, et l'agrégat relu est revalidé par ce Schema.                                                                                                                                                                                                                                   |

## Pièges relevés

- Workers + Postgres : une connexion TCP ouverte pendant une requête ne peut pas servir à une autre ; un pool construit au niveau du module fait bloquer la requête suivante (« Worker's code had hung »). `Store.layerPerCall` construit une base Drizzle par appel ; Hyperdrive fait le pooling côté Cloudflare.
- `neon init` installe ses plugins d'agents avec `npm` dans le projet, ce qui échoue (`devEngines` exige pnpm) et interrompt tout : relancer avec `--no-agent-setup --package-manager pnpm`, puis ajouter `@neon/config` et `@neon/env` à la racine avec `-w`.
- `drizzle-kit migrate` a besoin d'un driver Node classique : `pg` en dépendance de dev de `apps/api`.

- Effect v4 : `Schema.DateTimeUtc` n'a pas d'encodage texte hors codec JSON. Le domaine utilise `Schema.DateTimeUtcFromString`, pour que les types encodés soient du JSON typé (stockable tel quel en JSONB).
- Drizzle v1 : la casse se règle par table (`snakeCase.table`) ; l'option `casing` de `drizzle-kit` est ignorée.
- `vp run` filtre les variables d'environnement des tâches en cache. Les commandes `cf` du Worker sont des tâches Vite+ (`apps/api/vite.config.ts`) : `dev` et `deploy` sans cache, `build` en cache avec `CLIP_*` et `DATABASE_URL` dans l'empreinte.
- Les bindings sans simulation locale (Stream, IA, Flagship) font échouer `cf dev` s'ils sont déclarés : ils sont conditionnés par `CLIP_REMOTE`.
- Hors workspace, `cf` ne trouve pas le lockfile et retombe sur npm. Sans conséquence avec `cf-vite`.
- Le bundle fait 1,7 Mo (384 ko gzip), principalement Effect et Drizzle.
- Les spans Effect n'apparaissent pas dans l'observability locale (seuls ceux du runtime). L'écran Coulisses s'appuie pour l'instant sur les événements `Step` publiés explicitement.

## Prochaines étapes

1. **Front, suite** : Q&R (attend l'API AI Search), extraits, réactions emoji, carte de partage.
2. **Vrai Stream et Workers AI** (`CLIP_REMOTE=1`) : upload direct, téléchargement audio, Whisper, résumé.
3. **Boucle email** : notification groupée par Queue, adresse de réponse par commentaire, réponse publiée en direct.
4. **Questions sur la vidéo** : indexation AI Search, réponse en streaming avec timecodes.
5. **Miniatures** : choix d'une image sur la timeline, image importée (R2 + Images), carte de partage, planche de vignettes (Container).
6. **Flagship** à la place de `CLIP_CHAOS` et de `Features`, traces Effect exportées.
7. **CI et déploiement** : `setup-vp`, `vp check`, `vp run -r test`, `cf deploy --mode pr-<n>`.
