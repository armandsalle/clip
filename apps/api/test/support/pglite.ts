import { Effect, Layer } from "effect";
import { PgliteClient } from "@effect/sql-pglite";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { migrate } from "drizzle-orm/effect-pglite/migrator";
import { fileURLToPath } from "node:url";
import { Db } from "../../src/db/Db.ts";

// Vrai Postgres (PGlite, en mémoire) avec les migrations Drizzle appliquées :
// le SQL généré par le dépôt est exécuté pour de bon, sans Docker.
const migrationsFolder = fileURLToPath(new URL("../../migrations", import.meta.url).href);

export const DbPglite = Layer.effect(
  Db,
  Effect.gen(function* () {
    const db = yield* PgliteDrizzle.makeWithDefaults();
    yield* migrate(db, { migrationsFolder });
    return db;
  }),
).pipe(Layer.provide(PgliteClient.layer()), Layer.orDie);
