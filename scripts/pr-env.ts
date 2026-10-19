// Environnement éphémère d'une pull request : `vp run pr:up <n>` / `vp run pr:down <n>`.
//
// up   : branche Neon pr-<n> (TTL 7 j) → migrations → Hyperdrive clip-neon-pr-<n> →
//        Queue clip-notifications-pr-<n> → déploiement clip-jobs, clip-api, clip-web
//        (mode pr-<n>, dans cet ordre) → base vidée et vidéos de démo. Rejouable : chaque
//        étape réutilise ce qui existe déjà.
// down : supprime tout ce que `up` a créé (Workers, Workflow, Queue, bucket R2, Hyperdrive,
//        branche Neon). Rejouable : une ressource absente est ignorée.
//
// Le mode pr-<n> utilise le vrai Stream et la vraie IA, comme la production : chaque
// vidéo Stream est étiquetée `clip-pr-<n>` (créateur), clip-hooks lui relaie le webhook
// « vidéo prête ». Emails, Email Routing et Container sont coupés (voir packages/config).
//
// Variables : CLOUDFLARE_API_TOKEN (ou `cf auth login`), NEON_API_KEY. Aucune valeur
// secrète n'est affichée : le mot de passe de la branche est masqué dans GitHub Actions.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNT_ID, resourceNames, streamCreator } from "@clip/config";
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

const workerExists = (name: string) => {
  try {
    cf(["workers", "get", name]);
    return true;
  } catch {
    return false;
  }
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

/**
 * Attend que pr-<n>.clipshare.dev réponde. Au premier déploiement, Cloudflare émet le
 * certificat du domaine personnalisé : constaté entre 5 et 10 minutes.
 */
const waitForHealth = async (base: string) => {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 15 * 60_000) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      // DNS ou certificat pas encore prêts
      last = String((error as Error).cause ?? error);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed % 60 < 10) console.log(`  ${elapsed} s : ${last}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`${base} ne répond pas après 15 minutes (${last})`);
};

// Actions ----------------------------------------------------------------------------------

const up = async () => {
  step(`Branche Neon ${mode}`);
  const existing = await findBranch(mode);
  const branch = existing ?? (await createBranch(mode, { ttlDays: 7 }));
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
  };
  const deploy = (app: "jobs" | "api" | "web", bootstrap = false) => {
    step(`Déploiement de ${names.workers[app]}${bootstrap ? " (amorce, sans RPC)" : ""}`);
    try {
      const out = cf(["deploy", "--mode", mode, "--message", `PR #${pr}`], {
        app,
        env: { ...deployEnv, CLIP_BOOTSTRAP: bootstrap ? "1" : "0" },
      });
      console.log(out);
      return out;
    } catch (error) {
      // Sortie capturée (pour l'URL workers.dev) : on la montre avant d'échouer.
      console.log(String((error as { stdout?: unknown }).stdout ?? ""));
      throw error;
    }
  };
  // jobs → api (RPC) et api → jobs (Workflow) se référencent : au premier déploiement,
  // jobs part sans binding vers api, puis est redéployé complet une fois api en place.
  const firstDeploy = !workerExists(names.workers.api);
  deploy("jobs", firstDeploy);
  deploy("api");
  // URL workers.dev de clip-web, affichée par `cf deploy` : celle que la CI utilise, car
  // le Bot Fight Mode de la zone bloque les runners sur pr-<n>.clipshare.dev.
  const ciUrl = /https:\/\/[\w.-]+\.workers\.dev/.exec(deploy("web"))?.[0] ?? url;
  if (firstDeploy) deploy("jobs");

  step(`Attente de ${ciUrl}`);
  await waitForHealth(ciUrl);

  if (existing === null) {
    // Branche neuve, copiée de la prod : vidée une fois (les pushs suivants gardent les
    // vidéos déposées pendant la revue).
    step("Base de la PR vidée");
    execFileSync("node", ["scripts/seed.ts", "--reset", "--no-demo"], {
      cwd: `${root}packages/db`,
      env: { ...baseEnv(), ...dbEnv },
      stdio: "inherit",
    });
  }

  console.log(`\n✓ ${url} (CI : ${ciUrl})`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\nci_url=${ciUrl}\n`);
  }
};

interface StreamVideo {
  readonly uid: string;
}

/** Vidéos Stream de la PR : créateur `clip-pr-<n>`, posé à la création du dépôt. */
const deleteStreamVideos = () => {
  const creator = streamCreator(mode);
  for (let i = 0; i < 20; i++) {
    const videos = cfJson<ReadonlyArray<StreamVideo>>([
      "stream",
      "videos",
      "list",
      "--creator",
      creator,
    ]);
    if (!Array.isArray(videos) || videos.length === 0) return;
    for (const video of videos) {
      console.log(`  ${video.uid}`);
      cf(["stream", "videos", "delete", video.uid, "--force"]);
    }
  }
};

const down = async () => {
  step(`Vidéos Stream (créateur ${streamCreator(mode)})`);
  // Un échec ici (permission Stream du token…) n'empêche pas le reste du nettoyage.
  let streamFailed = false;
  try {
    deleteStreamVideos();
  } catch (error) {
    streamFailed = true;
    console.error(`  échec : ${String(error)}`);
  }

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

  if (streamFailed) {
    throw new Error(`vidéos Stream ${streamCreator(mode)} non supprimées (voir plus haut)`);
  }
  console.log(`\n✓ environnement ${mode} supprimé`);
};

await (action === "up" ? up() : down());
