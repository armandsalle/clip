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
/** Config Hyperdrive « clip-neon » (connexion directe vers Neon, eu-central-1, sans cache). */
export const HYPERDRIVE_ID = "db72ca80c92e4ba5978e21c0e2121ae8";

export const runtime: {
  compatibilityDate: string;
  compatibilityFlags: Array<string>;
  observability: { enabled: boolean };
} = {
  compatibilityDate: "2026-10-15",
  // @effect/sql-pg ouvre ses connexions via node:net.
  compatibilityFlags: ["nodejs_compat"],
  observability: { enabled: true },
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
  /** Domaine de l'app, de l'envoi d'emails et des réponses par email. */
  readonly domain: string;
  /** `pr-<n>` : environnement éphémère d'une PR (domaine `pr-<n>.<domaine>`). */
  readonly preview: boolean;
  /** Nom d'hôte public de clip-web (production et PR), `null` en dev. */
  readonly hostname: string | null;
  /** Envoi d'emails (Email Service) : coupé en PR, où les notifications sont seulement journalisées. */
  readonly email: boolean;
  /** La règle de réception exige Email Routing actif sur le domaine (jamais en PR : elle volerait celle de la prod). */
  readonly emailRouting: boolean;
  /** Webhook Stream « vidéo prête » (unique par compte → production seulement). */
  readonly webhook: boolean;
  readonly databaseUrl: string | undefined;
  /** `postgres` dès qu'une URL est disponible ; CLIP_STORE=memory force la mémoire. */
  readonly store: "postgres" | "memory";
  readonly hyperdriveId: string;
  readonly chaos: string;
  /**
   * Export OTLP des spans et logs Effect vers PostHog (`https://us.i.posthog.com` ou
   * `https://eu.i.posthog.com`) ; absent : pas d'export. Le token du projet est rangé
   * dans le Secrets Store sous POSTHOG_PROJECT_TOKEN.
   */
  readonly posthogHost: string | undefined;
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
  const n = resourceNames(m);
  const url = databaseUrl(production);
  const domain = process.env.CLIP_DOMAIN ?? "clipshare.dev";
  const hyperdriveId = process.env.CLIP_HYPERDRIVE_ID ?? (preview ? undefined : HYPERDRIVE_ID);
  if (hyperdriveId === undefined) {
    // Sans Hyperdrive propre, une PR se brancherait sur la base de production.
    throw new Error(
      `[clip] mode ${m} : CLIP_HYPERDRIVE_ID (Hyperdrive de la branche Neon ${m}) manquant`,
    );
  }
  return {
    mode: m,
    production,
    names: n.workers,
    resources: { notifications: n.notifications, pipeline: n.pipeline, media: n.media },
    remote: production || process.env.CLIP_REMOTE === "1",
    domain,
    preview,
    hostname: production ? domain : preview ? `${m}.${domain}` : null,
    email: !preview && process.env.CLIP_EMAIL !== "0",
    emailRouting: !preview && process.env.CLIP_EMAIL_ROUTING !== "0",
    webhook: production && process.env.CLIP_STREAM_WEBHOOK !== "0",
    databaseUrl: url,
    // Une PR a toujours sa base (branche Neon pr-<n>) : jamais de stockage en mémoire.
    store: !preview && (process.env.CLIP_STORE === "memory" || !url) ? "memory" : "postgres",
    hyperdriveId,
    chaos: process.env.CLIP_CHAOS ?? "0",
    posthogHost: process.env.CLIP_POSTHOG_HOST,
  };
};

/** Chemin absolu d'un fichier, pour les `entrypoint` (vite.config ne peut pas importer les modules Worker). */
export const path = (relative: string, base: string) => fileURLToPath(new URL(relative, base).href);
