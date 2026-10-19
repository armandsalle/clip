# Clip : architecture

Clip est une démo « à la Grain » 100 % Cloudflare : on dépose une vidéo, sans compte, et elle devient un stream avec transcription, résumé, chapitres, miniatures, commentaires horodatés en direct et questions-réponses. Le produit (flows, UX, écrans) est décrit dans [PRODUCT.md](PRODUCT.md). Ce document décrit la tech.

État au 2026-10-19 : déployé sur https://clipshare.dev en trois Workers (`clip-web`, `clip-api`, `clip-jobs`), plus le routeur de webhooks `clip-hooks`. Parcours complet vérifié en ligne : upload Stream, transcription, titre/résumé/chapitres, Neon via Hyperdrive. Chaque PR a son environnement éphémère (`pr-<n>.clipshare.dev`) ; `main` se déploie par la CI. Prise en main et conventions : [CONTRIBUTING.md](../CONTRIBUTING.md).

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

## Trois Workers

```
                navigateur
                    │  https://clipshare.dev (seul Worker exposé)
                    ▼
 ┌─────────────────────────────┐
 │ clip-web                    │  SPA (static assets) ; /api, /dev, /media → API
 └──────────────┬──────────────┘
                │ service binding API (fetch)
                ▼
 ┌─────────────────────────────┐   PIPELINE (Workflow)    ┌─────────────────────────────┐
 │ clip-api                    │ ───────────────────────▶ │ clip-jobs                   │
 │ API HTTP (contrat HttpApi)  │   NOTIFICATIONS (Queue)  │ Workflow clip-pipeline      │
 │ DO VideoRoom (WebSockets)   │ ───────────────────────▶ │ consommateur de la Queue    │
 │ webhook Stream              │                          │ emails entrants (reply+…)   │
 │ seul écrivain : vidéos,     │ ◀─────────────────────── │ Cron d'expiration (15 min)  │
 │ commentaires                │   RPC interne (Internal) │ DO Storyboard (+ Container) │
 └──────────────┬──────────────┘                          └──────────────┬──────────────┘
                │ Hyperdrive (DB)                                         │ Hyperdrive (DB) : enrichissements
                ▼                                                         ▼
                              Neon Postgres (branche production)
```

| Worker      | Points d'entrée                                                                                                                                          | Écrit en base                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `clip-web`  | `fetch` : assets de la SPA, tout le reste relayé à clip-api (`env.API.fetch`). Aucune logique métier.                                                    | rien                                       |
| `clip-api`  | `fetch` (API publique, WebSocket `/api/videos/:id/live`, sous-titres, webhook Stream, faux Stream en dev) ; entrypoint `Internal` (RPC) ; DO `VideoRoom` | vidéos, commentaires (seul écrivain)       |
| `clip-jobs` | Workflow `VideoPipeline`, `queue` (notifications), `email` (réponses), `scheduled` (expiration), DO `Storyboard`                                         | enrichissements (`enrichments`) uniquement |

Ni clip-api ni clip-jobs n'ont de domaine ou d'URL `workers.dev` : on n'y entre que par service binding.

### Webhook Stream et environnements

Stream n'accepte qu'un webhook par compte, enregistré sur `https://clipshare.dev/api/stream/webhook`. Un quatrième Worker, `clip-hooks` (`apps/hooks`), est posé sur cette route : une route passe avant le domaine personnalisé de clip-web. Il vérifie la signature HMAC, lit le **créateur** de la vidéo et relaie la requête intacte (corps et signature) à son environnement, qui la vérifie à son tour :

| Créateur Stream              | Destination                                                   |
| ---------------------------- | ------------------------------------------------------------- |
| `clip-production` (ou aucun) | `clip-api`, par service binding                               |
| `clip-pr-<n>`                | `clip-web-pr-<n>.armand-salle.workers.dev/api/stream/webhook` |
| autre (`clip-dev`…)          | ignoré (Stream ne peut pas joindre localhost ; le dev sonde)  |

Le créateur est posé par clip-api à la création du dépôt tus (`Upload-Creator`), avec le nom `<créateur>/<id de la vidéo>` et, hors production, une suppression programmée à 30 jours (`scheduleddeletion`). `StreamVideos.remove` refuse de supprimer une vidéo d'un autre créateur, et `pr:down` supprime toutes les vidéos `clip-pr-<n>`.

### RPC interne

clip-jobs ne modifie jamais une vidéo ni un commentaire : il le demande à clip-api par la RPC `InternalRpcs` (`packages/contract/src/internal.ts`, `effect/rpc`, sérialisation JSON). Le transport est un service binding vers l'entrypoint `Internal` d'api (`/internal/rpc`) : la requête ne quitte pas Cloudflare et n'a aucune route publique. Les erreurs sont des Schemas : elles arrivent typées côté jobs.

| RPC               | Appelée par                                  | Effet côté api                                                          |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `ApplyVideoEvent` | pipeline (encodée, échouée), Cron (`Expire`) | `decide` du domaine, enregistrement, diffusion `VideoChanged`           |
| `SuggestTitle`    | étape `summary`                              | titre de l'IA, seulement si le propriétaire n'en a pas choisi           |
| `AddEmailReply`   | handler `email`                              | vérifie l'expéditeur et le jeton, publie la réponse sous le commentaire |
| `Publish`         | chaque étape du pipeline                     | diffusion dans la room de la vidéo (événements `Step`)                  |

À l'inverse, api atteint jobs par deux bindings déclarés dans `apps/api/worker.ts` : le Workflow `clip-pipeline` (démarrage du pipeline, réveil par le webhook) et la Queue `clip-notifications` (un message par commentaire).

## Structure

```
packages/domain/     cœur pur : Video (états, miniature, expiration), Comment, decide()
packages/contract/   contrat HttpApi public, événements temps réel, RPC interne (./internal)
packages/config/     réglages communs : noms par mode, ressources, remote, garde de la base de dev
packages/db/         schéma Drizzle, migrations, Store (Drizzle / mémoire / par appel), seed
packages/platform/   un service Effect par binding (Stream, Mailer, Live, Pipeline, InternalApi…)
packages/testing/    doubles de test partagés (Stream, Mailer, Queue, IA)
apps/web/            clip-web : worker/index.ts (relais) + src/ (SPA TanStack Router/Query/Form)
apps/api/            clip-api : worker.ts (bindings), src/index.ts (composition), http.ts,
                     internal.ts (RPC), Videos.ts (seul écrivain), room.ts (VideoRoom)
apps/jobs/           clip-jobs : worker.ts, src/index.ts (Workflow, queue, email, Cron),
                     pipeline.ts (étapes testables sans Workflow), containers/storyboard/
scripts/             pr-env.ts (environnements de PR), smoke.ts, neon.ts, migrate-production.ts
compose.yaml         Postgres 17 local (dev)
```

Chaque app a un `worker.ts` qui décrit le Worker (`defineWorker`) à partir de `settings(mode)` : il sert à son `cloudflare.config.ts` (déploiement) et au `vite.config.ts` de web, qui lance api et jobs en Workers auxiliaires d'un seul `cf dev`.

## Flux d'une vidéo

```
navigateur ── POST /api/videos ──▶ web ──▶ api : Stream.createUpload (tus) ; Video(Uploading) ;
                                               secret d'admin haché ; PIPELINE.create(videoId)
navigateur ── upload tus ──▶ Stream (direct, sans passer par les Workers)

jobs : Workflow clip-pipeline
  ▼  attente de l'encodage : webhook Stream (clip-hooks → api → instance.sendEvent) ou sondage de secours
  ▼  RPC ApplyVideoEvent(Encoded) ─▶ api : Ready, diffusé dans la VideoRoom
  ▼  en parallèle : thumbnail · suggestions · storyboard · shareCard · hd
  │                audio ─▶ transcript ─▶ captions · summary (RPC SuggestTitle) · index
  ▼  notify : email « vidéo prête » (Email Service)

jobs.scheduled (toutes les 15 min) : vidéos dont la date est passée ─▶ RPC ApplyVideoEvent(Expire)
                                     ─▶ api : Expired, fichier supprimé de Stream
```

Chaque étape écrit son état (Running avec le numéro de tentative, Done avec la durée, Failed, Disabled) dans `enrichments` et le publie par la RPC `Publish` ; la page vidéo et l'écran Coulisses le reçoivent en WebSocket.

## Flux d'un commentaire

```
navigateur ── POST /api/videos/:id/comments ──▶ web ──▶ api : Store.addComment (jeton reply+…)
                                                         ├─▶ VideoRoom : CommentAdded (direct)
                                                         └─▶ Queue clip-notifications
jobs.queue : lot regroupé (5 s, 50 messages) ─▶ un email par vidéo au propriétaire,
             Reply-To reply+<jeton>@clipshare.dev
propriétaire répond ─▶ Email Routing ─▶ jobs.email ─▶ RPC AddEmailReply ─▶ api : réponse publiée en direct
```

## Primitives Cloudflare

| Besoin                                     | Primitive                                                                                                                            | État                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| API                                        | Worker + Effect `HttpApi` (`HttpRouter.toWebHandler`)                                                                                | fait, testé                                                               |
| Front                                      | Static assets du même Worker (SPA, `runWorkerFirst` pour `/api`, `/dev`, `/media`), React + client dérivé du contrat                 | fait, vérifié dans le navigateur                                          |
| Upload, encodage, lecture HLS, miniatures  | Stream : upload tus direct (API REST, token dans Secrets Store) ; binding pour le reste                                              | fait, vérifié en ligne jusqu'à 225 Mo ; faux Stream (tus sur R2) en local |
| Pipeline durable                           | Workflows (`step.do`, `step.sleep`, `sleepUntil`)                                                                                    | fait, vérifié en local                                                    |
| Temps réel, présence                       | Durable Object `VideoRoom` (WebSockets hibernables)                                                                                  | fait, vérifié en local                                                    |
| Transcription                              | Workers AI Deepgram Nova-3 (intervenants, langue), audio Stream transmis en flux                                                     | fait, vérifié en ligne (~2 s pour 27 s de dialogue)                       |
| Sous-titres                                | VTT avec intervenants : servi par le Worker (`/api/videos/:id/captions.vtt`, piste `<track>`) et envoyé à Stream (`captions.upload`) | fait                                                                      |
| Qualité HD                                 | étape `hd` : avancement de l'encodage Stream après Ready (badge et tuile)                                                            | fait                                                                      |
| Détection « vidéo prête »                  | webhook Stream signé (HMAC, secret dans Secrets Store) + sondage de secours 5 s                                                      | fait, vérifié en ligne                                                    |
| Titre, résumé, chapitres                   | Workers AI (Llama 3.3 70B, sortie JSON)                                                                                              | code écrit ; factice en local                                             |
| Stockage                                   | Neon (eu-central-1) via Hyperdrive `clip-neon` + Drizzle, une connexion par appel                                                    | testé contre PGlite et contre Neon en local                               |
| Secrets d'admin                            | SHA-256 (WebCrypto), seul le hash est stocké                                                                                         | fait                                                                      |
| Médias (miniatures importées, faux Stream) | R2                                                                                                                                   | fait                                                                      |
| Planche de vignettes                       | Container (ffmpeg) piloté par le DO `Storyboard`                                                                                     | placeholder, désactivé                                                    |
| Notifications de commentaires              | Queues → Email Service, depuis `notifications@clipshare.dev`                                                                         | bindings déclarés, handler vide                                           |
| Réponse aux commentaires par email         | Email Routing sur `reply+<jeton>@clipshare.dev` (sous-adressage)                                                                     | handler vide                                                              |
| Questions sur la vidéo                     | AI Search sur la transcription                                                                                                       | binding déclaré                                                           |
| Carte de partage, formats                  | Images                                                                                                                               | binding déclaré                                                           |
| Cache des vues publiques                   | KV                                                                                                                                   | binding déclaré                                                           |
| Interrupteurs IA, chaos                    | Flagship                                                                                                                             | binding déclaré ; variables `CLIP_CHAOS` en attendant                     |
| Traces                                     | Workers Observability                                                                                                                | activée ; spans Effect pas encore exportés                                |

## Domaine et mise en place Cloudflare

Tout vit sur le domaine dédié `clipshare.dev` (acheté chez Cloudflare Registrar). Un sous-domaine de `bonjour.pizza` a été écarté : sa racine reçoit déjà des emails via AWS SES, et Email Routing ne s'active sur un sous-domaine qu'après la racine, ce qui aurait remplacé ce MX.

| Usage                                                  | Adresse                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- |
| App (Worker, domaine personnalisé créé au déploiement) | `https://clipshare.dev`, previews sur `*.clipshare.dev` |
| Envoi d'emails                                         | `notifications@clipshare.dev`                           |
| Réponses aux commentaires                              | `reply+<jeton>@clipshare.dev`                           |

Étapes manuelles (une fois) :

1. Compte Cloudflare avec l'offre Workers payante ; zone `clipshare.dev` sur ce compte.
2. Activer Stream (achat de stockage).
3. Compute → Email Service → Email Sending → Onboard Domain → `clipshare.dev`.
4. Email Routing sur `clipshare.dev`, avec le sous-adressage activé. La règle `reply@clipshare.dev` est créée par `cf deploy` (`CLIP_EMAIL_ROUTING=0` la désactive).
5. `pnpm exec cf auth login` dans `apps/api` (en CI : `CLOUDFLARE_API_TOKEN`).
6. Neon : projet, puis URL de connexion pour la config Hyperdrive.

## Principes

1. **Le cœur est pur.** `packages/domain` n'importe qu'`effect`. L'heure est passée en argument.
2. **Les handlers ne voient jamais `env`.** Chaque binding est un service Effect avec une Layer réelle et une Layer de test (ou factice pour `cf dev`).
3. **L'IA est une couche.** Une étape IA en échec ou désactivée laisse la vidéo lisible ; `Features` la coupe d'un interrupteur.
4. **Le pipeline est testable sans Workflow.** Chaque étape est une fonction Effect ; le Workflow ne fait que les enchaîner dans des `step.do` durables.
5. **Une seule `MemoMap`** pour le handler HTTP et le Workflow, pour partager les mêmes instances de services.
6. **Pas de compte** : le droit d'admin est un secret de 24 octets aléatoires, montré une fois, stocké haché.

## Modes et environnements

`settings(mode)` (`packages/config`) dérive tout du mode passé à `cf` :

| Mode         | Workers                             | Base                                                                  | Stream, IA                                      | Emails  | Domaine                |
| ------------ | ----------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- | ------- | ---------------------- |
| `dev`        | `clip-*-dev` (local, `cf dev`)      | `.env.local` : Postgres Docker ou branche Neon `dev-*`, sinon mémoire | faux (R2), factice ; vrais avec `CLIP_REMOTE=1` | simulés | localhost:5173         |
| `pr-<n>`     | `clip-*-pr-<n>`                     | branche Neon `pr-<n>` via Hyperdrive `clip-neon-pr-<n>`               | vrais (vidéos `clip-pr-<n>`)                    | coupés  | `pr-<n>.clipshare.dev` |
| `production` | `clip-web`, `clip-api`, `clip-jobs` | branche Neon `production` via Hyperdrive `clip-neon`                  | vrais                                           | actifs  | `clipshare.dev`        |

Ressources nommées par mode : Queue `clip-notifications[-<mode>]`, Workflow `clip-pipeline[-<mode>]`, bucket `clip-api[-<mode>]-media`. La Queue doit exister avant le déploiement (`cf queues create`) ; le Workflow, le bucket et les Durable Objects sont créés par `cf deploy`. En mode `pr-<n>`, `CLIP_HYPERDRIVE_ID` est obligatoire : sans lui, la config refuse de construire (une PR ne doit jamais se brancher sur la base de production).

| Variable                   | Défaut                                | Effet                                                                      |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `DATABASE_URL(_UNPOOLED)`  | lu dans `.env.local`                  | base de dev et des migrations ; la branche Neon `production` y est ignorée |
| `CLIP_ALLOW_PRODUCTION_DB` | non défini                            | `1` : accepte la branche `production` hors prod (migrations de la CI)      |
| `CLIP_STORE`               | `postgres` si une URL est disponible  | `memory` force le stockage en mémoire (dev)                                |
| `CLIP_REMOTE`              | non défini                            | `1` : vrai Stream, Workers AI, AI Search, Flagship en dev                  |
| `CLIP_HYPERDRIVE_ID`       | `clip-neon` (prod et dev)             | Hyperdrive à utiliser ; obligatoire en `pr-<n>`                            |
| `CLIP_EMAIL`               | actif, sauf en `pr-<n>`               | `0` coupe l'envoi d'emails (journalisés seulement)                         |
| `CLIP_EMAIL_ROUTING`       | actif, sauf en `pr-<n>`               | `0` retire la règle de réception `reply@`                                  |
| `CLIP_STREAM_WEBHOOK`      | actif en production et en PR          | `0` : sondage de l'encodage seulement                                      |
| `CLIP_CHAOS`               | `0`                                   | probabilité d'échec injectée dans chaque tentative d'étape                 |
| `CLIP_CONTAINERS`          | activé (jamais en dev local ni en PR) | `0` retire le Container de la planche de vignettes                         |
| `CLIP_DOMAIN`              | `clipshare.dev`                       | domaine de l'app et des emails                                             |

## CI et déploiement

`.github/workflows/ci.yml` :

- **chaque PR et `main`** : `vp run -r types` (types `Env` générés), `vp check`, `vp run -r test` ;
- **PR (branches du dépôt)** : `vp run pr:up <n>` (branche Neon vidée à sa création, migrations, Hyperdrive, Queue, déploiement jobs → api → web ; vrai Stream et vraie IA), `vp run smoke <url>`, commentaire avec l'URL ;
- **`main`** : `vp run db:migrate:production` puis `vp run @clip/{jobs,api,web,hooks}#deploy` et contrôle de `/api/health`.

`.github/workflows/pr-cleanup.yml` lance `vp run pr:down <n>` à la fermeture de la PR. Secrets : `CLOUDFLARE_API_TOKEN` (permissions limitées, voir CONTRIBUTING.md) et `NEON_API_KEY`.

## Compatibilité vérifiée

| #   | Point                                                    | Résultat                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `cf build` / `cf deploy` dans un projet Vite+            | **OK avec contournement.** Si `vite` est une dépendance directe, `cf` détecte « Vite » et lance `npx vite build`. Or le Vite de Vite+ (`@voidzero-dev/vite-plus-core`) n'expose pas de binaire `vite` : npm télécharge alors le vrai `vite@8.3.4` et contourne Vite+. Sans dépendance directe sur `vite`, `cf` utilise son outil de repli (`cf-vite`, fourni par le plugin), qui charge le Vite de Vite+. Build vérifié. `cf deploy` non testé (pas de compte connecté). |
| 2   | `@cloudflare/vite-plugin` 2.0 beta avec le Vite de Vite+ | **OK.** Peer `vite ^7 \|\| ^8`, résolu vers `vite-plus-core@1.3.0` par l'override pnpm. `cf dev` et `cf build` fonctionnent : DO, Workflow, KV, R2, Queue en local.                                                                                                                                                                                                                                                                                                      |
| 3   | `@effect/vitest` 4.0 avec Vitest 5                       | **OK.** Peer `vitest >=5 <6`, Vite+ embarque Vitest 5.0.5. Le plugin Cloudflare est retiré pendant les tests (`process.env.VITEST`), sinon il tente d'ouvrir une session distante.                                                                                                                                                                                                                                                                                       |
| 4   | Language service Effect dans `vp check`                  | **OK.** `@effect/tsgo` 0.53.3 supporte exactement TS 7.0.2, Oxlint 1.88.0 et tsgolint 7.0.2004 (ceux de Vite+ 1.3.0). `effect-tsgo patch` (script `prepare`) ajoute les diagnostics Effect à `tsc` ; le preset `recommended` d'Effect, ajouté à la config `lint`, les fait remonter dans `vp check` (un Effect « flottant » est bien bloqué).                                                                                                                            |
| 5   | Versions figées                                          | **OK.** Tout passe par le `catalog`. pnpm 12 a ajouté `@effect/tsgo` à `minimumReleaseAgeExclude` (publié la veille).                                                                                                                                                                                                                                                                                                                                                    |
| 6   | Drizzle 1.0 RC avec Effect 4.0.5                         | **OK avec le build `1.0.0-rc.5-5935859`.** Le build étiqueté `rc` (RC.4) plante au chargement : il appelle `Schema.TaggedErrorClass`, renommé `Schema.TaggedError` dans Effect 4.0 stable. Le dernier build de la ligne RC.5 (9 septembre) corrige le runtime, mais ses `.d.ts` importent encore `effect/unstable/sql/SqlError` (chemin des bêtas) : `SqlError` devenait `any`. Pont de types dans `packages/db/src/types/drizzle-effect-compat.d.ts`.                   |
| 7   | Typage SQL à la compilation                              | **OK.** Vérifié : colonne inexistante, valeur d'enum invalide et mauvais type de retour sont refusés par `tsc`. Le JSONB `status_details` est typé avec l'encodage du Schema du domaine, et l'agrégat relu est revalidé par ce Schema.                                                                                                                                                                                                                                   |

## Pièges relevés

- Stream : une vidéo `ready` est lisible mais continue d'encoder les qualités hautes (`status.step = encoding`, `pctComplete`) ; d'où l'étape `hd` et un lecteur qui démarre en haute qualité (`capLevelToPlayerSize` + `startLevel`).
- Stream : le statut prêt (API et webhook) n'apparaît qu'environ 11 s après l'horodatage `readyToStreamAt` ; le pipeline réagit en moins d'une seconde au webhook.
- Nova-3 sur Workers AI : la langue détectée est dans `alternatives[].languages` (et par utterance), pas dans `detected_language` ; le type Workers AI ne décrit ni `utterances` ni `speaker`. La diarisation ne sépare pas deux voix de synthèse macOS (tout en intervenant 0) : à vérifier avec un vrai enregistrement.
- Les sous-titres envoyés à Stream n'apparaissent pas tout de suite dans le manifeste HLS : le lecteur charge donc le VTT servi par le Worker.
- Webhook Stream : un seul par compte. Enregistrement (le secret va directement dans le coffre, sans être affiché) :
  `cf stream webhooks update --notification-url https://clipshare.dev/api/stream/webhook`, puis `cf secrets-store secrets create … STREAM_WEBHOOK_SECRET`.

- Le binding Stream ne crée que des uploads POST limités à 200 Mo (erreur 413 au-delà). L'upload tus (morceaux de 50 Mo, reprenable, jusqu'à 2 Go) passe par l'API REST de Stream, avec un token Stream:Edit rangé dans Secrets Store (`default_secrets_store`, binding `STREAM_API_TOKEN`) : prod, previews et Workers de PR le partagent sans secret à renvoyer.
- Secrets Store en local : `cf dev` lit `apps/api/.cloudflare/state`, alors que `cf secrets-store secrets create --local` écrit par défaut dans l'état global de la CLI. Ajouter `--persist-to apps/api/.cloudflare/state`.

- Hyperdrive met en cache les `SELECT` par défaut (60 s) en production, pas en local : le pipeline relisait une vidéo périmée (`Uploading` juste après `Ready`). Cache désactivé sur `clip-neon` (`cf hyperdrive update … --caching-disabled`).
- `env.DB.connectionString` (Hyperdrive) ne se lit pas au chargement du module (erreur 10021 au déploiement, invisible en `cf dev`) : la Layer Postgres est construite à chaque appel.
- Un déploiement qui échoue après le provisionnement laisse les ressources créées mais inconnues de `cf` : le KV est épinglé par id en production.
- La tâche `deploy` lance `cf deploy --mode production` (domaine personnalisé et bindings distants ne sont actifs qu'en production) ; `CLIP_CONTAINERS=0` tant que Docker n'est pas lancé.

- Workers + Postgres : une connexion TCP ouverte pendant une requête ne peut pas servir à une autre ; un pool construit au niveau du module fait bloquer la requête suivante (« Worker's code had hung »). `Store.layerPerCall` construit une base Drizzle par appel ; Hyperdrive fait le pooling côté Cloudflare.
- `neon init` installe ses plugins d'agents avec `npm` dans le projet, ce qui échoue (`devEngines` exige pnpm) et interrompt tout : relancer avec `--no-agent-setup --package-manager pnpm`, puis ajouter `@neon/config` et `@neon/env` à la racine avec `-w`.
- `drizzle-kit migrate` a besoin d'un driver Node classique : `pg` en dépendance de dev de `packages/db`.

- Effect v4 : `Schema.DateTimeUtc` n'a pas d'encodage texte hors codec JSON. Le domaine utilise `Schema.DateTimeUtcFromString`, pour que les types encodés soient du JSON typé (stockable tel quel en JSONB).
- Drizzle v1 : la casse se règle par table (`snakeCase.table`) ; l'option `casing` de `drizzle-kit` est ignorée.
- `vp run` filtre les variables d'environnement des tâches en cache, scripts `package.json` compris (`run.cache: true`). Les commandes `cf` des Workers et les commandes à effets de bord (`db:*`, `pr:*`, `smoke`) sont des tâches Vite+ sans cache ; `build` est en cache avec `CLIP_*` et `DATABASE_URL` dans l'empreinte.
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
