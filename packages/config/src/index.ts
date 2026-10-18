import { fileURLToPath } from "node:url";

// Réglages communs aux trois Workers (web, api, jobs), lus par leurs
// `cloudflare.config.ts` et par le `vite.config.ts` de web (dev local multi-Workers).
// Un seul endroit pour les noms, les ressources partagées et les modes.

// Variables Neon (`neon deploy` / `neon env pull`) : lues ici, car cf ne lit pas les .env.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env.local", import.meta.url).href));
} catch {
  // pas de .env.local : stockage en mémoire par défaut
}

export const ACCOUNT_ID = "cf7f360cd85645322d03de3ffb22249e";
/** Secrets Store du compte : prod, previews et environnements de PR s'y branchent. */
export const SECRETS_STORE_ID = "1ef90d01875a4f5baaea375be4e6b0ad";
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
  /** La règle de réception exige Email Routing actif sur le domaine. */
  readonly emailRouting: boolean;
  /** Webhook Stream « vidéo prête » (unique par compte → production seulement). */
  readonly webhook: boolean;
  readonly databaseUrl: string | undefined;
  /** `postgres` dès qu'une URL est disponible ; CLIP_STORE=memory force la mémoire. */
  readonly store: "postgres" | "memory";
  readonly hyperdriveId: string;
  readonly chaos: string;
}

export const settings = (mode: string | undefined): Settings => {
  // `cf dev` ne passe pas de mode et Vite passe « development » : tous deux valent « dev ».
  const m = !mode || mode === "development" ? "dev" : mode;
  const production = m === "production";
  const suffix = production ? "" : `-${m}`;
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  return {
    mode: m,
    production,
    names: { web: `clip-web${suffix}`, api: `clip-api${suffix}`, jobs: `clip-jobs${suffix}` },
    resources: {
      notifications: `clip-notifications${suffix}`,
      pipeline: `clip-pipeline${suffix}`,
      // Nom historique : le bucket contient déjà les miniatures personnalisées.
      media: `clip-api${suffix}-media`,
    },
    remote: production || process.env.CLIP_REMOTE === "1",
    domain: process.env.CLIP_DOMAIN ?? "clipshare.dev",
    emailRouting: process.env.CLIP_EMAIL_ROUTING !== "0",
    webhook: production && process.env.CLIP_STREAM_WEBHOOK !== "0",
    databaseUrl,
    store: process.env.CLIP_STORE === "memory" || !databaseUrl ? "memory" : "postgres",
    hyperdriveId: process.env.CLIP_HYPERDRIVE_ID ?? HYPERDRIVE_ID,
    chaos: process.env.CLIP_CHAOS ?? "0",
  };
};

/** Chemin absolu d'un fichier, pour les `entrypoint` (vite.config ne peut pas importer les modules Worker). */
export const path = (relative: string, base: string) => fileURLToPath(new URL(relative, base).href);
