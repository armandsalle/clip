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

export const useLive = (
  videoId: string,
  name: string,
  onEvent: (event: LiveEvent) => void,
): Live => {
  const [connected, setConnected] = useState(false);
  const [viewers, setViewers] = useState<ReadonlyArray<Viewer>>([]);
  const [events, setEvents] = useState<ReadonlyArray<Received>>([]);
  const socket = useRef<WebSocket | null>(null);
  const lastTime = useRef(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const open = () => {
      const url = new URL(`/api/videos/${videoId}/live`, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("name", name);
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (message) => {
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
        if (closed) return;
        // Reconnexion avec backoff : la room hiberne, elle accepte toujours.
        retry = setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };

    open();
    // Battement : la room écarte les sockets muets depuis 30 s (onglets fermés sans close).
    const heartbeat = setInterval(() => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "time", time: lastTime.current }));
      }
    }, 10_000);
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      const ws = socket.current;
      // Fermer pendant la connexion laisserait un socket fantôme côté serveur.
      if (ws?.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
      else ws?.close();
    };
  }, [videoId, name]);

  const lastSent = useRef(0);
  const sendTime = (time: number) => {
    lastTime.current = time;
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastSent.current < 1000) return;
    lastSent.current = now;
    ws.send(JSON.stringify({ type: "time", time }));
  };

  return { connected, viewers, events, sendTime };
};
