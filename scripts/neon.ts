// API REST de Neon (sans dépendance), pour la CI et les scripts : branches de PR et
// URL de connexion. Clé dans NEON_API_KEY (de préférence limitée au projet Clip).
import { NEON_PROJECT_ID } from "@clip/config";

export interface NeonBranch {
  readonly id: string;
  readonly name: string;
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

/** Branche copiée de la branche par défaut (production), qui expire seule (comme neon.ts). */
export const createBranch = async (
  name: string,
  options: { readonly ttlDays: number },
): Promise<NeonBranch> => {
  const expiresAt = new Date(Date.now() + options.ttlDays * 24 * 3600 * 1000).toISOString();
  const { branch } = await neon<{ branch: NeonBranch }>("POST", "/branches", {
    branch: { name, expires_at: expiresAt },
    endpoints: [{ type: "read_write" }],
  });
  return branch;
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
