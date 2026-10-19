import { Option, Schema } from "effect";
import { VideoId } from "@clip/domain";
import { UploadProtocol } from "@clip/contract";
import { local } from "../util.ts";

// Envoi en cours, mémorisé dans ce navigateur : après un rechargement, on propose de
// reprendre (l'URL tus suffit, le serveur sait où il en est).

const KEY = "clip:upload:pending";

export const PendingUpload = Schema.Struct({
  videoId: VideoId,
  adminKey: Schema.String,
  uploadUrl: Schema.String,
  protocol: UploadProtocol,
  name: Schema.String,
  size: Schema.Int,
  lastModified: Schema.Finite,
  loaded: Schema.Int,
  email: Schema.String,
});
export type PendingUpload = typeof PendingUpload.Type;

const codec = Schema.fromJsonString(PendingUpload);
const decode = Schema.decodeUnknownOption(codec);
const encode = Schema.encodeSync(codec);

export const readPending = (): PendingUpload | null => Option.getOrNull(decode(local.read(KEY)));

/** Sans stockage disponible, pas de reprise après rechargement : l'envoi continue. */
export const writePending = (pending: PendingUpload) => local.write(KEY, encode(pending));

export const clearPending = () => local.remove(KEY);

/** Le fichier choisi est bien celui de l'envoi interrompu. */
export const isSameFile = (pending: PendingUpload, file: File) =>
  pending.name === file.name &&
  pending.size === file.size &&
  pending.lastModified === file.lastModified;
