import { Context, Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";

// Base Drizzle (API Effect de Drizzle v1). Le driver est fourni par la Layer :
// Postgres via Hyperdrive en prod, PGlite (vrai Postgres en WASM) en test.

export type Database = PgDrizzle.EffectPgDatabase;

export class Db extends Context.Service<Db, Database>()("@clip/db/Db") {
  static readonly layerPg = Layer.effect(Db, PgDrizzle.makeWithDefaults());

  /**
   * Postgres via Hyperdrive. `connectionString` ne se lit que dans un handler
   * (Hyperdrive la génère à la demande) : la Layer est construite à l'usage, jamais
   * au chargement du module (erreur 10021 au déploiement sinon).
   */
  static readonly layerHyperdrive = (hyperdrive: Hyperdrive) =>
    Db.layerPg.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.sync(() => PgClient.layer({ url: Redacted.make(hyperdrive.connectionString) })),
        ),
      ),
    );
}
