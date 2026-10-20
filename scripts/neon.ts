// Branches Neon et URL de connexion, par la CLI de Neon (`neonctl`, dans le catalog).
// En local, la session de `neonctl auth` suffit ; en CI, la CLI lit NEON_API_KEY (de
// préférence une clé limitée au projet Clip). Aucune valeur secrète n'est affichée.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NEON_PROJECT_ID } from "@clip/config";

export interface NeonBranch {
  readonly id: string;
  readonly name: string;
  readonly parent_id?: string;
}

const root = fileURLToPath(new URL("..", import.meta.url).href);

/** `neonctl <args>` sur le projet Clip ; sortie JSON, sauf `json: false`. */
const neonctl = (args: ReadonlyArray<string>, json = true): string => {
  try {
    return execFileSync(
      "vp",
      [
        "exec",
        "neonctl",
        ...args,
        "--project-id",
        NEON_PROJECT_ID,
        ...(json ? ["--output", "json"] : []),
        "--no-color",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // stderr seulement : stdout peut contenir une URL de connexion.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`neonctl ${args.slice(0, 2).join(" ")} : ${stderr}`, { cause: error });
  }
};

const listBranches = (): ReadonlyArray<NeonBranch> =>
  JSON.parse(neonctl(["branches", "list"])) as ReadonlyArray<NeonBranch>;

export const findBranch = async (name: string): Promise<NeonBranch | null> =>
  listBranches().find((b) => b.name === name) ?? null;

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
  const out = JSON.parse(
    neonctl([
      "branches",
      "create",
      "--name",
      name,
      ...(options.parent ? ["--parent", options.parent.id] : []),
      ...(options.schemaOnly ? ["--schema-only"] : []),
      ...(expiresAt ? ["--expires-at", expiresAt] : []),
      // Sans identifiants dans la sortie : `connectionUri` les demande à part.
      "--no-secrets",
    ]),
  ) as { branch?: NeonBranch } & Partial<NeonBranch>;
  return out.branch ?? (out as NeonBranch);
};

/** Branches copiées de `branch` (Neon refuse de supprimer une branche qui en a). */
export const childBranches = async (branch: NeonBranch): Promise<ReadonlyArray<NeonBranch>> =>
  listBranches().filter((b) => b.parent_id === branch.id);

export const deleteBranch = async (branch: NeonBranch): Promise<void> => {
  neonctl(["branches", "delete", branch.id]);
};

/**
 * URL directe (non poolée) : migrations et Hyperdrive gèrent eux-mêmes leurs connexions.
 * Le mot de passe est masqué dans les journaux de GitHub Actions.
 */
export const connectionUri = async (branch: NeonBranch): Promise<URL> => {
  // Le calcul d'une nouvelle branche peut mettre quelques secondes à démarrer.
  for (let i = 0; ; i++) {
    try {
      const uri = neonctl(
        [
          "connection-string",
          branch.id,
          "--database-name",
          "neondb",
          "--role-name",
          "neondb_owner",
        ],
        false,
      ).trim();
      const parsed = new URL(uri);
      if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${parsed.password}`);
      return parsed;
    } catch (error) {
      if (i >= 20) throw error;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
};
