import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import {
  EnrichmentKind,
  EnrichmentStatus,
  StreamUid,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
  type EnrichmentStatus as Status,
} from "@clip/domain";
import { cardDuration, cardMeta, cardStatus } from "../src/lib/cardStatus.ts";

const now = DateTime.makeUnsafe("2026-10-18T10:00:00Z");
const video = (status: VideoStatus) =>
  new Video({
    id: VideoId.make("019a0000-0000-7000-8000-000000000001"),
    streamUid: StreamUid.make("s"),
    title: "Démo",
    status,
    thumbnail: Thumbnail.cases.Auto.make({}),
    expiry: "never",
    createdAt: now,
  });
const ready = video(VideoStatus.cases.Ready.make({ readyAt: now, duration: 245 }));
const steps = (overrides: Partial<Record<EnrichmentKind, Status>> = {}) =>
  Object.fromEntries(
    EnrichmentKind.literals.map((k) => [
      k,
      overrides[k] ?? EnrichmentStatus.cases.Pending.make({}),
    ]),
  ) as Record<EnrichmentKind, Status>;
const done = EnrichmentStatus.cases.Done.make({ durationMs: 10 });
const running = (progress?: number) =>
  EnrichmentStatus.cases.Running.make({
    attempt: 1,
    ...(progress === undefined ? {} : { progress }),
  });

describe("carte de la galerie", () => {
  it("compte les étapes de l'IA en cours (« Transcription 3/5 »)", () => {
    expect(
      cardStatus(ready, steps({ thumbnail: done, audio: done, transcript: running() })),
    ).toEqual({
      label: "Transcription 3/5",
      tone: "running",
    });
  });

  it("montre la HD en cours une fois l'IA terminée, puis plus rien", () => {
    const ai = { thumbnail: done, audio: done, transcript: done, captions: done, summary: done };
    expect(cardStatus(ready, steps({ ...ai, hd: running(64.7) }))).toEqual({
      label: "HD en cours · 64 %",
      tone: "retry",
    });
    expect(cardStatus(ready, steps({ ...ai, hd: done }))).toBeNull();
  });

  it("signale l'encodage et son échec", () => {
    expect(
      cardStatus(video(VideoStatus.cases.Encoding.make({ uploadedAt: now })), steps())?.label,
    ).toBe("Encodage");
    const failed = video(VideoStatus.cases.Failed.make({ failedAt: now, reason: "codec" }));
    expect(cardStatus(failed, steps())).toEqual({ label: "Échec de l'encodage", tone: "failed" });
    expect(cardDuration(failed)).toBe("–");
  });

  it("affiche la durée et une méta lisible", () => {
    expect(cardDuration(ready)).toBe("4:05");
    expect(cardMeta(ready, 0, now.epochMilliseconds + 3 * 3600_000)).toBe(
      "il y a 3 heures · aucun commentaire",
    );
    expect(cardMeta(ready, 12, now.epochMilliseconds + 60_000)).toBe(
      "il y a 1 minute · 12 commentaires",
    );
  });
});
