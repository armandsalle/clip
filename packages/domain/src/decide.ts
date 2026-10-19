import { DateTime, Duration, Option, Result, Schema } from "effect";
import {
  Expiry,
  InvalidTransition,
  OutOfRange,
  Thumbnail,
  Video,
  VideoNotReady,
  VideoStatus,
  videoFields,
} from "./Video.ts";

// Cœur métier pur : (vidéo, événement, maintenant) -> nouvelle vidéo ou erreur.

/** Événements du domaine : un Schema, car ils traversent la RPC jobs → api. */
export const VideoEvent = Schema.TaggedUnion({
  Uploaded: {},
  Encoded: { duration: Schema.Finite },
  EncodingFailed: { reason: Schema.String },
  Rename: { title: Schema.String },
  SetThumbnail: { thumbnail: Thumbnail },
  SetExpiry: { expiry: Expiry },
  Expire: {},
  Delete: {},
});
export type VideoEvent = typeof VideoEvent.Type;

export type VideoError = InvalidTransition | VideoNotReady | OutOfRange;

export const isTerminal = (video: Video): boolean =>
  VideoStatus.isAnyOf(["Expired", "Deleted"])(video.status);

export const isPlayable = (video: Video): boolean => video.status._tag === "Ready";

const expiryDurations: Record<Expiry, Option.Option<Duration.Duration>> = {
  never: Option.none(),
  "1d": Option.some(Duration.days(1)),
  "7d": Option.some(Duration.days(7)),
  "30d": Option.some(Duration.days(30)),
};

/** Date d'expiration, comptée depuis la création. */
export const expiresAt = (video: Video): Option.Option<DateTime.Utc> =>
  Option.map(expiryDurations[video.expiry], (d) => DateTime.addDuration(video.createdAt, d));

const invalid = (video: Video, event: VideoEvent) =>
  Result.fail(new InvalidTransition({ from: video.status._tag, event: event._tag }));

const with_ = (video: Video, patch: Partial<ReturnType<typeof videoFields>>) =>
  Result.succeed(new Video({ ...videoFields(video), ...patch }));

export const decide = (
  video: Video,
  event: VideoEvent,
  now: DateTime.Utc,
): Result.Result<Video, VideoError> => {
  const status = video.status;
  if (isTerminal(video)) return invalid(video, event);

  switch (event._tag) {
    case "Uploaded":
      return status._tag === "Uploading"
        ? with_(video, { status: VideoStatus.cases.Encoding.make({ uploadedAt: now }) })
        : invalid(video, event);

    case "Encoded":
      // Le webhook « prête » peut arriver avant la fin d'upload côté client.
      return status._tag === "Uploading" || status._tag === "Encoding"
        ? with_(video, {
            status: VideoStatus.cases.Ready.make({ readyAt: now, duration: event.duration }),
          })
        : invalid(video, event);

    case "EncodingFailed":
      return status._tag === "Uploading" || status._tag === "Encoding"
        ? with_(video, {
            status: VideoStatus.cases.Failed.make({ failedAt: now, reason: event.reason }),
          })
        : invalid(video, event);

    case "Rename":
      return with_(video, { title: event.title });

    case "SetThumbnail": {
      if (status._tag !== "Ready") return Result.fail(new VideoNotReady({ status: status._tag }));
      const thumbnail = event.thumbnail;
      if (thumbnail._tag === "Frame" && thumbnail.time > status.duration) {
        return Result.fail(new OutOfRange({ time: thumbnail.time, duration: status.duration }));
      }
      return with_(video, { thumbnail });
    }

    case "SetExpiry":
      return with_(video, { expiry: event.expiry });

    case "Expire":
      return with_(video, { status: VideoStatus.cases.Expired.make({ expiredAt: now }) });

    case "Delete":
      return with_(video, { status: VideoStatus.cases.Deleted.make({ deletedAt: now }) });
  }
};

/** Un commentaire doit viser une vidéo lisible, à une position qui existe. */
export const canCommentAt = (video: Video, time: number): Result.Result<void, VideoError> => {
  const status = video.status;
  if (status._tag !== "Ready") return Result.fail(new VideoNotReady({ status: status._tag }));
  if (time > status.duration)
    return Result.fail(new OutOfRange({ time, duration: status.duration }));
  return Result.void;
};
