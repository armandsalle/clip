import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { jobsWorker, storyboard, withContainers } from "./worker.ts";

export default defineConfig(({ mode }) => ({
  containers: withContainers ? [storyboard] : [],
  worker: { ...jobsWorker(mode), entrypoint },
}));
