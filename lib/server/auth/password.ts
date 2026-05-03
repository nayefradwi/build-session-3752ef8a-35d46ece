import "server-only";

import bcrypt from "bcrypt";

/**
 * Bcrypt cost factor used for all password hashes. Tuned for ~hundreds of ms
 * per hash on a Vercel serverless function — the canonical safe range in
 * 2025 is 12, which we lock in here so every caller stays consistent.
 */
export const PASSWORD_BCRYPT_ROUNDS = 12;

/**
 * Hash a plaintext password with bcrypt.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, PASSWORD_BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password against a previously-stored bcrypt hash.
 * Returns false (rather than throwing) on any malformed-hash input so callers
 * can treat it as a generic "credentials incorrect" path.
 */
export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
