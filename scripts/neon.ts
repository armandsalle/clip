// API REST de Neon (sans dépendance), pour la CI et les scripts : branches de PR et
// URL de connexion. Clé dans NEON_API_KEY (de préférence limitée au projet Clip).
import { NEON_PROJECT_ID } from "@clip/config";

export interface NeonBranch {
  readonly id: string;
  readonly name: string;
  readonly parent_id?: string;
}

const neon = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
  const key = process.env.NEON_API_KEY;
  if (!key) throw new Error("NEON_API_KEY manquant");
  const response = await fetch(
    `https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!response.ok) throw new Error(`Neon ${method} ${path} : HTTP ${response.status}`);
  return (await response.json()) as A;
};

export const findBranch = async (name: string): Promise<NeonBranch | null> => {
  const { branches } = await neon<{ branches: ReadonlyArray<NeonBranch> }>(
    "GET",
    `/branches?search=${encodeURIComponent(name)}`,
  );
  return branches.find((b) => b.name === name) ?? null;
};

/**
 * Nouvelle branche, copiée de `parent` (la branche par défaut, production, s'il est
 * absent). Avec `ttlDays`, elle expire seule ; sans, elle est permanente.
 *
 * `schemaOnly` : tables sans aucune ligne (fonction bêta de Neon). La branche est une
 * nouvelle branche racine, sans parent (pas de « reset from parent »), et le nombre de
 * branches racines par projet est limité par l'offre Neon : réservé au staging.
 */
export const createBranch = async (
  name: string,
  options: {
    readonly ttlDays?: number;
    readonly parent?: NeonBranch;
    readonly schemaOnly?: boolean;
  },
): Promise<NeonBranch> => {
  const expiresAt =
    options.ttlDays === undefined
      ? undefined
      : new Date(Date.now() + options.ttlDays * 24 * 3600 * 1000).toISOString();
  const { branch } = await neon<{ branch: NeonBranch }>("POST", "/branches", {
    branch: {
      name,
      ...(expiresAt && { expires_at: expiresAt }),
      ...(options.parent && { parent_id: options.parent.id }),
      ...(options.schemaOnly && { init_source: "schema-only" }),
    },
    endpoints: [{ type: "read_write" }],
  });
  return branch;
};

/** Branches copiées de `branch` (Neon refuse de supprimer une branche qui en a). */
export const childBranches = async (branch: NeonBranch): Promise<ReadonlyArray<NeonBranch>> => {
  const { branches } = await neon<{ branches: ReadonlyArray<NeonBranch> }>("GET", "/branches");
  return branches.filter((b) => b.parent_id === branch.id);
};

export const deleteBranch = (branch: NeonBranch) => neon("DELETE", `/branches/${branch.id}`);

/**
 * URL directe (non poolée) : migrations et Hyperdrive gèrent eux-mêmes leurs connexions.
 * Le mot de passe est masqué dans les journaux de GitHub Actions.
 */
export const connectionUri = async (branch: NeonBranch): Promise<URL> => {
  // Le calcul d'une nouvelle branche peut mettre quelques secondes à démarrer.
  for (let i = 0; ; i++) {
    try {
      const { uri } = await neon<{ uri: string }>(
        "GET",
        `/connection_uri?branch_id=${branch.id}&database_name=neondb&role_name=neondb_owner`,
      );
      const parsed = new URL(uri);
      if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${parsed.password}`);
      return parsed;
    } catch (error) {
      if (i >= 20) throw error;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
};
