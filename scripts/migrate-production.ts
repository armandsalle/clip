// Migrations de la base de production : `vp run db:migrate:production` (CI, sur main,
// avant le déploiement). L'URL de la branche Neon `production` est demandée à l'API
// Neon (`neonctl`, NEON_API_KEY en CI) : aucune URL de prod n'est stockée dans le dépôt ni dans un .env.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectionUri, findBranch } from "./neon.ts";

const branch = await findBranch("production");
if (branch === null) throw new Error("branche Neon « production » introuvable");
const db = await connectionUri(branch);

execFileSync("vp", ["exec", "drizzle-kit", "migrate"], {
  cwd: fileURLToPath(new URL("../packages/db", import.meta.url).href),
  env: {
    ...process.env,
    DATABASE_URL: db.href,
    DATABASE_URL_UNPOOLED: db.href,
    // Ce script vise la production exprès (la garde de packages/config l'écarterait sinon).
    CLIP_ALLOW_PRODUCTION_DB: "1",
    NEON_BRANCH: "production",
  },
  stdio: "inherit",
});
