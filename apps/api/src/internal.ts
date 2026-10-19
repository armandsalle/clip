import { Effect, Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { InternalRpcs } from "@clip/contract/internal";
import { INTERNAL_RPC_PATH, Live } from "@clip/platform";
import { Videos } from "./Videos.ts";

// RPC interne (jobs → api), servie par l'entrypoint `Internal` : jamais exposée
// publiquement, seul un service binding y accède.

export const InternalHandlers = InternalRpcs.toLayer(
  Effect.gen(function* () {
    const videos = yield* Videos;
    const live = yield* Live;
    return {
      ApplyVideoEvent: ({ videoId, event }) => videos.apply(videoId, [event]),
      SuggestTitle: ({ videoId, title }) => videos.suggestTitle(videoId, title),
      AddEmailReply: (input) => videos.addEmailReply(input),
      Publish: ({ videoId, event }) => live.publish(videoId, event),
    };
  }),
);

export const InternalRoutes = RpcServer.layerHttp({
  group: InternalRpcs,
  path: INTERNAL_RPC_PATH,
  protocol: "http",
}).pipe(Layer.provide([InternalHandlers, RpcSerialization.layerJson]));
