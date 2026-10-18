import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { LiveEvent } from "@clip/contract";

interface Viewer {
  readonly id: string;
  readonly name: string;
  readonly time: number;
  /** Dernier message reçu (ms). */
  readonly seen: number;
}

/**
 * Sans message ni ping depuis ce délai, un spectateur sort de la présence (onglet
 * fermé sans close). Le socket n'est pas fermé : le navigateur s'en charge.
 */
const STALE_MS = 2 * 60_000;
/** Présence diffusée au plus une fois par seconde, quel que soit le nombre de spectateurs. */
const PRESENCE_DEBOUNCE_MS = 1000;

const ClientMessage = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("time"), time: Schema.Finite }),
);
const decodeClient = Schema.decodeUnknownOption(ClientMessage);
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(LiveEvent));

/**
 * Une room par vidéo : WebSockets hibernables, diffusion des événements du pipeline
 * et des commentaires, présence (qui regarde, à quel moment de la vidéo).
 *
 * Pour que la room hiberne vraiment : les pings du client reçoivent leur pong sans
 * réveiller l'objet (`setWebSocketAutoResponse`), et la présence est regroupée par
 * une alarme plutôt que diffusée à chaque message.
 */
export class VideoRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

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
      await this.schedulePresence();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname === "/publish") {
      this.broadcast(await request.text());
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const parsed = decodeClient(message);
    if (parsed._tag === "None") return;
    const viewer = ws.deserializeAttachment() as Viewer;
    ws.serializeAttachment({ ...viewer, time: parsed.value.time, seen: Date.now() });
    await this.schedulePresence();
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Répondre au close termine la poignée de main (1005/1006 ne peuvent pas être renvoyés).
    ws.close(code === 1005 || code === 1006 ? 1000 : code);
    await this.schedulePresence();
  }

  override async webSocketError(): Promise<void> {
    await this.schedulePresence();
  }

  override alarm(): void {
    const now = Date.now();
    const viewers: Array<Omit<Viewer, "seen">> = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const { seen, ...viewer } = ws.deserializeAttachment() as Viewer;
      // Les pings répondus automatiquement comptent comme signe de vie.
      const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      if (now - Math.max(seen, ping) > STALE_MS) continue;
      viewers.push(viewer);
    }
    this.broadcast(encodeEvent({ _tag: "Presence", viewers }));
  }

  private async schedulePresence(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PRESENCE_DEBOUNCE_MS);
    }
  }

  private broadcast(body: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(body);
      } catch {
        // socket déjà fermé côté client : ignoré
      }
    }
  }
}
