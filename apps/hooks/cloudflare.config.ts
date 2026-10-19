import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { hooksWorker } from "./worker.ts";

export default defineConfig(({ mode }) => ({ worker: { ...hooksWorker(mode), entrypoint } }));
