// Copied from odss-next (ODSS service app). Namespaced under ods/ so it
// cannot collide with this app's own lib of the same name, and imports are
// rewritten to match. Only the db helper and the session/role gate differ.
const MIN_SECRET_LENGTH = 32;

/**
 * Authentication and public-link signatures must never silently fall back to a
 * known key. Failing during startup/build is safer than issuing forgeable JWTs.
 */
export function authSecretText(): string {
  const secret = process.env.AUTH_SECRET?.trim() ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be configured with at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

export function authSecretBytes(): Uint8Array {
  return new TextEncoder().encode(authSecretText());
}
