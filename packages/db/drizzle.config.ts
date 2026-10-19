import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "@clip/config";

// Connexion directe (non poolée) : les migrations et Hyperdrive gèrent eux-mêmes leurs
// connexions. Base de dev lue dans .env.local ; en CI, DATABASE_URL_UNPOOLED de la
// branche Neon visée (pr-<n> ou production). La branche « production » d'un .env.local
// est refusée (CLIP_ALLOW_PRODUCTION_DB=1 pour l'accepter, en connaissance de cause).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: databaseUrl(false) ?? "" },
});
