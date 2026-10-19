// Environnement éphémère d'une pull request : `vp run pr:up <n>` / `vp run pr:down <n>`.
//
// up   : branche Neon pr-<n> (TTL 7 j) → migrations → Hyperdrive clip-neon-pr-<n> →
//        Queue clip-notifications-pr-<n> → déploiement clip-jobs, clip-api, clip-web
//        (mode pr-<n>, dans cet ordre) → base vidée et vidéos de démo. Rejouable : chaque
//        étape réutilise ce qui existe déjà.
// down : supprime tout ce que `up` a créé (Workers, Workflow, Queue, bucket R2, Hyperdrive,
//        branche Neon). Rejouable : une ressource absente est ignorée.
//
// Le mode pr-<n> coupe les emails et Email Routing, le webhook Stream et le Container,
// et utilise le faux Stream et l'IA factice (voir packages/config).
//
// Variables : CLOUDFLARE_API_TOKEN (ou `cf auth login`), NEON_API_KEY. Aucune valeur
// secrète n'est affichée : le mot de passe de la branche est masqué dans GitHub Actions.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNT_ID, resourceNames } from "@clip/config";
import { connectionUri, createBranch, deleteBranch, findBranch } from "./neon.ts";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const [action, pr] = process.argv.slice(2);
if ((action !== "up" && action !== "down") || !pr || !/^\d+$/.test(pr)) {
  console.error("Usage : node scripts/pr-env.ts up|down <numéro de PR>");
  process.exit(1);
}
const mode = `pr-${pr}`;
const names = resourceNames(mode);
const domain = process.env.CLIP_DOMAIN ?? "clipshare.dev";
const url = `https://${mode}.${domain}`;

const step = (title: string) => console.log(`\n▸ ${title}`);

// Commandes ---------------------------------------------------------------------------

/** Environnement des commandes : jamais la base de dev d'un `.env.local`. */
const baseEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CF_SEND_TELEMETRY: "false",
  NEON_BRANCH: "",
  DATABASE_URL: "",
  DATABASE_URL_UNPOOLED: "",
});

/** `cf` du dépôt (lancé depuis apps/<app>, où il est installé). */
const cf = (
  args: ReadonlyArray<string>,
  options: { app?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): string =>
  execFileSync("vp", ["exec", "cf", ...args], {
    cwd: `${root}apps/${options.app ?? "api"}`,
    env: { ...baseEnv(), ...options.env },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  }) ?? "";

/** Sortie JSON d'une commande `cf` (les avertissements éventuels précèdent le JSON). */
const cfJson = <A>(args: ReadonlyArray<string>): A => {
  const out = cf(args);
  const start = out.search(/^[[{]/m);
  return JSON.parse(start === -1 ? out : out.slice(start)) as A;
};

/** Une commande dont l'échec veut seulement dire « déjà absent ». */
const attempt = (label: string, f: () => void) => {
  try {
    f();
  } catch {
    console.log(`  (${label} : absent ou déjà supprimé)`);
  }
};

// Ressources Cloudflare -----------------------------------------------------------------

interface Hyperdrive {
  readonly id: string;
  readonly name: string;
}

const findHyperdrive = () =>
  cfJson<ReadonlyArray<Hyperdrive>>(["hyperdrive", "list"]).find(
    (h) => h.name === names.hyperdrive,
  ) ?? null;

/** Hyperdrive vers la branche pr-<n>, sans cache (comme clip-neon en production). */
const ensureHyperdrive = (db: URL): string => {
  const body = JSON.stringify({
    name: names.hyperdrive,
    origin: {
      scheme: "postgres",
      host: db.hostname,
      port: Number(db.port || 5432),
      database: db.pathname.slice(1),
      user: decodeURIComponent(db.username),
      password: decodeURIComponent(db.password),
    },
    caching: { disabled: true },
  });
  const existing = findHyperdrive();
  const result = existing
    ? cfJson<Hyperdrive>(["hyperdrive", "update", existing.id, "--body", body])
    : cfJson<Hyperdrive>(["hyperdrive", "create", "--body", body]);
  return result.id;
};

interface Queue {
  readonly queue_id: string;
  readonly queue_name: string;
}

const findQueue = () =>
  cfJson<ReadonlyArray<Queue>>(["queues", "list"]).find(
    (q) => q.queue_name === names.notifications,
  ) ?? null;

/** Vide le bucket média (les objets du faux Stream), sans quoi il ne peut être supprimé. */
const emptyBucket = () => {
  for (let i = 0; i < 100; i++) {
    const objects = cfJson<ReadonlyArray<{ key: string }>>([
      "r2",
      "objects",
      "list",
      "--bucket-name",
      names.media,
      "--per-page",
      "1000",
    ]);
    if (!Array.isArray(objects) || objects.length === 0) return;
    cf([
      "r2",
      "objects",
      "bulk-delete",
      "--bucket-name",
      names.media,
      "--body",
      JSON.stringify(objects.map((o) => o.key)),
      "--force",
    ]);
  }
};

/** Attend que pr-<n>.clipshare.dev réponde (certificat et DNS du domaine personnalisé). */
const waitForHealth = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // DNS ou certificat pas encore prêts
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${url} ne répond pas après 5 minutes`);
};

// Actions ----------------------------------------------------------------------------------

const up = async () => {
  step(`Branche Neon ${mode}`);
  const branch = (await findBranch(mode)) ?? (await createBranch(mode, { ttlDays: 7 }));
  const db = await connectionUri(branch);
  const dbEnv = { DATABASE_URL: db.href, DATABASE_URL_UNPOOLED: db.href };

  step("Migrations");
  execFileSync("vp", ["exec", "drizzle-kit", "migrate"], {
    cwd: `${root}packages/db`,
    env: { ...baseEnv(), ...dbEnv },
    stdio: "inherit",
  });

  step(`Hyperdrive ${names.hyperdrive}`);
  const hyperdriveId = ensureHyperdrive(db);

  step(`Queue ${names.notifications}`);
  if (findQueue() === null) cf(["queues", "create", "--queue-name", names.notifications]);

  const deployEnv = {
    CLIP_HYPERDRIVE_ID: hyperdriveId,
    CLIP_CONTAINERS: "0",
    CLIP_EMAIL: "0",
    CLIP_EMAIL_ROUTING: "0",
    CLIP_STREAM_WEBHOOK: "0",
  };
  for (const app of ["jobs", "api", "web"] as const) {
    step(`Déploiement de ${names.workers[app]}`);
    cf(["deploy", "--mode", mode, "--message", `PR #${pr}`], {
      app,
      env: deployEnv,
      inherit: true,
    });
  }

  step(`Attente de ${url}`);
  await waitForHealth();

  step("Vidéos de démo");
  execFileSync("node", ["scripts/seed.ts", "--reset"], {
    cwd: `${root}packages/db`,
    env: { ...baseEnv(), ...dbEnv, CLIP_DEV_URL: url },
    stdio: "inherit",
  });

  console.log(`\n✓ ${url}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
};

const down = async () => {
  // web → api → jobs : chacun référence le suivant (service bindings, Workflow, DO).
  for (const app of ["web", "api", "jobs"] as const) {
    step(`Suppression de ${names.workers[app]}`);
    attempt(names.workers[app], () =>
      cf(["workers", "delete", names.workers[app], "--force", "--delete-with-references"]),
    );
  }

  step(`Workflow ${names.pipeline}`);
  attempt(names.pipeline, () => cf(["workflows", "delete", names.pipeline, "--force"]));

  step(`Queue ${names.notifications}`);
  const queue = findQueue();
  if (queue) cf(["queues", "delete", queue.queue_id, "--force"]);

  step(`Bucket R2 ${names.media}`);
  attempt(names.media, () => {
    emptyBucket();
    cf(["r2", "buckets", "delete", names.media, "--force"]);
  });

  step(`Hyperdrive ${names.hyperdrive}`);
  const hyperdrive = findHyperdrive();
  if (hyperdrive) cf(["hyperdrive", "delete", hyperdrive.id, "--force"]);

  step(`Branche Neon ${mode}`);
  const branch = await findBranch(mode);
  if (branch) await deleteBranch(branch);

  console.log(`\n✓ environnement ${mode} supprimé`);
};

await (action === "up" ? up() : down());
