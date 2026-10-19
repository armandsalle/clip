import { env } from "cloudflare:workers";

// clip-web : la SPA en static assets ; l'API, le temps réel (WebSocket) et le faux
// Stream local partent vers clip-api par service binding. Aucune logique métier ici.
export default {
  fetch: (request) => env.API.fetch(request),
} satisfies ExportedHandler<Env>;
