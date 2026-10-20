import { fileURLToPath } from "node:url";

// Réglages communs aux trois Workers (web, api, jobs), lus par leurs
// `cloudflare.config.ts` et par le `vite.config.ts` de web (dev local multi-Workers).
// Un seul endroit pour les noms, les ressources partagées et les modes.

// Base de dev (`.env.local`, cf. CONTRIBUTING.md) : lue ici, car cf ne lit pas les .env.
// Les variables déjà définies (CI, ligne de commande) l'emportent.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env.local", import.meta.url).href));
} catch {
  // pas de .env.local : stockage en mémoire par défaut
}

/** Base locale Docker (`docker compose up -d`, voir compose.yaml). */
export const LOCAL_DATABASE_URL = "postgres://clip:clip@localhost:5433/clip";

/** Environnement éphémère d'une PR : `pr-<numéro>`. */
export const isPreviewMode = (mode: string) => /^pr-\d+$/.test(mode);

/**
 * Staging permanent : clip-api-staging et clip-jobs-staging sur la branche Neon
 * `staging`, redéployés depuis main avant la production. Le site du staging et des PR
 * d'interface est une Preview Cloudflare de clip-web branchée sur clip-api-staging.
 */
export const STAGING = "staging";

let warnedProductionDb = false;

/**
 * URL de base pour le dev et les scripts (seed, migrations). Une URL de la branche
 * Neon `production` (ancien `.env.local` tiré par `neon env pull`) est ignorée hors
 * production, sauf CLIP_ALLOW_PRODUCTION_DB=1 : le dev local ne touche jamais la prod
 * par mégarde.
 */
export const databaseUrl = (production: boolean): string | undefined => {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  const isProductionBranch =
    process.env.NEON_BRANCH === "production" && url !== undefined && url.includes(".neon.tech");
  if (url && isProductionBranch && !production && process.env.CLIP_ALLOW_PRODUCTION_DB !== "1") {
    if (!warnedProductionDb) {
      warnedProductionDb = true;
      console.warn(
        "[clip] .env.local pointe sur la branche Neon « production » : ignorée en dev " +
          "(stockage en mémoire). Voir CONTRIBUTING.md pour une base locale.",
      );
    }
    return undefined;
  }
  return url;
};

export const ACCOUNT_ID = "cf7f360cd85645322d03de3ffb22249e";
/** Secrets Store du compte : prod, previews et environnements de PR s'y branchent. */
export const SECRETS_STORE_ID = "1ef90d01875a4f5baaea375be4e6b0ad";
/** Projet Neon (eu-central-1) : branche `production`, `pr-<n>` par PR, `dev-<prénom>` par développeur. */
export const NEON_PROJECT_ID = "curly-brook-93036842";
/** Sous-domaine workers.dev du compte : `<worker>.armand-salle.workers.dev`. */
export const WORKERS_SUBDOMAIN = "armand-salle";
/** URL workers.dev d'un Worker (clip-web d'une PR : hors du Bot Fight Mode de la zone). */
export const workersDevUrl = (worker: string) =>
  `https://${worker}.${WORKERS_SUBDOMAIN}.workers.dev`;

/** Créateur Stream d'un mode (`clip-production`, `clip-pr-12`, `clip-dev`). */
export const streamCreator = (mode: string) => `clip-${mode}`;
/** Mode d'un créateur Stream, s'il désigne un environnement déployé (production, staging, PR). */
export const modeOfStreamCreator = (creator: string | null | undefined): string | null =>
  /^clip-(production|staging|pr-\d+)$/.exec(creator ?? "")?.[1] ?? null;

/** Config Hyperdrive « clip-neon » (connexion directe vers Neon, eu-central-1, sans cache). */
export const HYPERDRIVE_ID = "db72ca80c92e4ba5978e21c0e2121ae8";

/**
 * Placement des Workers qui parlent à la base (api, jobs) : à côté de Neon, sinon
 * chaque requête Hyperdrive paie l'aller-retour depuis le point de présence du visiteur.
 * clip-web reste à la périphérie (fichiers statiques, proxy vers api).
 */
export const NEAR_DATABASE: { region: string } = { region: "aws:eu-central-1" };

export const runtime: {
  compatibilityDate: string;
  compatibilityFlags: Array<string>;
  observability: {
    enabled: boolean;
    issues: { enabled: boolean };
    traces: { enabled: boolean };
  };
} = {
  compatibilityDate: "2026-10-15",
  // @effect/sql-pg ouvre ses connexions via node:net.
  compatibilityFlags: ["nodejs_compat"],
  // Logs, traces et « issues » (erreurs regroupées) : activés dans le tableau de bord,
  // déclarés ici pour que `cf deploy --strict` (CI) ne voie pas de conflit.
  observability: { enabled: true, issues: { enabled: true }, traces: { enabled: true } },
};

export interface Settings {
  readonly mode: string;
  readonly production: boolean;
  /** Noms des Workers : `clip-api` en production, `clip-api-<mode>` sinon. */
  readonly names: { readonly web: string; readonly api: string; readonly jobs: string };
  /** Ressources partagées (nommées par mode, créées au déploiement). */
  readonly resources: {
    readonly notifications: string;
    readonly pipeline: string;
    readonly media: string;
  };
  /**
   * Ressources sans simulation locale (Stream, IA) : activées en production, ou en
   * dev avec CLIP_REMOTE=1 après `cf auth login`. Sinon : faux Stream sur R2, IA factice.
   */
  readonly remote: boolean;
  /**
   * Étiquette des vidéos Stream (`Upload-Creator`) : chaque vidéo est rattachée à son
   * environnement. Le routeur de webhooks (clip-hooks) s'en sert pour livrer « vidéo
   * prête » au bon environnement, et `pr:down` pour supprimer les vidéos d'une PR.
   */
  readonly streamCreator: string;
  /** Suppression programmée des vidéos Stream hors production (filet de sécurité), en jours. */
  readonly streamDeleteAfterDays: number | null;
  /** Domaine de l'app, de l'envoi d'emails et des réponses par email. */
  readonly domain: string;
  /** `pr-<n>` : environnement éphémère d'une PR (domaine `pr-<n>.<domaine>`). */
  readonly preview: boolean;
  /** Staging ou PR : déployé, vrai Stream, sa propre base, emails coupés. */
  readonly deployed: boolean;
  /** Nom d'hôte public de clip-web (production et PR), `null` en dev et en staging. */
  readonly hostname: string | null;
  /** Envoi d'emails (Email Service) : coupé en staging et en PR, où les notifications sont seulement journalisées. */
  readonly email: boolean;
  /** La règle de réception exige Email Routing actif sur le domaine (jamais hors prod : elle volerait celle de la prod). */
  readonly emailRouting: boolean;
  /** Webhook Stream « vidéo prête », reçu par clip-hooks puis relayé (production, staging, PR). */
  readonly webhook: boolean;
  readonly databaseUrl: string | undefined;
  /** `postgres` dès qu'une URL est disponible ; CLIP_STORE=memory force la mémoire. */
  readonly store: "postgres" | "memory";
  readonly hyperdriveId: string;
  /**
   * Premier déploiement du staging ou d'une PR (CLIP_BOOTSTRAP=1) : clip-jobs part
   * sans binding vers clip-api, qui n'existe pas encore (et qui référence le Workflow
   * de jobs). `scripts/env.ts` redéploie jobs complet juste après api.
   */
  readonly bootstrap: boolean;
  readonly chaos: string;
}

/** Noms des Workers et des ressources d'un mode (sans lire l'environnement). */
export const resourceNames = (mode: string) => {
  const suffix = mode === "production" ? "" : `-${mode}`;
  return {
    /** Workers : `clip-api` en production, `clip-api-<mode>` sinon. */
    workers: { web: `clip-web${suffix}`, api: `clip-api${suffix}`, jobs: `clip-jobs${suffix}` },
    notifications: `clip-notifications${suffix}`,
    pipeline: `clip-pipeline${suffix}`,
    // Nom historique : le bucket contient déjà les miniatures personnalisées.
    media: `clip-api${suffix}-media`,
    /** Config Hyperdrive d'un environnement de PR (la production a `clip-neon`). */
    hyperdrive: `clip-neon${suffix}`,
  };
};

export const settings = (mode: string | undefined): Settings => {
  // `cf dev` ne passe pas de mode et Vite passe « development » : tous deux valent « dev ».
  const m = !mode || mode === "development" ? "dev" : mode;
  const production = m === "production";
  const preview = isPreviewMode(m);
  const deployed = preview || m === STAGING;
  const n = resourceNames(m);
  const url = databaseUrl(production);
  const domain = process.env.CLIP_DOMAIN ?? "clipshare.dev";
  const hyperdriveId = process.env.CLIP_HYPERDRIVE_ID ?? (deployed ? undefined : HYPERDRIVE_ID);
  if (hyperdriveId === undefined) {
    // Sans Hyperdrive propre, le staging ou une PR se brancherait sur la base de production.
    throw new Error(
      `[clip] mode ${m} : CLIP_HYPERDRIVE_ID (Hyperdrive de la branche Neon ${m}) manquant`,
    );
  }
  return {
    mode: m,
    production,
    names: n.workers,
    resources: { notifications: n.notifications, pipeline: n.pipeline, media: n.media },
    // Staging et PR valident le vrai produit : vrai Stream, vraie IA (comme en production).
    remote: production || deployed || process.env.CLIP_REMOTE === "1",
    streamCreator: streamCreator(m),
    // 30 jours : le minimum accepté par Stream pour `scheduleddeletion`.
    streamDeleteAfterDays: production ? null : 30,
    domain,
    preview,
    deployed,
    hostname: production ? domain : preview ? `${m}.${domain}` : null,
    email: !deployed && process.env.CLIP_EMAIL !== "0",
    emailRouting: !deployed && process.env.CLIP_EMAIL_ROUTING !== "0",
    webhook: (production || deployed) && process.env.CLIP_STREAM_WEBHOOK !== "0",
    databaseUrl: url,
    // Staging et PR ont toujours leur base (branche Neon) : jamais de stockage en mémoire.
    store: !deployed && (process.env.CLIP_STORE === "memory" || !url) ? "memory" : "postgres",
    hyperdriveId,
    bootstrap: deployed && process.env.CLIP_BOOTSTRAP === "1",
    chaos: process.env.CLIP_CHAOS ?? "0",
  };
};

/** Chemin absolu d'un fichier, pour les `entrypoint` (vite.config ne peut pas importer les modules Worker). */
export const path = (relative: string, base: string) => fileURLToPath(new URL(relative, base).href);
