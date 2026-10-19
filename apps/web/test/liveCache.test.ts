import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import {
  Comment,
  CommentId,
  EnrichmentKind,
  EnrichmentStatus,
  StreamUid,
  Thumbnail,
  Video,
  VideoId,
  VideoStatus,
} from "@clip/domain";
import { VideoView } from "@clip/contract";
import { needsReload, patchComments, patchView } from "../src/lib/liveCache.ts";

const now = DateTime.makeUnsafe("2026-10-18T10:00:00Z");
const video = new Video({
  id: VideoId.make("019a0000-0000-7000-8000-000000000001"),
  streamUid: StreamUid.make("s"),
  title: null,
  status: VideoStatus.cases.Encoding.make({ uploadedAt: now }),
  thumbnail: Thumbnail.cases.Auto.make({}),
  expiry: "7d",
  createdAt: now,
});
const view = new VideoView({
  video,
  playback: null,
  enrichments: Object.fromEntries(
    EnrichmentKind.literals.map((k) => [k, EnrichmentStatus.cases.Pending.make({})]),
  ) as VideoView["enrichments"],
  summary: null,
  chapters: [],
  transcript: [],
  language: null,
  thumbnailSuggestions: [],
});
const comment = new Comment({
  id: CommentId.make("019a0000-0000-7000-8000-00000000c001"),
  videoId: video.id,
  parentId: null,
  author: "Alice",
  body: "Bravo",
  time: 3,
  via: "web",
  createdAt: now,
});

describe("cache patché par le temps réel", () => {
  it("met à jour l'état d'une étape sans recharger", () => {
    const running = EnrichmentStatus.cases.Running.make({ attempt: 1, progress: 40 });
    const next = patchView(view, { _tag: "Step", kind: "hd", status: running, at: now });
    expect(next.enrichments.hd).toEqual(running);
    expect(needsReload({ _tag: "Step", kind: "hd", status: running, at: now }, view)).toBe(false);
  });

  it("ignore les étapes inconnues (spans, emails)", () => {
    const done = EnrichmentStatus.cases.Done.make({ durationMs: 1 });
    expect(patchView(view, { _tag: "Step", kind: "mail.comment", status: done, at: now })).toBe(
      view,
    );
  });

  it("recharge quand un résultat arrive ou que la vidéo devient lisible", () => {
    const done = EnrichmentStatus.cases.Done.make({ durationMs: 1 });
    expect(needsReload({ _tag: "Step", kind: "summary", status: done, at: now }, view)).toBe(true);
    const ready = new Video({
      ...video,
      status: VideoStatus.cases.Ready.make({ readyAt: now, duration: 60 }),
    });
    expect(needsReload({ _tag: "VideoChanged", video: ready }, view)).toBe(true);
    expect(patchView(view, { _tag: "VideoChanged", video: ready }).video.status._tag).toBe("Ready");
    const renamed = new Video({ ...video, title: "Démo" });
    expect(needsReload({ _tag: "VideoChanged", video: renamed }, view)).toBe(false);
  });

  it("ajoute un commentaire reçu une seule fois", () => {
    const once = patchComments([], { _tag: "CommentAdded", comment });
    expect(once).toEqual([comment]);
    expect(patchComments(once, { _tag: "CommentAdded", comment })).toBe(once);
  });
});
