import "server-only";

/**
 * Hard upper bound on a single attachment's size.
 *
 * 10 MiB matches the conservative end of the kanban-attachment use case
 * (screenshots, design exports, short PDFs). Anything larger is almost always
 * a video / archive that belongs in a dedicated media bucket — we'd rather
 * 422 the upload than chew through a serverless function's memory budget.
 *
 * Stored in bytes so the comparison against `Blob.size` / `Number(size)` is
 * a single integer compare with no rounding surprises.
 */
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Allowed MIME types. We whitelist rather than blacklist: the upload surface
 * is never the right place to "see what happens" with an unknown content
 * type — clients send what we accept or we 415 them.
 *
 * The list covers common kanban-card attachments: images for screenshots /
 * mockups, PDFs for spec docs, and a small set of plain-text formats. Office
 * formats are intentionally omitted — they round-trip through external
 * tooling and aren't valuable to render inline. Add to this list explicitly
 * when a real workflow needs it.
 */
export const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/**
 * Discriminated result for upload validation. Route handlers map the failure
 * reasons onto HTTP status codes:
 *
 *   - `empty`         -> 422 (file present but zero bytes — almost always a
 *                       client bug; refuse to write a 0-byte attachment).
 *   - `too_large`     -> 413 (payload too large).
 *   - `invalid_type`  -> 415 (unsupported media type).
 *   - `missing_name`  -> 422 (no filename to display — refuse so the task
 *                       detail UI doesn't have to render a blank row).
 */
export type UploadValidationResult =
  | { ok: true }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "too_large"; maxBytes: number; actualBytes: number }
  | {
      ok: false;
      reason: "invalid_type";
      mimeType: string;
      allowed: readonly string[];
    }
  | { ok: false; reason: "missing_name" };

/**
 * Lightweight shape so we can validate either a `File` / `Blob` from a
 * multipart form or a hand-rolled object in tests without importing DOM
 * types. `File` already structurally satisfies this.
 */
export type ValidatableUpload = {
  size: number;
  type: string;
  name?: string;
};

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Validate a candidate upload's size, type, and filename against the limits
 * defined above. Returns a discriminated union — call sites pattern-match
 * `result.reason` to produce an HTTP error with a stable code.
 *
 * We deliberately separate "missing filename" from "missing type" so the
 * upstream error response can speak to the actual fault. The MIME check
 * normalizes case (RFC 6838 declares MIME types case-insensitive) but does
 * NOT trim parameters — `text/plain; charset=utf-8` is rejected on purpose;
 * the upload contract is "send the bare type, we attach a charset on read".
 */
export function validateUpload(file: ValidatableUpload): UploadValidationResult {
  const filename = file.name?.trim();
  if (!filename) {
    return { ok: false, reason: "missing_name" };
  }
  if (file.size <= 0) {
    return { ok: false, reason: "empty" };
  }
  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      maxBytes: MAX_UPLOAD_SIZE_BYTES,
      actualBytes: file.size,
    };
  }
  const mime = file.type?.toLowerCase().trim() ?? "";
  if (!isAllowedMimeType(mime)) {
    return {
      ok: false,
      reason: "invalid_type",
      mimeType: file.type ?? "",
      allowed: ALLOWED_MIME_TYPES,
    };
  }
  return { ok: true };
}

/**
 * Format a human-readable error message for a validation failure. Centralized
 * so every upload route surfaces the same wording for the same failure mode.
 */
export function describeUploadValidationFailure(
  result: Exclude<UploadValidationResult, { ok: true }>,
): string {
  switch (result.reason) {
    case "empty":
      return "Uploaded file is empty.";
    case "too_large":
      return `File exceeds the ${Math.floor(
        result.maxBytes / (1024 * 1024),
      )} MB limit.`;
    case "invalid_type":
      return `Unsupported file type: ${result.mimeType || "unknown"}.`;
    case "missing_name":
      return "Uploaded file is missing a filename.";
  }
}
