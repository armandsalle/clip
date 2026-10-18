import { Context, Layer } from "effect";
import * as PgDrizzle from "drizzle-orm/effect-postgres";

// Base Drizzle (API Effect de Drizzle v1). Le driver est fourni par la Layer :
// Postgres via Hyperdrive en prod, PGlite (vrai Postgres en WASM) en test.

export type Database = PgDrizzle.EffectPgDatabase;

export class Db extends Context.Service<Db, Database>()("@clip/api/Db") {
  static readonly layerPg = Layer.effect(Db, PgDrizzle.makeWithDefaults());
}
