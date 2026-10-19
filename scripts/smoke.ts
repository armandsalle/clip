// Test de fumée d'un environnement déployé : `vp run smoke <url>`.
//
// Parcours complet à travers les trois Workers, avec le faux Stream et l'IA factice
// (environnement de PR ou dev local) : front servi, dépôt d'une vidéo, pipeline jusqu'à
// la transcription (clip-jobs, Workflow, RPC vers clip-api), commentaire, suppression.
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

const bytes = new Uint8Array(64 * 1024);
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
check(created.uploadProtocol === "put", "vidéo créée (faux Stream)");
const id = created.video.id;

const upload = await fetch(new URL(created.uploadUrl, base), {
  method: "PUT",
  headers: { "content-type": "video/mp4", "x-clip-duration": "30" },
  body: bytes,
});
check(upload.ok, "fichier envoyé au faux Stream");

// Pipeline : Ready (sondage de l'encodage), puis transcription par l'IA factice.
let view: View | null = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  view = await json<View>(`/api/videos/${id}`);
  if (view.video.status._tag === "Ready" && view.enrichments["transcript"]?._tag === "Done") break;
  if (view.video.status._tag === "Failed") break;
  await new Promise((r) => setTimeout(r, 2000));
}
check(view?.video.status._tag === "Ready", "vidéo prête (Workflow clip-pipeline)");
check(
  view?.enrichments["transcript"]?._tag === "Done" && view.transcript.length > 0,
  "transcription enregistrée (clip-jobs → RPC clip-api)",
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

export {};
