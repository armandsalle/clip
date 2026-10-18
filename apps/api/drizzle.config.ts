import { defineConfig } from "drizzle-kit";

// Connexion directe (non poolée) : les migrations et Hyperdrive gèrent eux-mêmes leurs
// connexions. Variables tirées par `neon deploy` / `neon env pull` dans .env.local.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "" },
});
