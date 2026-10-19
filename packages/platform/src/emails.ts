import type { Comment, Video } from "@clip/domain";

// Templates d'emails (fonctions pures) et extraction du texte d'une réponse.

export interface EmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const timecode = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const videoUrl = (domain: string, id: string, time?: number) =>
  `https://${domain}/v/${id}${time === undefined ? "" : `?t=${Math.floor(time)}`}`;

export const replyAddress = (domain: string, token: string) => `reply+${token}@${domain}`;

const layout = (title: string, body: string) => `<!doctype html>
<html lang="fr"><body style="margin:0;background:#0f0f12;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#e8e8ea">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
<div style="font-weight:600;font-size:15px;margin-bottom:24px">▶ Clip</div>
<h1 style="font-size:20px;margin:0 0 16px">${title}</h1>
${body}
<p style="color:#8b8b94;font-size:12px;margin-top:32px">Vous recevez cet email car vous avez déposé cette vidéo sur Clip.</p>
</div></body></html>`;

const button = (href: string, label: string) =>
  `<p><a href="${escape(href)}" style="display:inline-block;background:#e8e8ea;color:#0f0f12;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px">${escape(label)}</a></p>`;

/** « Votre vidéo est prête ». */
export const readyEmail = (
  domain: string,
  video: Video,
  summary: string | null,
  chapters: ReadonlyArray<{ readonly time: number; readonly title: string }>,
): EmailContent => {
  const title = video.title ?? "Votre vidéo";
  const url = videoUrl(domain, video.id);
  const chaptersHtml =
    chapters.length === 0
      ? ""
      : `<p style="color:#8b8b94;font-size:13px;margin-bottom:4px">Chapitres</p><ul style="padding-left:18px;margin-top:0">${chapters
          .map(
            (c) =>
              `<li><a href="${escape(videoUrl(domain, video.id, c.time))}" style="color:#7aa2f7">${timecode(c.time)}</a> ${escape(c.title)}</li>`,
          )
          .join("")}</ul>`;
  return {
    subject: `Votre vidéo est prête : ${title}`,
    html: layout(
      escape(title),
      `${summary ? `<p style="line-height:1.5">${escape(summary)}</p>` : ""}${chaptersHtml}${button(url, "Voir la vidéo")}`,
    ),
    text: [
      `Votre vidéo est prête : ${title}`,
      "",
      ...(summary ? [summary, ""] : []),
      ...chapters.map((c) => `${timecode(c.time)} ${c.title}`),
      ...(chapters.length ? [""] : []),
      `Voir la vidéo : ${url}`,
    ].join("\n"),
  };
};

/** Nouveaux commentaires (regroupés) ; chaque commentaire a son lien « Répondre ». */
export const commentsEmail = (
  domain: string,
  video: Video,
  items: ReadonlyArray<{ readonly comment: Comment; readonly replyToken: string | null }>,
): EmailContent => {
  const title = video.title ?? "votre vidéo";
  const n = items.length;
  const subject =
    n === 1
      ? `Nouveau commentaire sur « ${title} »`
      : `${n} nouveaux commentaires sur « ${title} »`;
  const rows = items
    .map(({ comment, replyToken }) => {
      const reply = replyToken
        ? ` · <a href="mailto:${replyAddress(domain, replyToken)}?subject=${encodeURIComponent(`Re: ${subject}`)}" style="color:#7aa2f7">Répondre</a>`
        : "";
      return `<div style="border-left:2px solid #2a2a30;padding:4px 0 4px 12px;margin:12px 0">
<div style="font-size:13px;color:#8b8b94"><strong style="color:#e8e8ea">${escape(comment.author)}</strong> à <a href="${escape(videoUrl(domain, video.id, comment.time))}" style="color:#7aa2f7">${timecode(comment.time)}</a>${reply}</div>
<div style="margin-top:4px;line-height:1.5">${escape(comment.body)}</div></div>`;
    })
    .join("");
  return {
    subject,
    html: layout(
      escape(subject),
      `${rows}<p style="color:#8b8b94;font-size:13px">Répondez à cet email pour répondre au dernier commentaire : votre réponse sera publiée sous le commentaire.</p>${button(videoUrl(domain, video.id), "Ouvrir la vidéo")}`,
    ),
    text: [
      subject,
      "",
      ...items.map(
        ({ comment }) => `${comment.author} à ${timecode(comment.time)} : ${comment.body}`,
      ),
      "",
      "Répondez à cet email pour répondre au dernier commentaire.",
      videoUrl(domain, video.id),
    ].join("\n"),
  };
};

/**
 * Texte utile d'une réponse : s'arrête à la citation (« > »), à l'en-tête de
 * citation (« Le … a écrit : », « On … wrote: ») ou à la signature (« -- »).
 */
export const extractReplyText = (raw: string): string | null => {
  const kept: Array<string> = [];
  for (const line of raw.replaceAll("\r\n", "\n").split("\n")) {
    const t = line.trim();
    if (t.startsWith(">")) break;
    if (/^(le|on)\b.*(a écrit|wrote)\s*:?$/i.test(t)) break;
    if (t === "--" || line.startsWith("-- ")) break;
    if (/^-{2,}\s*(original message|message d'origine)/i.test(t)) break;
    kept.push(line);
  }
  const text = kept.join("\n").trim();
  return text.length === 0 ? null : text.slice(0, 2000);
};

/** Jeton d'une adresse `reply+<jeton>@domaine`. */
export const tokenFromAddress = (address: string): string | null =>
  /^reply\+([a-z2-7]{16,})@/i.exec(address.trim())?.[1]?.toLowerCase() ?? null;
