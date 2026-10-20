// Reconstruit une base depuis les migrations : `node scripts/rebuild.ts` (lancé par
// `scripts/env.ts` sur la branche Neon `staging`, juste après sa création).
//
// Le staging est une branche Neon « schéma seul » : elle a les tables de la production,
// mais aucune ligne, pas même le journal des migrations de Drizzle. Drizzle croirait
// alors n'avoir rien appliqué et recréerait des tables existantes. On repart donc d'une
// base vide, migrations rejouées depuis la première : elles sont vérifiées au passage.
//
// Destructif : refuse la base de production (`databaseUrl` l'écarte hors prod, et
// CLIP_ALLOW_PRODUCTION_DB=1 est refusé ici).
import { fileURLToPath } from "node:url";
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { databaseUrl } from "@clip/config";
import { Db } from "../src/Db.ts";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url).href);

const exit = (message: string): never => {
  console.error(message);
  // workers-types redéclare `process.exit` sans `never`.
  return process.exit(1) as never;
};

if (process.env.CLIP_ALLOW_PRODUCTION_DB === "1") {
  exit("rebuild est refusé avec CLIP_ALLOW_PRODUCTION_DB=1.");
}
const url = databaseUrl(false) ?? exit("DATABASE_URL manquant (branche Neon à reconstruire).");

const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  // Schéma de l'app et journal des migrations de Drizzle (schéma `drizzle`).
  yield* sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  yield* sql`DROP SCHEMA IF EXISTS public CASCADE`;
  yield* sql`CREATE SCHEMA public`;
  console.log("Base vidée (schémas public et drizzle).");
  yield* migrate(yield* Db, { migrationsFolder });
  console.log("Migrations rejouées depuis la première.");
});

const PgLive = PgClient.layer({ url: Redacted.make(url) });

await Effect.runPromise(
  program.pipe(Effect.provide(Db.layerPg.pipe(Layer.provideMerge(PgLive))), Effect.scoped),
);
