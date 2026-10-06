/**
 * Files whose contents Hubble never reads (Hubble 1.6).
 *
 * Deny by default, decided on the project-relative path alone so it can run
 * anywhere and be tested exhaustively. A path that matches is still *named*
 * where an agent's action is reported — hiding that an agent edited `.env`
 * would be worse than showing it — but Hubble keeps no copy of it, measures
 * no lines in it, offers no undo for it, shows no diff of it and never puts it
 * in a Context Pack.
 *
 * Not a complete list of where secrets live, which cannot exist. It is the
 * list of names that almost always hold one, so that the common case is
 * refused without anyone having to think about it.
 */

/** Exact file names (case-insensitive), wherever they sit in the project. */
const SECRET_FILE_NAMES: readonly string[] = [
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".htpasswd",
  ".git-credentials",
  ".dockercfg",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
  "service-account.json",
  "serviceaccount.json",
  "terraform.tfvars",
  "terraform.tfstate",
];

/** Name prefixes: `.env.local`, `credentials.json`, `secrets.yaml`. */
const SECRET_NAME_PREFIXES: readonly string[] = [".env.", "credentials.", "secrets.", "secret."];

/** Extensions that are key or certificate material. */
const SECRET_EXTENSIONS: readonly string[] = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".ppk",
  ".asc",
  ".gpg",
  ".tfstate",
];

/** Directories whose every file is treated as secret. */
const SECRET_DIRECTORIES: readonly string[] = [".ssh", ".aws", ".gnupg", ".docker", ".azure", ".kube"];

/**
 * Whether a project-relative path names a file Hubble must not read.
 *
 * `.env.example` / `.env.sample` / `.env.template` are the one deliberate
 * exception: they are committed templates by convention, and refusing them
 * would only teach people that the rule is noise.
 */
export function isSecretLikePath(relativePath: string): boolean {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const lower = segments.map((segment) => segment.toLowerCase());
  const name = lower[lower.length - 1]!;

  if (lower.slice(0, -1).some((segment) => SECRET_DIRECTORIES.includes(segment))) return true;
  if (/^\.env\.(example|sample|template|dist|defaults)$/.test(name)) return false;
  if (SECRET_FILE_NAMES.includes(name)) return true;
  if (SECRET_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return SECRET_EXTENSIONS.some((extension) => name.endsWith(extension));
}
