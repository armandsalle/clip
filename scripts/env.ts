// Environnements déployés hors production (`vp run pr:up <n>`, `pr:preview <n>`,
// `pr:down <n>`, `staging:up`).
//
// up <n>       : environnement complet d'une PR serveur. Branche Neon pr-<n> (TTL 7 j,
//                copiée du staging : jamais de données de production) →
//                migrations → Hyperdrive clip-neon-pr-<n> → Queue clip-notifications-pr-<n>
//                → déploiement clip-jobs, clip-api, clip-web (mode pr-<n>, dans cet ordre).
//                La Preview pr-<n> d'une ancienne version « interface » est d'abord
//                supprimée : elle occupait pr-<n>.clipshare.dev.
// preview <n>  : PR d'interface. Preview `pr-<n>` de clip-web, branchée sur le staging
//                (clip-api-staging). Une PR qui a déjà son environnement complet le garde :
//                `preview` fait alors un `up`.
// down <n>     : supprime la Preview et tout ce que `up` a créé (Workers, Workflow, Queue,
//                bucket R2, Hyperdrive, branche Neon). Une ressource absente est ignorée.
// up staging   : staging permanent. Même chaîne que `up <n>` sur la branche Neon `staging`
//                (schéma seul, sans expiration), puis la Preview `staging` de clip-web.
//                À sa création, la branche a les tables de la prod sans aucune ligne :
//                base vidée et migrations rejouées depuis la première (packages/db).
// reset staging: repart de zéro (vidéos Stream `clip-staging`, bucket, branche Neon
//                supprimés), puis `up staging`. Neon ne sait pas remettre à zéro une
//                branche « schéma seul » : elle est recréée.
//
// Toutes les étapes sont rejouables : chacune réutilise ce qui existe déjà. Staging et PR
// utilisent le vrai Stream et la vraie IA : chaque vidéo est étiquetée `clip-<mode>`
// (créateur), clip-hooks lui relaie le webhook « vidéo prête ». Emails, Email Routing et
// Container sont coupés (voir packages/config).
//
// Accès : CLOUDFLARE_API_TOKEN (ou `cf auth login`) et NEON_API_KEY (ou `neonctl auth`,
// voir scripts/neon.ts). Aucune valeur
// secrète n'est affichée : le mot de passe de la branche est masqué dans GitHub Actions.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNT_ID, resourceNames, STAGING, streamCreator, WORKERS_SUBDOMAIN } from "@clip/config";
import { childBranches, connectionUri, createBranch, deleteBranch, findBranch } from "./neon.ts";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const [action, target] = process.argv.slice(2);
const staging = target === STAGING;
if (
  (action !== "up" && action !== "down" && action !== "preview" && action !== "reset") ||
  !target ||
  !(staging ? action === "up" || action === "reset" : /^\d+$/.test(target) && action !== "reset")
) {
  console.error("Usage : node scripts/env.ts up|preview|down <numéro de PR>  |  up|reset staging");
  process.exit(1);
}
const mode = staging ? STAGING : `pr-${target}`;
const names = resourceNames(mode);
const web = resourceNames("production").workers.web;
const domain = process.env.CLIP_DOMAIN ?? "clipshare.dev";
const url = `https://${mode}.${domain}`;
/** URL workers.dev d'une Preview de clip-web (hors du Bot Fight Mode de la zone). */
const previewWorkersDev = (name: string) =>
  `https://${name}-${web}.${WORKERS_SUBDOMAIN}.workers.dev`;

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
): string => {
  try {
    return (
      execFileSync("vp", ["exec", "cf", ...args], {
        cwd: `${root}apps/${options.app ?? "api"}`,
        env: { ...baseEnv(), ...options.env },
        encoding: "utf8",
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      }) ?? ""
    );
  } catch (error) {
    // Message d'erreur de l'API (stderr) dans l'exception : `attempt` le lit.
    const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
    const output = [stdout, stderr]
      .map((o) => String(o ?? ""))
      .join("\n")
      .trim();
    throw new Error(`cf ${args.slice(0, 3).join(" ")} : ${output}`, { cause: error });
  }
};

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
const failures: Array<string> = [];

/**
 * Étape de suppression : « introuvable » veut dire déjà supprimé ; toute autre erreur
 * est notée, le nettoyage continue, et `pr:down` échoue à la fin.
 */
const attempt = (label: string, f: () => void) => {
  try {
    f();
  } catch (error) {
    const message = String((error as Error).message ?? error);
    if (/not found|does not exist|\b(10007|10006|10013)\b|404 Not Found/i.test(message)) {
      console.log(`  (${label} : absent ou déjà supprimé)`);
    } else {
      failures.push(label);
      console.error(`  échec (${label}) : ${message}`);
    }
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

/** Sorties pour GitHub Actions : adresse publique, adresse de la CI, type d'environnement. */
const output = (values: { url: string; ciUrl: string; kind: "complet" | "interface" }) => {
  console.log(`\n✓ ${values.url} (CI : ${values.ciUrl})`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `url=${values.url}\nci_url=${values.ciUrl}\nkind=${values.kind}\n`,
    );
  }
};

/**
 * Preview de clip-web : le code du site de la branche, avec la config de production
 * évaluée en `isPreview` (API → clip-api-staging, voir apps/web/cloudflare.config.ts).
 * Servie sur `<nom>.clipshare.dev` et sur workers.dev.
 */
const deployPreview = async (name: string) => {
  step(`Preview ${name} de ${web} (branchée sur ${resourceNames(STAGING).workers.api})`);
  console.log(cf(["previews", "deploy", name, "--mode", "production"], { app: "web" }));
  const ciUrl = previewWorkersDev(name);
  step(`Attente de ${ciUrl}`);
  await waitForHealth(ciUrl);
  return ciUrl;
};

const deletePreview = (name: string) =>
  attempt(`Preview ${name}`, () => cf(["previews", "delete", name, "--worker", web, "--force"]));

const up = async () => {
  if (!staging) {
    // Ancienne Preview « interface » de la PR : elle libère pr-<n>.clipshare.dev.
    step(`Preview ${mode}`);
    deletePreview(mode);
  }

  step(`Branche Neon ${mode}`);
  const existing = await findBranch(mode);
  const branch = existing ?? (await createDatabaseBranch());
  const db = await connectionUri(branch);
  const dbEnv = { DATABASE_URL: db.href, DATABASE_URL_UNPOOLED: db.href };
  const inDb = (command: string, args: ReadonlyArray<string>) =>
    execFileSync(command, args, {
      cwd: `${root}packages/db`,
      env: { ...baseEnv(), ...dbEnv },
      stdio: "inherit",
    });

  if (staging && existing === null) {
    // Schéma seul : tables vides et journal des migrations vide, on repart de zéro.
    step("Base reconstruite depuis les migrations");
    inDb("node", ["scripts/rebuild.ts"]);
  } else {
    step("Migrations");
    inDb("vp", ["exec", "drizzle-kit", "migrate"]);
  }

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
      const out = cf(
        ["deploy", "--mode", mode, "--message", staging ? "staging" : `PR #${target}`],
        {
          app,
          env: { ...deployEnv, CLIP_BOOTSTRAP: bootstrap ? "1" : "0" },
        },
      );
      console.log(out);
      return out;
    } catch (error) {
      // Sortie capturée (pour l'URL workers.dev) : on la montre avant d'échouer.
      console.log(String((error as Error).message));
      throw error;
    }
  };
  // jobs → api (RPC) et api → jobs (Workflow) se référencent : au premier déploiement,
  // jobs part sans binding vers api, puis est redéployé complet une fois api en place.
  const firstDeploy = !workerExists(names.workers.api);
  deploy("jobs", firstDeploy);
  deploy("api");
  if (staging) {
    if (firstDeploy) deploy("jobs");
    // Pas de clip-web-staging : le site du staging est la Preview `staging` de clip-web.
    output({ url, ciUrl: await deployPreview(STAGING), kind: "complet" });
    return;
  }
  // URL workers.dev de clip-web, affichée par `cf deploy` : celle que la CI utilise, car
  // le Bot Fight Mode de la zone bloque les runners sur pr-<n>.clipshare.dev.
  const ciUrl = /https:\/\/[\w.-]+\.workers\.dev/.exec(deploy("web"))?.[0] ?? url;
  if (firstDeploy) deploy("jobs");

  step(`Attente de ${ciUrl}`);
  await waitForHealth(ciUrl);
  output({ url, ciUrl, kind: "complet" });
};

/**
 * Branche Neon d'un environnement, sans aucune donnée de production :
 * - staging : « schéma seul » depuis production (les tables, aucune ligne) ;
 * - PR : copie du staging (ses tables, ses données de test, son journal de migrations),
 *   qui expire seule au bout de 7 jours.
 */
const createDatabaseBranch = async () => {
  if (staging) {
    const production =
      (await findBranch("production")) ?? fail("branche Neon « production » introuvable");
    return createBranch(mode, { parent: production, schemaOnly: true });
  }
  const parent =
    (await findBranch(STAGING)) ??
    fail("branche Neon « staging » introuvable : lancez d'abord `vp run staging:up`");
  return createBranch(mode, { parent, ttlDays: 7 });
};

const fail = (message: string): never => {
  throw new Error(message);
};

/** PR d'interface : Preview sur le staging, sauf si la PR a déjà son environnement complet. */
const preview = async () => {
  if (workerExists(names.workers.api)) {
    console.log(`${names.workers.api} existe : la PR garde son environnement complet.`);
    return up();
  }
  output({ url, ciUrl: await deployPreview(mode), kind: "interface" });
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
  step(`Preview ${mode}`);
  deletePreview(mode);

  step(`Vidéos Stream (créateur ${streamCreator(mode)})`);
  attempt("vidéos Stream", deleteStreamVideos);

  // web → api → jobs : chacun référence le suivant (service bindings, Workflow, DO).
  // La Queue part avant jobs : Cloudflare refuse de supprimer un consommateur (10064).
  for (const app of ["web", "api"] as const) {
    step(`Suppression de ${names.workers[app]}`);
    attempt(names.workers[app], () =>
      cf(["workers", "delete", names.workers[app], "--force", "--delete-with-references"]),
    );
  }

  step(`Queue ${names.notifications}`);
  attempt(names.notifications, () => {
    const queue = findQueue();
    if (queue) cf(["queues", "delete", queue.queue_id, "--force"]);
  });

  step(`Suppression de ${names.workers.jobs}`);
  attempt(names.workers.jobs, () =>
    cf(["workers", "delete", names.workers.jobs, "--force", "--delete-with-references"]),
  );

  step(`Workflow ${names.pipeline}`);
  attempt(names.pipeline, () => cf(["workflows", "delete", names.pipeline, "--force"]));

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

  if (failures.length > 0) {
    throw new Error(`nettoyage incomplet : ${failures.join(", ")} (voir plus haut)`);
  }
  console.log(`\n✓ environnement ${mode} supprimé`);
};

/** Staging remis à zéro : la branche « schéma seul » est recréée, puis `up`. */
const reset = async () => {
  const current = await findBranch(mode);
  const children = current ? await childBranches(current) : [];
  if (children.length > 0) {
    // Les branches des PR complètes sont copiées du staging.
    fail(
      `branches Neon copiées du staging : ${children.map((b) => b.name).join(", ")}. ` +
        "Fermez ces PR (ou `vp run pr:down <n>`), puis relancez.",
    );
  }

  step(`Vidéos Stream (créateur ${streamCreator(mode)})`);
  attempt("vidéos Stream", deleteStreamVideos);

  step(`Bucket R2 ${names.media} vidé`);
  attempt(names.media, emptyBucket);

  step(`Branche Neon ${mode} supprimée`);
  if (current) await deleteBranch(current);

  if (failures.length > 0) {
    throw new Error(`remise à zéro incomplète : ${failures.join(", ")} (voir plus haut)`);
  }
  await up();
};

const actions = { up, preview, down, reset } as const;
await actions[action]();
