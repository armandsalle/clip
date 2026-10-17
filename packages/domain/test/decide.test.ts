import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, Result } from "effect";
import {
  canCommentAt,
  decide,
  expiresAt,
  StreamUid,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
} from "../src/index.ts";

const now = DateTime.makeUnsafe("2026-10-17T10:00:00Z");

const uploading = new Video({
  id: VideoId.make("019a0000-0000-7000-8000-0000000000a1"),
  streamUid: StreamUid.make("stream-uid-1"),
  title: null,
  status: VideoStatus.cases.Uploading.make({}),
  thumbnail: Thumbnail.cases.Auto.make({}),
  expiry: "7d",
  createdAt: now,
});

const ready = Result.getOrThrow(decide(uploading, { _tag: "Encoded", duration: 120 }, now));

describe("decide", () => {
  it.effect("Uploading → Encoding → Ready", () =>
    Effect.sync(() => {
      const encoding = Result.getOrThrow(decide(uploading, { _tag: "Uploaded" }, now));
      assert.strictEqual(encoding.status._tag, "Encoding");
      const r = Result.getOrThrow(decide(encoding, { _tag: "Encoded", duration: 120 }, now));
      assert.strictEqual(r.status._tag, "Ready");
    }),
  );

  it.effect("accepte « prête » avant la fin d'upload côté client", () =>
    Effect.sync(() => {
      assert.strictEqual(ready.status._tag, "Ready");
    }),
  );

  it.effect("refuse une miniature au-delà de la durée", () =>
    Effect.sync(() => {
      const result = decide(
        ready,
        { _tag: "SetThumbnail", thumbnail: Thumbnail.cases.Frame.make({ time: 500 }) },
        now,
      );
      assert.isTrue(Result.isFailure(result) && result.failure._tag === "OutOfRange");
    }),
  );

  it.effect("refuse une miniature tant que la vidéo n'est pas prête", () =>
    Effect.sync(() => {
      const result = decide(
        uploading,
        { _tag: "SetThumbnail", thumbnail: Thumbnail.cases.Frame.make({ time: 1 }) },
        now,
      );
      assert.isTrue(Result.isFailure(result) && result.failure._tag === "VideoNotReady");
    }),
  );

  it.effect("une vidéo supprimée est terminale", () =>
    Effect.sync(() => {
      const deleted = Result.getOrThrow(decide(ready, { _tag: "Delete" }, now));
      assert.isTrue(Result.isFailure(decide(deleted, { _tag: "Rename", title: "x" }, now)));
    }),
  );

  it.effect("calcule l'expiration depuis la création", () =>
    Effect.sync(() => {
      const at = Option.getOrThrow(expiresAt(ready));
      assert.strictEqual(DateTime.formatIso(at), "2026-10-24T10:00:00.000Z");
      const never = Result.getOrThrow(decide(ready, { _tag: "SetExpiry", expiry: "never" }, now));
      assert.isTrue(Option.isNone(expiresAt(never)));
    }),
  );

  it.effect("un commentaire vise une position existante d'une vidéo prête", () =>
    Effect.sync(() => {
      assert.isTrue(Result.isSuccess(canCommentAt(ready, 60)));
      assert.isTrue(Result.isFailure(canCommentAt(ready, 121)));
      assert.isTrue(Result.isFailure(canCommentAt(uploading, 0)));
    }),
  );
});
