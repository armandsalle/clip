import { Context, Effect, Layer, Schema } from "effect";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  Comment,
  type CommentId,
  EnrichmentStatus,
  Forbidden,
  isTerminal,
  Video,
  VideoNotFound,
  type EnrichmentKind,
  VideoId,
} from "@clip/domain";
import { Db } from "./Db.ts";
import { comments, enrichments, videos } from "./schema.ts";

export interface EnrichmentRecord {
  readonly kind: EnrichmentKind;
  readonly status: EnrichmentStatus;
  readonly result: unknown;
}

/** Position dans la galerie : la dernière vidéo de la page précédente. */
export interface GalleryCursor {
  readonly createdAtMs: number;
  readonly id: VideoId;
}

export interface GalleryQuery {
  readonly cursor: GalleryCursor | null;
  /** Recherche dans le titre et dans la transcription (insensible à la casse). */
  readonly q: string | null;
  readonly limit: number;
}

export interface GalleryEntry {
  readonly video: Video;
  readonly comments: number;
  readonly enrichments: ReadonlyArray<EnrichmentRecord>;
}

export interface GalleryResult {
  readonly entries: ReadonlyArray<GalleryEntry>;
  /** Il reste des vidéos après cette page. */
  readonly more: boolean;
  /** Nombre total de vidéos qui correspondent à la recherche (toutes pages). */
  readonly total: number;
}

/** `%` et `_` cherchés tels quels dans un ILIKE. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Ordre de la galerie : plus récentes d'abord, l'identifiant départage. */
const isBefore = (video: Video, cursor: GalleryCursor) =>
  video.createdAt.epochMilliseconds < cursor.createdAtMs ||
  (video.createdAt.epochMilliseconds === cursor.createdAtMs && video.id < cursor.id);

// Stockage des vidéos, enrichissements et commentaires. Deux implémentations :
// Drizzle (Neon via Hyperdrive, testée contre PGlite) et mémoire (cf dev sans Postgres).

/** Ligne `comments` → entrée encodée du Schema Comment (sans le jeton de réponse). */
const commentInput = (r: typeof comments.$inferSelect) => ({
  id: r.id,
  videoId: r.videoId,
  parentId: r.parentId,
  author: r.author,
  body: r.body,
  time: r.time,
  via: r.via,
  createdAt: r.createdAt.toISOString(),
});

/** Jeton de réponse : 16 octets aléatoires en base32 minuscule (sûr dans une adresse email). */
const newReplyToken = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => alphabet[b % 32]).join("");
};

export class Store extends Context.Service<
  Store,
  {
    createVideo(video: Video, adminKeyHash: string, ownerEmail: string | null): Effect.Effect<void>;
    getVideo(id: VideoId): Effect.Effect<Video, VideoNotFound>;
    /** Vidéo associée à un identifiant Stream (webhook). */
    findByStreamUid(uid: string): Effect.Effect<VideoId | null>;
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
    /** Enregistre le commentaire et renvoie son jeton de réponse par email. */
    addComment(comment: Comment): Effect.Effect<string>;
    /** Commentaire visé par une adresse reply+<jeton>@… */
    findCommentByReplyToken(token: string): Effect.Effect<Comment | null>;
    /** Jeton de réponse d'un commentaire (null pour les anciens commentaires). */
    replyTokenOf(commentId: CommentId): Effect.Effect<string | null>;
    /** Vidéo expirée ou supprimée : sa transcription, ses résultats et ses commentaires disparaissent. */
    purgeContent(id: VideoId): Effect.Effect<void>;
    /** Galerie publique : vidéos ni expirées ni supprimées, par pages. */
    listPublic(query: GalleryQuery): Effect.Effect<GalleryResult>;
    /** Vidéos qui ont une durée de vie et ne sont pas encore expirées ni supprimées (les plus anciennes d'abord). */
    expiring(limit: number): Effect.Effect<ReadonlyArray<Video>>;
  }
>()("@clip/db/Store") {
  static readonly layerMemory = Layer.sync(Store, () => {
    const vids = new Map<VideoId, { video: Video; hash: string; email: string | null }>();
    const enrich = new Map<VideoId, Map<EnrichmentKind, EnrichmentRecord>>();
    const comms = new Map<VideoId, Array<Comment>>();
    const tokens = new Map<string, Comment>();
    const find = (id: VideoId) =>
      Effect.fromNullishOr(vids.get(id)).pipe(Effect.mapError(() => new VideoNotFound({ id })));

    return Store.of({
      createVideo: (video, hash, email) =>
        Effect.sync(() => void vids.set(video.id, { video, hash, email })),
      getVideo: (id) => Effect.map(find(id), (r) => r.video),
      findByStreamUid: (uid) =>
        Effect.sync(
          () => [...vids.values()].find((r) => r.video.streamUid === uid)?.video.id ?? null,
        ),
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
        Effect.sync(() => {
          comms.set(comment.videoId, [...(comms.get(comment.videoId) ?? []), comment]);
          const token = newReplyToken();
          tokens.set(token, comment);
          return token;
        }),
      findCommentByReplyToken: (token) => Effect.sync(() => tokens.get(token) ?? null),
      purgeContent: (id) =>
        Effect.sync(() => {
          enrich.delete(id);
          for (const c of comms.get(id) ?? []) {
            for (const [token, t] of tokens) if (t.id === c.id) tokens.delete(token);
          }
          comms.delete(id);
        }),
      replyTokenOf: (commentId) =>
        Effect.sync(() => [...tokens].find(([, c]) => c.id === commentId)?.[0] ?? null),
      listPublic: ({ cursor, q, limit }) =>
        Effect.sync(() => {
          const needle = q?.toLowerCase() ?? null;
          const said = (id: VideoId) =>
            JSON.stringify(enrich.get(id)?.get("transcript")?.result ?? "").toLowerCase();
          const matching = [...vids.values()]
            .map((r) => r.video)
            .filter((v) => !isTerminal(v))
            .filter(
              (v) =>
                needle === null ||
                (v.title ?? "").toLowerCase().includes(needle) ||
                said(v.id).includes(needle),
            )
            .sort(
              (a, b) =>
                b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds ||
                (a.id < b.id ? 1 : -1),
            );
          const after = cursor === null ? matching : matching.filter((v) => isBefore(v, cursor));
          return {
            entries: after.slice(0, limit).map((video) => ({
              video,
              comments: comms.get(video.id)?.length ?? 0,
              enrichments: [...(enrich.get(video.id)?.values() ?? [])],
            })),
            more: after.length > limit,
            total: matching.length,
          };
        }),
      expiring: (limit) =>
        Effect.sync(() =>
          [...vids.values()]
            .map((r) => r.video)
            .filter((v) => v.expiry !== "never" && !isTerminal(v))
            .slice(0, limit),
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
    // Liste exhaustive vérifiée par TypeScript : une méthode ajoutée au service sans
    // être relayée ici ne compile plus (c'est ainsi que `setOwnerEmail` avait été oubliée).
    const methods = {
      createVideo: true,
      getVideo: true,
      findByStreamUid: true,
      saveVideo: true,
      checkAdmin: true,
      ownerEmail: true,
      setOwnerEmail: true,
      enrichments: true,
      setEnrichment: true,
      comments: true,
      addComment: true,
      findCommentByReplyToken: true,
      replyTokenOf: true,
      purgeContent: true,
      listPublic: true,
      expiring: true,
    } satisfies Record<keyof Store["Service"], true>;
    return Layer.succeed(
      Store,
      Store.of(
        Object.fromEntries(
          (Object.keys(methods) as Array<keyof Store["Service"]>).map((key) => [key, call(key)]),
        ) as unknown as Store["Service"],
      ),
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

        findByStreamUid: Effect.fn("Store.findByStreamUid")(function* (uid) {
          const rows = yield* db
            .select({ id: videos.id })
            .from(videos)
            .where(eq(videos.streamUid, uid));
          return rows[0] ? VideoId.make(rows[0].id) : null;
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
          return yield* Effect.forEach(rows, (r) => decodeComment(commentInput(r)));
        }, Effect.orDie),

        purgeContent: Effect.fn("Store.purgeContent")(function* (id) {
          yield* Effect.all(
            [
              db.delete(enrichments).where(eq(enrichments.videoId, id)),
              db.delete(comments).where(eq(comments.videoId, id)),
            ],
            { concurrency: 2, discard: true },
          );
        }, Effect.orDie),

        replyTokenOf: Effect.fn("Store.replyTokenOf")(function* (commentId) {
          const rows = yield* db
            .select({ replyToken: comments.replyToken })
            .from(comments)
            .where(eq(comments.id, commentId));
          return rows[0]?.replyToken ?? null;
        }, Effect.orDie),

        findCommentByReplyToken: Effect.fn("Store.findCommentByReplyToken")(function* (token) {
          const rows = yield* db.select().from(comments).where(eq(comments.replyToken, token));
          const row = rows[0];
          return row ? yield* decodeComment(commentInput(row)) : null;
        }, Effect.orDie),

        listPublic: Effect.fn("Store.listPublic")(function* ({ cursor, q, limit }) {
          const visible = notInArray(videos.status, ["Expired", "Deleted"]);
          const search =
            q === null
              ? undefined
              : or(
                  ilike(videos.title, likePattern(q)),
                  exists(
                    db
                      .select({ one: sql`1` })
                      .from(enrichments)
                      .where(
                        and(
                          eq(enrichments.videoId, videos.id),
                          eq(enrichments.kind, "transcript"),
                          sql`${enrichments.result}::text ilike ${likePattern(q)}`,
                        ),
                      ),
                  ),
                );
          const after =
            cursor === null
              ? undefined
              : or(
                  lt(videos.createdAt, new Date(cursor.createdAtMs)),
                  and(eq(videos.createdAt, new Date(cursor.createdAtMs)), lt(videos.id, cursor.id)),
                );
          const rows = yield* db
            .select()
            .from(videos)
            .where(and(visible, search, after))
            .orderBy(desc(videos.createdAt), desc(videos.id))
            .limit(limit + 1);
          const [counted] = yield* db
            .select({ total: count() })
            .from(videos)
            .where(and(visible, search));
          const page = rows.slice(0, limit);
          const ids = page.map((r) => r.id);
          const commentCounts =
            ids.length === 0
              ? []
              : yield* db
                  .select({ videoId: comments.videoId, n: count() })
                  .from(comments)
                  .where(inArray(comments.videoId, ids))
                  .groupBy(comments.videoId);
          const enrichmentRows =
            ids.length === 0
              ? []
              : yield* db.select().from(enrichments).where(inArray(enrichments.videoId, ids));
          const entries = yield* Effect.forEach(page, (row) =>
            Effect.gen(function* () {
              return {
                video: yield* toVideo(row),
                comments: commentCounts.find((c) => c.videoId === row.id)?.n ?? 0,
                enrichments: yield* Effect.forEach(
                  enrichmentRows.filter((e) => e.videoId === row.id),
                  (e) =>
                    Effect.map(decodeStatus(e.status), (status) => ({
                      kind: e.kind,
                      status,
                      result: e.result,
                    })),
                ),
              };
            }),
          );
          return { entries, more: rows.length > limit, total: counted?.total ?? 0 };
        }, Effect.orDie),

        expiring: Effect.fn("Store.expiring")(function* (limit) {
          const rows = yield* db
            .select()
            .from(videos)
            .where(
              and(ne(videos.expiry, "never"), notInArray(videos.status, ["Expired", "Deleted"])),
            )
            .orderBy(asc(videos.createdAt))
            .limit(limit);
          return yield* Effect.forEach(rows, toVideo);
        }, Effect.orDie),

        addComment: Effect.fn("Store.addComment")(function* (comment) {
          const e = yield* encodeComment(comment);
          const replyToken = newReplyToken();
          yield* db.insert(comments).values({ ...e, createdAt: new Date(e.createdAt), replyToken });
          return replyToken;
        }, Effect.orDie),
      });
    }),
  );
}
