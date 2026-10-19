import { Context, Layer } from "effect";

/** Interrupteurs à chaud (Flagship en prod, variables en local). */
export class Features extends Context.Service<
  Features,
  { readonly ai: boolean; readonly storyboard: boolean; readonly chaos: number }
>()("@clip/platform/Features") {
  static readonly layer = (features: { ai: boolean; storyboard: boolean; chaos: number }) =>
    Layer.succeed(Features, Features.of(features));
}
