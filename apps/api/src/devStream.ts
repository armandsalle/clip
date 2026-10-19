// Faux Stream (dev local et environnements de PR, sans compte Stream) : sert les
// fichiers déposés dans R2 et reçoit les dépôts en tus, comme le vrai Stream.
//
// tus plutôt qu'un PUT unique : derrière clipshare.dev, Cloudflare refuse tout corps de
// requête de plus de 100 Mo (413). Le front envoie des morceaux de 50 Mo, chacun devient
// une partie d'un upload multipart R2 ; l'état (offset, parties) est rangé à côté du
// fichier, ce qui rend l'envoi reprenable comme chez Stream.
//
// Le PUT d'un fichier entier reste accepté (seed, petits fichiers).

/** État d'un dépôt tus en cours, écrit à la création par `StreamVideos.layerFake`. */
export interface DevUpload {
  readonly length: number;
  readonly offset: number;
  readonly uploadId?: string;
  readonly parts?: ReadonlyArray<R2UploadedPart>;
  readonly duration?: string;
}

export const devUploadKey = (uid: string) => `dev-stream/${uid}.tus`;

const tusHeaders = (offset: number, length: number) => ({
  "tus-resumable": "1.0.0",
  "upload-offset": String(offset),
  "upload-length": String(length),
  "cache-control": "no-store",
});

export async function devStream(
  request: Request,
  uid: string,
  thumbnail: boolean,
  media: R2Bucket,
  /** Le dépôt a été créé par l'API et la vidéo attend encore son fichier. */
  accepting: () => Promise<boolean>,
): Promise<Response> {
  const key = `dev-stream/${uid}`;
  if (thumbnail) {
    return new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="100%" height="100%" fill="#1d1d22"/><text x="50%" y="50%" fill="#8b8b94" font-family="monospace" font-size="20" text-anchor="middle">${uid.slice(0, 12)}</text></svg>`,
      { headers: { "content-type": "image/svg+xml", "x-content-type-options": "nosniff" } },
    );
  }

  // tus : où en est le dépôt ?
  if (request.method === "HEAD") {
    const state = await media.get(devUploadKey(uid));
    if (state) {
      const upload = await state.json<DevUpload>();
      return new Response(null, { status: 200, headers: tusHeaders(upload.offset, upload.length) });
    }
    const done = await media.head(key);
    return done
      ? new Response(null, { status: 200, headers: tusHeaders(done.size, done.size) })
      : new Response(null, { status: 404 });
  }

  // Écriture seulement pour un dépôt créé par l'API et encore en cours : le faux Stream
  // (dev local, environnements de PR) n'héberge pas de fichiers arbitraires.
  if (request.method === "PATCH" || request.method === "PUT" || request.method === "POST") {
    if (!(await accepting())) return new Response("upload inconnu", { status: 404 });
  }

  // tus : un morceau, à la suite du précédent.
  if (request.method === "PATCH") {
    const state = await media.get(devUploadKey(uid));
    if (!state || !request.body) return new Response("upload inconnu", { status: 404 });
    const upload = await state.json<DevUpload>();
    const size = Number(request.headers.get("content-length"));
    if (Number(request.headers.get("upload-offset")) !== upload.offset || !(size > 0)) {
      return new Response(null, { status: 409, headers: tusHeaders(upload.offset, upload.length) });
    }
    const multipart = upload.uploadId
      ? media.resumeMultipartUpload(key, upload.uploadId)
      : await media.createMultipartUpload(key, {
          // Type imposé : jamais celui du client (sinon du HTML servi depuis clipshare.dev).
          httpMetadata: { contentType: "video/mp4" },
          customMetadata: { duration: request.headers.get("x-clip-duration") ?? "60" },
        });
    const part = await multipart.uploadPart((upload.parts?.length ?? 0) + 1, request.body);
    const next: DevUpload = {
      ...upload,
      uploadId: multipart.uploadId,
      offset: upload.offset + size,
      parts: [...(upload.parts ?? []), part],
    };
    if (next.offset >= next.length) {
      await multipart.complete([...(next.parts ?? [])]);
      await media.delete(devUploadKey(uid));
    } else {
      await media.put(devUploadKey(uid), JSON.stringify(next));
    }
    return new Response(null, { status: 204, headers: tusHeaders(next.offset, next.length) });
  }

  // tus : abandon (bouton « Annuler »).
  if (request.method === "DELETE") {
    const state = await media.get(devUploadKey(uid));
    if (state) {
      const upload = await state.json<DevUpload>();
      if (upload.uploadId) await media.resumeMultipartUpload(key, upload.uploadId).abort();
      await media.delete(devUploadKey(uid));
    }
    return new Response(null, { status: 204, headers: { "tus-resumable": "1.0.0" } });
  }

  // Fichier entier en une requête (seed, petits fichiers).
  if (request.method === "PUT" || request.method === "POST") {
    await media.put(key, request.body, {
      httpMetadata: { contentType: "video/mp4" },
      customMetadata: { duration: request.headers.get("x-clip-duration") ?? "60" },
    });
    await media.delete(devUploadKey(uid));
    return new Response(null, { status: 201 });
  }

  const object = await media.get(key, { range: request.headers });
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers({
    "accept-ranges": "bytes",
    "content-type": "video/mp4",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  if (object.range && "offset" in object.range) {
    const { offset = 0, length = object.size - offset } = object.range;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
}
