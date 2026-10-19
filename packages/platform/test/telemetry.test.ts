import { createServer, type IncomingMessage } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { flushTelemetry, telemetryLayer } from "../src/Telemetry.ts";

/** Récepteur OTLP minimal : garde le chemin, l'en-tête d'auth et le corps JSON. */
const receiver = async () => {
  const received: Array<{ path: string; auth: string | undefined; body: string }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { received, host: `http://127.0.0.1:${port}`, close: () => server.close() };
};

describe("telemetryLayer", () => {
  it.effect("sans cible : rien n'est exporté, flush ne fait rien", () =>
    Effect.gen(function* () {
      yield* Effect.log("ignoré").pipe(Effect.withSpan("ignoré"));
      yield* flushTelemetry;
    }).pipe(Effect.provide(telemetryLayer({ service: "test", environment: "test", target: null }))),
  );

  it.live("PostHog : spans et logs partent au flush, avec le token du projet", () =>
    Effect.gen(function* () {
      const sink = yield* Effect.promise(receiver);
      yield* Effect.gen(function* () {
        yield* Effect.logInfo("commentaire publié").pipe(Effect.withSpan("Videos.comment"));
        yield* flushTelemetry;
      }).pipe(
        Effect.provide(
          telemetryLayer({
            service: "clip-api",
            environment: "test",
            target: { kind: "posthog", host: sink.host, token: async () => "phc_test" },
          }),
        ),
      );
      sink.close();
      const traces = sink.received.find((r) => r.path === "/i/v1/traces");
      const logs = sink.received.find((r) => r.path === "/i/v1/logs");
      assert.strictEqual(traces?.auth, "Bearer phc_test");
      assert.include(traces?.body ?? "", "Videos.comment");
      assert.include(traces?.body ?? "", "clip-api");
      assert.include(logs?.body ?? "", "commentaire publié");
    }),
  );
});
