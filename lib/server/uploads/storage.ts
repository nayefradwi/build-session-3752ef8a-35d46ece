import "server-only";

import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";

import { getUploadDir } from "./config";

/**
 * Bootstrap the upload directory.
 *
 * The directory is gitignored (so a clean checkout never has it), but the
 * upload handler needs it to exist before the first write. We provide both
 * an async ensure (preferred — call it from route handlers / startup hooks)
 * and a sync ensure (used by the eager startup bootstrap below so module
 * import order doesn't matter).
 *
 * `recursive: true` means repeated calls are idempotent and a missing parent
 * is created in one shot — no need to pre-check existence.
 */
export async function ensureUploadDir(): Promise<string> {
  const dir = getUploadDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export function ensureUploadDirSync(): string {
  const dir = getUploadDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Eager startup bootstrap. Importing this module from any server entry point
// (e.g. an API route handler that touches attachments, or a future startup
// hook in `next.config.ts`) guarantees the upload directory exists before
// the first request is served. The sync variant is intentional — module
// initialization shouldn't depend on the event loop being free, and the
// directory must be present synchronously before any async upload handler
// runs.
//
// We swallow errors at import time and re-throw on the next async ensure so
// that a transient FS hiccup at boot doesn't crash the entire app.
let bootstrapErrored = false;
try {
  ensureUploadDirSync();
} catch (err) {
  bootstrapErrored = true;
  console.error(
    "[uploads] failed to ensure UPLOAD_DIR at startup; will retry on first upload",
    err,
  );
}

/**
 * Returns true iff the eager bootstrap above failed. Route handlers that
 * touch the filesystem can branch on this to fall back to `ensureUploadDir`
 * before writing — by which point the FS error will surface to the request
 * instead of a half-initialized module.
 */
export function uploadBootstrapFailed(): boolean {
  return bootstrapErrored;
}
