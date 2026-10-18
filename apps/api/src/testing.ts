import { Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { InternalRpcs } from "@clip/contract";
import { InternalApi } from "@clip/platform";
import { VideosHandlers } from "./http.ts";
import { InternalHandlers } from "./internal.ts";
import { Videos } from "./Videos.ts";

/**
 * api en mémoire pour les tests des autres Workers : l'API HTTP et un client RPC
 * interne branché sur les vrais handlers (même contrat, même logique d'écriture).
 * Les bindings (Store, Stream, Live…) viennent de `TestPlatform`.
 */
export const ApiTest = Layer.mergeAll(
  VideosHandlers,
  Layer.effect(InternalApi, RpcTest.makeClient(InternalRpcs)).pipe(Layer.provide(InternalHandlers)),
).pipe(Layer.provideMerge(Videos.layer));
