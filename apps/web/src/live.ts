import { useEffect, useRef, useState } from "react";
import { Option, Schema } from "effect";
import { LiveEvent } from "@clip/contract";

// Temps réel : un WebSocket par page vidéo vers le Durable Object de la vidéo. Les
// messages sont décodés avec le Schema du contrat ; un message invalide est ignoré.

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(LiveEvent));

export type Viewer = { readonly id: string; readonly name: string; readonly time: number };

export interface Received {
  readonly event: LiveEvent;
  readonly receivedAt: Date;
}

export interface Live {
  readonly connected: boolean;
  readonly viewers: ReadonlyArray<Viewer>;
  /** Derniers événements reçus, du plus récent au plus ancien. */
  readonly events: ReadonlyArray<Received>;
  /** Signale la position de lecture courante aux autres spectateurs. */
  readonly sendTime: (time: number) => void;
}

const MAX_EVENTS = 200;
/** Ping applicatif : la room y répond sans se réveiller (auto-réponse hibernable). */
const PING_MS = 45_000;
/** Position partagée au plus toutes les 5 s : la présence n'a pas besoin de plus. */
const TIME_EVERY_MS = 5_000;
/** Une connexion tenue ce temps-là remet le backoff de reconnexion à zéro. */
const STABLE_MS = 10_000;

export const useLive = (
  videoId: string,
  name: string,
  onEvent: (event: LiveEvent) => void,
  /** Pas de connexion pour une vidéo introuvable, expirée ou supprimée. */
  enabled = true,
): Live => {
  const [connected, setConnected] = useState(false);
  const [viewers, setViewers] = useState<ReadonlyArray<Viewer>>([]);
  const [events, setEvents] = useState<ReadonlyArray<Received>>([]);
  const socket = useRef<WebSocket | null>(null);
  const lastTime = useRef(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stable: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const open = () => {
      const url = new URL(`/api/videos/${videoId}/live`, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("name", name);
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        setConnected(true);
        // Le compteur ne repart à zéro qu'après une connexion stable (pas de boucle
        // de reconnexion rapide si la room ferme aussitôt).
        stable = setTimeout(() => (attempt = 0), STABLE_MS);
        // Position courante tout de suite, pour apparaître dans la présence.
        ws.send(JSON.stringify({ type: "time", time: lastTime.current }));
      };
      ws.onmessage = (message) => {
        if (message.data === "pong") return;
        const event = decode(message.data);
        if (Option.isNone(event)) return;
        if (event.value._tag === "Presence") setViewers(event.value.viewers);
        setEvents((list) =>
          [{ event: event.value, receivedAt: new Date() }, ...list].slice(0, MAX_EVENTS),
        );
        handler.current(event.value);
      };
      ws.onclose = () => {
        setConnected(false);
        clearTimeout(stable);
        if (closed) return;
        // Reconnexion avec backoff et jitter : tous les onglets ne reviennent pas ensemble.
        const delay = Math.min(30_000, 1000 * 2 ** attempt++);
        retry = setTimeout(open, delay / 2 + Math.random() * (delay / 2));
      };
    };

    open();
    // Signe de vie peu coûteux : sans lui, un spectateur sort de la présence au bout de 2 min.
    const heartbeat = setInterval(() => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
    }, PING_MS);
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(stable);
      clearInterval(heartbeat);
      const ws = socket.current;
      // Fermer pendant la connexion laisserait un socket fantôme côté serveur.
      if (ws?.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
      else ws?.close();
    };
  }, [videoId, name, enabled]);

  const lastSent = useRef(0);
  const sendTime = (time: number) => {
    lastTime.current = time;
    const ws = socket.current;
    // Appelé pendant la lecture seulement (timeupdate) ; rien quand l'onglet est caché.
    if (!ws || ws.readyState !== WebSocket.OPEN || document.hidden) return;
    const now = Date.now();
    if (now - lastSent.current < TIME_EVERY_MS) return;
    lastSent.current = now;
    ws.send(JSON.stringify({ type: "time", time }));
  };

  return { connected, viewers, events, sendTime };
};
