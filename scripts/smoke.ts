import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test de fumée d'un environnement déployé : `vp run smoke <url>`.
//
// Parcours complet à travers les trois Workers : front servi, dépôt tus d'une vidéo,
// pipeline jusqu'à la transcription (clip-jobs, Workflow, RPC vers clip-api),
// commentaire, suppression. Vrai Stream et vraie IA en PR, faux en dev local.
const base = (process.argv[2] ?? process.env.CLIP_URL ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Usage : node scripts/smoke.ts <url>   (ex. https://pr-12.clipshare.dev)");
  process.exit(1);
}

const check = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
  console.log(`✓ ${message}`);
};

const json = async <A>(path: string, init?: RequestInit): Promise<A> => {
  const response = await fetch(`${base}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} : HTTP ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as A;
};

interface View {
  readonly video: { readonly id: string; readonly status: { readonly _tag: string } };
  readonly enrichments: Record<string, { readonly _tag: string }>;
  readonly transcript: ReadonlyArray<unknown>;
}

const started = Date.now();

const health = await json<{ ok: boolean }>("/api/health");
check(health.ok, "clip-api répond via clip-web (/api/health)");

const page = await fetch(`${base}/`);
check(
  page.ok && (page.headers.get("content-type") ?? "").includes("text/html"),
  "le front est servi (/)",
);

await json<{ items: ReadonlyArray<unknown> }>("/api/videos");
check(true, "la galerie se lit (/api/videos)");

// Un vrai MP4 (mire + tonalité, 10 s) : le vrai Stream l'encode ; sans ffmpeg, des
// octets quelconques suffisent au faux Stream.
const sample = (): Uint8Array => {
  const file = join(tmpdir(), "clip-smoke.mp4");
  try {
    execFileSync("ffmpeg", [
      ...["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=10"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:duration=10"],
      ...["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", file],
    ]);
    return readFileSync(file);
  } catch {
    return new Uint8Array(256 * 1024);
  }
};
const bytes = sample();
const created = await json<{
  video: { id: string };
  uploadUrl: string;
  uploadProtocol: string;
  adminKey: string;
}>("/api/videos", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "smoke@example.com", expiry: "1d", size: bytes.byteLength }),
});
// URL relative : faux Stream (dev local) ; absolue : Cloudflare Stream (PR, production).
const real = !created.uploadUrl.startsWith("/");
check(
  created.uploadProtocol === "tus",
  `vidéo créée (${real ? "Cloudflare Stream" : "faux Stream"}, tus)`,
);
const id = created.video.id;

// Comme tus-js-client : où en est le dépôt (HEAD), puis le fichier (PATCH).
const uploadUrl = new URL(created.uploadUrl, base);
const head = await fetch(uploadUrl, { method: "HEAD", headers: { "tus-resumable": "1.0.0" } });
check(head.ok && head.headers.get("upload-offset") === "0", "dépôt tus ouvert (offset 0)");
const patch = await fetch(uploadUrl, {
  method: "PATCH",
  headers: {
    "tus-resumable": "1.0.0",
    "upload-offset": "0",
    "content-type": "application/offset+octet-stream",
    "x-clip-duration": "10",
  },
  body: bytes,
});
check(
  patch.status === 204 && patch.headers.get("upload-offset") === String(bytes.byteLength),
  `fichier envoyé (${Math.round(bytes.byteLength / 1024)} Kio)`,
);

// Pipeline : Ready (webhook relayé par clip-hooks, ou sondage), puis transcription.
// Avec la vraie IA, une tonalité ne contient aucune parole : seule la fin de l'étape compte.
const settled = (tag: string | undefined) => tag === "Done" || tag === "Failed";
let view: View | null = null;
const deadline = Date.now() + (real ? 300_000 : 120_000);
while (Date.now() < deadline) {
  view = await json<View>(`/api/videos/${id}`);
  if (view.video.status._tag === "Ready" && settled(view.enrichments["transcript"]?._tag)) break;
  if (view.video.status._tag === "Failed") break;
  await new Promise((r) => setTimeout(r, 3000));
}
check(view?.video.status._tag === "Ready", "vidéo prête (Workflow clip-pipeline)");
check(
  real
    ? settled(view?.enrichments["transcript"]?._tag)
    : view?.enrichments["transcript"]?._tag === "Done" && view.transcript.length > 0,
  `transcription terminée : ${view?.enrichments["transcript"]?._tag} (clip-jobs → RPC clip-api)`,
);

await json(`/api/videos/${id}/comments`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ author: "Fumée", body: "Test de fumée", time: 1, parentId: null }),
});
const comments = await json<ReadonlyArray<unknown>>(`/api/videos/${id}/comments`);
check(comments.length === 1, "commentaire publié et relu");

const removed = await json<{ status: { _tag: string } }>(`/api/videos/${id}`, {
  method: "DELETE",
  headers: { "x-clip-admin": created.adminKey },
});
check(removed.status._tag === "Deleted", "vidéo supprimée avec le secret d'admin");

console.log(`\nTest de fumée vert en ${Math.round((Date.now() - started) / 1000)} s : ${base}`);
