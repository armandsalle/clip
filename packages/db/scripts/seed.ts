// Données de démo pour le dev local : `vp run db:seed` (voir CONTRIBUTING.md).
//
// 1. applique les migrations à la base de dev (.env.local ou Postgres Docker) ;
// 2. remplace les vidéos de démo (identifiants fixes) : vidéo prête, transcription,
//    résumé, chapitres, commentaires, comme après un passage complet du pipeline ;
// 3. envoie un MP4 généré par ffmpeg au faux Stream du dev local (`vp run dev`),
//    pour que le lecteur ait quelque chose à lire. Sans serveur, relancer le seed
//    une fois `vp run dev` démarré.
//
// Refuse la base de production : `databaseUrl` (packages/config) l'écarte hors prod.
// `--reset` vide d'abord toutes les vidéos (branche Neon d'une PR, copiée de la prod).
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DateTime, Duration, Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { databaseUrl, LOCAL_DATABASE_URL } from "@clip/config";
import {
  Comment,
  CommentId,
  EnrichmentStatus,
  type EnrichmentKind,
  StreamUid,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
} from "@clip/domain";
import { Db } from "../src/Db.ts";
import { videos } from "../src/schema.ts";
import { Store } from "../src/Store.ts";
import { type DemoVideo, demoVideos } from "./demo.ts";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url).href);
const mediaFolder = fileURLToPath(
  new URL("../../../node_modules/.cache/clip-seed", import.meta.url).href,
);
const devUrl = process.env.CLIP_DEV_URL ?? "http://localhost:5173";

const exit = (message: string): never => {
  console.error(message);
  // workers-types redéclare `process.exit` sans `never`.
  return process.exit(1) as never;
};

const url =
  databaseUrl(false) ??
  exit(
    "Aucune base de dev. Lancez `vp run db:up`, puis copiez .env.example " +
      `en .env.local (DATABASE_URL=${LOCAL_DATABASE_URL}).`,
  );

/** `--reset` : supprime toutes les vidéos avant le seed (environnements de PR). */
const reset = process.argv.includes("--reset");
if (reset && process.env.CLIP_ALLOW_PRODUCTION_DB === "1") {
  exit("--reset est refusé avec CLIP_ALLOW_PRODUCTION_DB=1.");
}

const done = (ms: number) => EnrichmentStatus.cases.Done.make({ durationMs: ms });
const disabled = EnrichmentStatus.cases.Disabled.make({});

/** Une vidéo de démo, telle que le pipeline l'aurait laissée. */
const seedVideo = Effect.fn("seed.video")(function* (demo: DemoVideo) {
  const store = yield* Store;
  const now = yield* DateTime.now;
  const createdAt = DateTime.subtract(now, { hours: demo.hoursAgo });
  const id = VideoId.make(demo.id);
  const adminKey = randomBytes(24).toString("base64url");
  const video = new Video({
    id,
    streamUid: StreamUid.make(demo.streamUid),
    title: demo.title,
    status: VideoStatus.cases.Ready.make({
      readyAt: DateTime.add(createdAt, { seconds: 20 }),
      duration: demo.duration,
    }),
    thumbnail: Thumbnail.cases.Auto.make({}),
    expiry: demo.expiry,
    createdAt,
  });
  yield* store.createVideo(
    video,
    createHash("sha256").update(adminKey).digest("hex"),
    demo.ownerEmail,
  );

  const enrichments: ReadonlyArray<readonly [EnrichmentKind, EnrichmentStatus, unknown?]> = [
    ["thumbnail", done(180), { url: `/dev/stream/${demo.streamUid}/thumbnail.svg` }],
    ["audio", done(2400)],
    ["transcript", done(1900), { language: "fr", segments: demo.segments }],
    ["captions", done(120)],
    ["hd", done(9000)],
    ["summary", done(3100), { summary: demo.summary, chapters: demo.chapters }],
    ["suggestions", done(40), { times: [0.2, 0.5, 0.8].map((p) => demo.duration * p) }],
    ["storyboard", disabled],
    ["shareCard", done(60), { path: `/v/${demo.id}/card.png` }],
    ["index", done(800), { indexed: true }],
    ["notify", done(350)],
  ];
  for (const [kind, status, result] of enrichments) {
    yield* store.setEnrichment(id, kind, status, result);
  }

  for (const [i, c] of demo.comments.entries()) {
    yield* store.addComment(
      new Comment({
        id: CommentId.make(c.id),
        videoId: id,
        parentId: c.parentId === null ? null : CommentId.make(c.parentId),
        author: c.author,
        body: c.body,
        time: c.time,
        via: c.via,
        createdAt: DateTime.add(createdAt, { minutes: 30 + i * 7 }),
      }),
    );
  }
  return { demo, adminKey };
});

/** MP4 de démo (mire teintée + tonalité), généré une fois puis gardé en cache. */
const demoMedia = (demo: DemoVideo): Uint8Array | null => {
  const file = `${mediaFolder}/${demo.streamUid}.mp4`;
  if (!existsSync(file)) {
    mkdirSync(mediaFolder, { recursive: true });
    const d = String(demo.duration);
    try {
      execFileSync(
        "ffmpeg",
        [
          ["-y", "-loglevel", "error"],
          ["-f", "lavfi", "-i", `testsrc2=s=1280x720:r=24:d=${d}`],
          ["-f", "lavfi", "-i", `color=c=${demo.color}:s=1280x720:r=24:d=${d}`],
          ["-f", "lavfi", "-i", `sine=frequency=330:sample_rate=48000:duration=${d}`],
          [
            "-filter_complex",
            "[0:v]hue=s=0.2,format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_mode=multiply,format=yuv420p[v]",
          ],
          ["-map", "[v]", "-map", "2:a"],
          ["-c:v", "libx264", "-preset", "veryfast", "-crf", "30"],
          ["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", file],
        ].flat(),
        { stdio: "inherit" },
      );
    } catch {
      return null;
    }
  }
  return readFileSync(file);
};

/** Envoie le MP4 au faux Stream du dev local (route /dev/stream de clip-api). */
const uploadMedia = Effect.fn("seed.media")(function* (demo: DemoVideo) {
  const body = demoMedia(demo);
  if (body === null) return "ffmpeg absent : vidéo non générée" as const;
  return yield* Effect.tryPromise(() =>
    fetch(`${devUrl}/dev/stream/${demo.streamUid}`, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "x-clip-duration": String(demo.duration) },
      body,
    }),
  ).pipe(
    Effect.timeout(Duration.seconds(10)),
    Effect.map((r) => (r.ok ? ("ok" as const) : (`HTTP ${r.status}` as const))),
    Effect.orElseSucceed(() => "serveur de dev injoignable" as const),
  );
});

const program = Effect.gen(function* () {
  const db = yield* Db;
  yield* migrate(db, { migrationsFolder });
  if (reset) {
    // Environnement de PR : la branche Neon hérite des vidéos de production, illisibles
    // avec le faux Stream (et dont les emails n'ont rien à faire là) → base vidée.
    yield* db.delete(videos);
  }
  // Rejouable : les vidéos de démo (et, en cascade, leurs commentaires) sont recréées.
  yield* db.delete(videos).where(
    inArray(
      videos.id,
      demoVideos.map((d) => d.id),
    ),
  );
  const seeded = yield* Effect.forEach(demoVideos, seedVideo);

  console.log(`\n${seeded.length} vidéos de démo dans la base.`);
  let missingMedia = false;
  for (const { demo, adminKey } of seeded) {
    const media = yield* uploadMedia(demo);
    if (media !== "ok") missingMedia = true;
    console.log(`\n· ${demo.title}`);
    console.log(`  ${devUrl}/v/${demo.id}?k=${adminKey}   (lien d'admin)`);
    console.log(`  vidéo : ${media}`);
  }
  if (missingMedia) {
    console.log(
      `\nLecteur sans vidéo : démarrez \`vp run dev\` (${devUrl}), puis relancez \`vp run db:seed\`.`,
    );
  }
});

const DbLive = Db.layerPg.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })));

await Effect.runPromise(
  program.pipe(Effect.provide(Store.layerDrizzle.pipe(Layer.provideMerge(DbLive))), Effect.scoped),
);
