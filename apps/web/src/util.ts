import { useEffect, useState } from "react";

// Navigation --------------------------------------------------------------------

export type Route =
  | { readonly page: "home" }
  | { readonly page: "video"; readonly id: string }
  | { readonly page: "coulisses"; readonly id: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const parseRoute = (path: string): Route => {
  const coulisses = new RegExp(`^/v/(${UUID})/coulisses/?$`).exec(path);
  if (coulisses) return { page: "coulisses", id: coulisses[1]! };
  const video = new RegExp(`^/v/(${UUID})/?$`).exec(path);
  if (video) return { page: "video", id: video[1]! };
  return { page: "home" };
};

export const navigate = (to: string) => {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
};

export const useRoute = (): Route => {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.pathname));
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return route;
};

// Stockage local (tolérant : navigation privée, stockage bloqué) ------------------

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // stockage indisponible : la valeur reste en mémoire pour cette page
  }
};

/**
 * Secret d'admin d'une vidéo : lu dans `?k=` (lien d'admin), mémorisé localement,
 * puis retiré de la barre d'adresse pour ne pas le partager par erreur.
 */
export const adminKeyFor = (videoId: string): string | null => {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("k");
  if (fromUrl) {
    write(`clip.admin.${videoId}`, fromUrl);
    url.searchParams.delete("k");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return read(`clip.admin.${videoId}`);
};

export const rememberAdminKey = (videoId: string, key: string) =>
  write(`clip.admin.${videoId}`, key);

export const viewerName = (): string | null => read("clip.name");
export const rememberViewerName = (name: string) => write("clip.name", name);

// Formats -------------------------------------------------------------------------

/** 75.4 → « 1:15 » */
export const formatTime = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1e9)
    return `${(bytes / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Go`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1e3))} ko`;
};

const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

/** « à l'instant », « il y a 3 min », « hier »… */
export const formatAgo = (date: Date, now = Date.now()): string => {
  const diff = (date.getTime() - now) / 1000;
  if (Math.abs(diff) < 45) return "à l'instant";
  if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (Math.abs(diff) < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
};

/** Couleur de présence stable pour un nom ou un identifiant. */
export const presenceColor = (seed: string): string => {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `var(--clip-presence-${(Math.abs(hash) % 4) + 1})`;
};

export const copy = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
