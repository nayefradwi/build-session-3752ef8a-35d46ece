import "server-only";

import path from "node:path";

/**
 * Resolve and cache the configured upload directory.
 *
 * Source of truth: `process.env.UPLOAD_DIR`. If unset (the dev / first-run
 * default), we fall back to `./uploads` relative to the Node process CWD —
 * which under `next dev` and `next start` is the project root, matching the
 * value committed in `.env.example`.
 *
 * The path is resolved to an absolute path once, on first access, so callers
 * downstream don't have to worry about a CWD change between the upload and
 * the read. We deliberately do NOT throw when `UPLOAD_DIR` is missing — local
 * dev should "just work" without any env configuration.
 */
let cachedUploadDir: string | undefined;

export function getUploadDir(): string {
  if (cachedUploadDir !== undefined) return cachedUploadDir;
  const raw = process.env.UPLOAD_DIR?.trim();
  const resolved = path.resolve(
    process.cwd(),
    raw && raw.length > 0 ? raw : "./uploads",
  );
  cachedUploadDir = resolved;
  return resolved;
}

/**
 * Test-only: drop the memoized upload dir so a follow-up `getUploadDir()`
 * call re-reads `process.env.UPLOAD_DIR`. Not exported through the package
 * index — callers in test code import it explicitly.
 */
export function __resetUploadDirCacheForTests(): void {
  cachedUploadDir = undefined;
}
