// Drizzle 1.0 RC (rc.5-5935859) référence encore le chemin des bêtas d'Effect 4
// dans ses .d.ts. Sans ce pont, `SqlError` devient `any` dans le canal d'erreur.
// À supprimer quand Drizzle publiera des types alignés sur Effect 4.0 stable.
declare module "effect/unstable/sql/SqlError" {
  export * from "effect/sql/SqlError";
}
