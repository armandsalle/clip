import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { apiWorker } from "./worker.ts";

export default defineConfig(({ mode }) => ({ worker: { ...apiWorker(mode), entrypoint } }));
