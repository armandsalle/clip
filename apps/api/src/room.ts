import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { LiveEvent } from "@clip/contract";

interface Viewer {
  readonly id: string;
  readonly name: string;
  readonly time: number;
  /** Dernier signe de vie (ms). Le client envoie sa position au moins toutes les 10 s. */
  readonly seen: number;
}

/** Au-delà, un socket est considéré comme abandonné (onglet fermé sans close). */
const STALE_MS = 30_000;

const ClientMessage = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("time"), time: Schema.Finite }),
);
const decodeClient = Schema.decodeUnknownOption(ClientMessage);
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(LiveEvent));

/**
 * Une room par vidéo : WebSockets hibernables (la room ne coûte rien entre deux
 * messages), diffusion des événements du pipeline et des commentaires, et présence
 * (qui regarde, à quel moment de la vidéo).
 */
export class VideoRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      const viewer: Viewer = {
        id: crypto.randomUUID(),
        name: url.searchParams.get("name")?.slice(0, 60) || "Anonyme",
        time: 0,
        seen: Date.now(),
      };
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(viewer);
      this.broadcastPresence();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname === "/publish") {
      this.broadcast(await request.text());
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    const parsed = decodeClient(message);
    if (parsed._tag === "None") return;
    const viewer = ws.deserializeAttachment() as Viewer;
    ws.serializeAttachment({ ...viewer, time: parsed.value.time, seen: Date.now() });
    this.broadcastPresence();
  }

  override webSocketClose(ws: WebSocket): void {
    ws.close();
    this.broadcastPresence(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.broadcastPresence(ws);
  }

  private broadcast(body: string, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(body);
      } catch {
        // socket déjà fermé côté client : il sera écarté au prochain passage
      }
    }
  }

  private broadcastPresence(leaving?: WebSocket): void {
    const now = Date.now();
    const viewers: Array<Omit<Viewer, "seen">> = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === leaving) continue;
      const { seen, ...viewer } = ws.deserializeAttachment() as Viewer;
      if (now - seen > STALE_MS) {
        ws.close(1001, "inactif");
        continue;
      }
      viewers.push(viewer);
    }
    this.broadcast(encodeEvent({ _tag: "Presence", viewers }), leaving);
  }
}
