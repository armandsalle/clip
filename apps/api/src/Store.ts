import { Context, Effect, Layer, Schema } from "effect";
import { asc, eq, sql } from "drizzle-orm";
import {
  Comment,
  EnrichmentStatus,
  Forbidden,
  Video,
  VideoNotFound,
  type EnrichmentKind,
  type VideoId,
} from "@clip/domain";
import { Db } from "./db/Db.ts";
import { comments, enrichments, videos } from "./db/schema.ts";

export interface EnrichmentRecord {
  readonly kind: EnrichmentKind;
  readonly status: EnrichmentStatus;
  readonly result: unknown;
}

// Stockage des vidéos, enrichissements et commentaires. Deux implémentations :
// Drizzle (Neon via Hyperdrive, testée contre PGlite) et mémoire (cf dev sans Postgres).

export class Store extends Context.Service<
  Store,
  {
    createVideo(video: Video, adminKeyHash: string, ownerEmail: string | null): Effect.Effect<void>;
    getVideo(id: VideoId): Effect.Effect<Video, VideoNotFound>;
    saveVideo(video: Video): Effect.Effect<void>;
    /** Vérifie le secret d'admin (déjà haché) d'une vidéo. */
    checkAdmin(id: VideoId, adminKeyHash: string): Effect.Effect<void, VideoNotFound | Forbidden>;
    ownerEmail(id: VideoId): Effect.Effect<string | null, VideoNotFound>;
    setOwnerEmail(id: VideoId, email: string | null): Effect.Effect<void, VideoNotFound>;
    enrichments(id: VideoId): Effect.Effect<ReadonlyArray<EnrichmentRecord>>;
    setEnrichment(
      id: VideoId,
      kind: EnrichmentKind,
      status: EnrichmentStatus,
      result?: unknown,
    ): Effect.Effect<void>;
    comments(id: VideoId): Effect.Effect<ReadonlyArray<Comment>>;
    addComment(comment: Comment): Effect.Effect<void>;
  }
>()("@clip/api/Store") {
  static readonly layerMemory = Layer.sync(Store, () => {
    const vids = new Map<VideoId, { video: Video; hash: string; email: string | null }>();
    const enrich = new Map<VideoId, Map<EnrichmentKind, EnrichmentRecord>>();
    const comms = new Map<VideoId, Array<Comment>>();
    const find = (id: VideoId) =>
      Effect.fromNullishOr(vids.get(id)).pipe(Effect.mapError(() => new VideoNotFound({ id })));

    return Store.of({
      createVideo: (video, hash, email) =>
        Effect.sync(() => void vids.set(video.id, { video, hash, email })),
      getVideo: (id) => Effect.map(find(id), (r) => r.video),
      saveVideo: (video) =>
        Effect.sync(() => {
          const r = vids.get(video.id);
          if (r) vids.set(video.id, { ...r, video });
        }),
      checkAdmin: (id, hash) =>
        Effect.flatMap(find(id), (r) =>
          r.hash === hash ? Effect.void : Effect.fail(new Forbidden()),
        ),
      ownerEmail: (id) => Effect.map(find(id), (r) => r.email),
      setOwnerEmail: (id, email) => Effect.map(find(id), (r) => void vids.set(id, { ...r, email })),
      enrichments: (id) => Effect.sync(() => [...(enrich.get(id)?.values() ?? [])]),
      setEnrichment: (id, kind, status, result) =>
        Effect.sync(() => {
          const m = enrich.get(id) ?? new Map<EnrichmentKind, EnrichmentRecord>();
          m.set(kind, { kind, status, result: result ?? m.get(kind)?.result ?? null });
          enrich.set(id, m);
        }),
      comments: (id) =>
        Effect.sync(() => [...(comms.get(id) ?? [])].sort((a, b) => a.time - b.time)),
      addComment: (comment) =>
        Effect.sync(
          () => void comms.set(comment.videoId, [...(comms.get(comment.videoId) ?? []), comment]),
        ),
    });
  });

  /**
   * Une connexion par appel : sur Workers, une connexion TCP ouverte pendant une
   * requête ne peut pas servir à une autre (la requête suivante resterait bloquée).
   * Hyperdrive fait le pooling côté Cloudflare, donc ouvrir une connexion est peu
   * coûteux. Chaque appel construit sa propre base Drizzle, fermée à la fin.
   */
  static readonly layerPerCall = <E>(db: Layer.Layer<Db, E>) => {
    const scoped = Store.layerDrizzle.pipe(Layer.provide(db), Layer.orDie);
    const call =
      <K extends keyof Store["Service"]>(key: K) =>
      (...args: Parameters<Store["Service"][K]>) =>
        Store.use((store) =>
          (store[key] as (...a: typeof args) => Effect.Effect<unknown, VideoNotFound | Forbidden>)(
            ...args,
          ),
        ).pipe(Effect.provide(scoped));
    return Layer.succeed(
      Store,
      Store.of({
        createVideo: call("createVideo"),
        getVideo: call("getVideo"),
        saveVideo: call("saveVideo"),
        checkAdmin: call("checkAdmin"),
        ownerEmail: call("ownerEmail"),
        enrichments: call("enrichments"),
        setEnrichment: call("setEnrichment"),
        comments: call("comments"),
        addComment: call("addComment"),
      } as unknown as Store["Service"]),
    );
  };

  static readonly layerDrizzle = Layer.effect(
    Store,
    Effect.gen(function* () {
      const db = yield* Db;
      const decodeVideo = Schema.decodeEffect(Video);
      const encodeVideo = Schema.encodeEffect(Video);
      const decodeComment = Schema.decodeEffect(Comment);
      const encodeComment = Schema.encodeEffect(Comment);
      const decodeStatus = Schema.decodeEffect(EnrichmentStatus);
      const encodeStatus = Schema.encodeEffect(EnrichmentStatus);

      const videoRow = (id: VideoId) =>
        db
          .select()
          .from(videos)
          .where(eq(videos.id, id))
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) =>
              rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new VideoNotFound({ id })),
            ),
          );

      const toVideo = (row: typeof videos.$inferSelect) =>
        decodeVideo({
          id: row.id,
          streamUid: row.streamUid,
          title: row.title,
          status: row.statusDetails,
          thumbnail: row.thumbnail,
          expiry: row.expiry,
          createdAt: row.createdAt.toISOString(),
        }).pipe(Effect.orDie);

      const videoColumns = Effect.fnUntraced(function* (video: Video) {
        const e = yield* encodeVideo(video);
        return {
          title: e.title,
          status: e.status._tag,
          statusDetails: e.status,
          thumbnail: e.thumbnail,
          expiry: e.expiry,
        };
      });

      return Store.of({
        createVideo: Effect.fn("Store.createVideo")(function* (video, adminKeyHash, ownerEmail) {
          const cols = yield* videoColumns(video);
          yield* db.insert(videos).values({
            ...cols,
            id: video.id,
            streamUid: video.streamUid,
            adminKeyHash,
            ownerEmail,
            createdAt: new Date(video.createdAt.epochMilliseconds),
          });
        }, Effect.orDie),

        getVideo: Effect.fn("Store.getVideo")(function* (id) {
          return yield* toVideo(yield* videoRow(id));
        }),

        saveVideo: Effect.fn("Store.saveVideo")(function* (video) {
          const cols = yield* videoColumns(video);
          yield* db
            .update(videos)
            .set({ ...cols, updatedAt: sql`now()` })
            .where(eq(videos.id, video.id));
        }, Effect.orDie),

        checkAdmin: Effect.fn("Store.checkAdmin")(function* (id, hash) {
          const row = yield* videoRow(id);
          if (row.adminKeyHash !== hash) return yield* new Forbidden();
        }),

        ownerEmail: (id) => Effect.map(videoRow(id), (r) => r.ownerEmail),

        setOwnerEmail: Effect.fn("Store.setOwnerEmail")(function* (id, email) {
          yield* videoRow(id);
          yield* db
            .update(videos)
            .set({ ownerEmail: email, updatedAt: sql`now()` })
            .where(eq(videos.id, id))
            .pipe(Effect.orDie);
        }),

        enrichments: Effect.fn("Store.enrichments")(function* (id) {
          const rows = yield* db.select().from(enrichments).where(eq(enrichments.videoId, id));
          return yield* Effect.forEach(rows, (r) =>
            Effect.map(decodeStatus(r.status), (status) => ({
              kind: r.kind,
              status,
              result: r.result,
            })),
          );
        }, Effect.orDie),

        setEnrichment: Effect.fn("Store.setEnrichment")(function* (id, kind, status, result) {
          const encoded = yield* encodeStatus(status);
          yield* db
            .insert(enrichments)
            .values({ videoId: id, kind, status: encoded, result: result ?? null })
            .onConflictDoUpdate({
              target: [enrichments.videoId, enrichments.kind],
              set: {
                status: encoded,
                updatedAt: sql`now()`,
                ...(result === undefined ? {} : { result }),
              },
            });
        }, Effect.orDie),

        comments: Effect.fn("Store.comments")(function* (id) {
          const rows = yield* db
            .select()
            .from(comments)
            .where(eq(comments.videoId, id))
            .orderBy(asc(comments.time), asc(comments.createdAt));
          return yield* Effect.forEach(rows, (r) =>
            decodeComment({ ...r, createdAt: r.createdAt.toISOString() }),
          );
        }, Effect.orDie),

        addComment: Effect.fn("Store.addComment")(function* (comment) {
          const e = yield* encodeComment(comment);
          yield* db.insert(comments).values({ ...e, createdAt: new Date(e.createdAt) });
        }, Effect.orDie),
      });
    }),
  );
}
