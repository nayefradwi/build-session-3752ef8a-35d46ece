import "server-only";

import { fileTypeFromBuffer } from "file-type";

/**
 * Hard upper bound on a single attachment's size.
 *
 * 10 MiB matches the conservative end of the kanban-attachment use case
 * (screenshots, design exports, short PDFs, mid-size office docs). Anything
 * larger is almost always a video / archive that belongs in a dedicated media
 * bucket — we'd rather 422 the upload than chew through a serverless
 * function's memory budget.
 *
 * Stored in bytes so the comparison against `Blob.size` / `Number(size)` is
 * a single integer compare with no rounding surprises.
 */
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Allowed MIME types. We whitelist rather than blacklist: the upload surface
 * is never the right place to "see what happens" with an unknown content
 * type — clients send what we accept or we 422 them.
 *
 * The list covers the kanban-card attachment contract:
 *   - Images: JPEG, PNG, GIF, WebP for screenshots / mockups / icons.
 *   - Documents: PDF + the legacy and OOXML Office trio (Word, Excel,
 *     PowerPoint), plus plain text, CSV, and ZIP for grouped exports.
 *
 * The order below mirrors the task spec verbatim so future audits can grep
 * the whitelist against the contract without ambiguity.
 */
export const ALLOWED_MIME_TYPES = [
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/**
 * Plain-text formats lack a reliable magic-number signature (a `.txt` file is
 * by definition just bytes), so `file-type` will never identify them. We trust
 * the declared `file.type` for these and skip the magic-byte step rather than
 * reject every legitimate text upload.
 *
 * Anything not in this set MUST round-trip through the magic-byte check.
 */
export const MAGIC_BYTE_EXEMPT_MIMES = new Set<AllowedMimeType>([
  "text/plain",
  "text/csv",
]);

/**
 * For each declared MIME we accept, the set of detected MIMEs that `file-type`
 * may legitimately return after sniffing the bytes.
 *
 * Why a set per declared type instead of `detected === declared`?
 *   - Legacy Office binary formats (.doc / .xls / .ppt) all share the
 *     Compound File Binary (OLE) container, which `file-type` reports as
 *     `application/x-cfb`. We can't distinguish doc-vs-xls-vs-ppt from the
 *     magic bytes alone, so any declared legacy-Office MIME is satisfied by
 *     a CFB sniff.
 *   - OOXML formats (.docx / .xlsx / .pptx) are ZIP containers. `file-type`
 *     can usually detect the inner [Content_Types].xml and report the proper
 *     OOXML MIME, but with some packers it falls back to plain
 *     `application/zip`. Both are accepted.
 *   - PowerPoint declares two related OOXML MIMEs (presentation and
 *     slideshow); `file-type` may return either depending on the inner XML.
 */
export const ACCEPTED_DETECTED_MIMES: Record<
  AllowedMimeType,
  ReadonlySet<string>
> = {
  "image/jpeg": new Set(["image/jpeg"]),
  "image/png": new Set(["image/png"]),
  "image/gif": new Set(["image/gif"]),
  "image/webp": new Set(["image/webp"]),
  "application/pdf": new Set(["application/pdf"]),
  "application/msword": new Set(["application/x-cfb"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    new Set([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/zip",
    ]),
  "application/vnd.ms-excel": new Set(["application/x-cfb"]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip",
  ]),
  "application/vnd.ms-powerpoint": new Set(["application/x-cfb"]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    new Set([
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
      "application/zip",
    ]),
  // Plain-text formats are exempt from magic-byte checks (see
  // MAGIC_BYTE_EXEMPT_MIMES); the empty set here is a safety belt — if a caller
  // ever forgets the exemption check, the magic-byte step will reject rather
  // than silently accept.
  "text/plain": new Set(),
  "text/csv": new Set(),
  "application/zip": new Set(["application/zip"]),
};

/**
 * Discriminated result for upload metadata validation. Route handlers map the
 * failure reasons onto HTTP status codes:
 *
 *   - `empty`         -> 422 (file present but zero bytes — almost always a
 *                       client bug; refuse to write a 0-byte attachment).
 *   - `too_large`     -> 422 (size overflow — strict HTTP would prefer 413
 *                       but the contract uses 422 for all client-payload
 *                       faults).
 *   - `invalid_type`  -> 422 'File type not allowed' (declared MIME isn't in
 *                       the whitelist).
 *   - `missing_name`  -> 422 (no filename to display — refuse so the task
 *                       detail UI doesn't have to render a blank row).
 */
export type UploadValidationResult =
  | { ok: true; mimeType: AllowedMimeType }
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
 * This is the *metadata* check; it inspects only `size`, `type`, and `name`.
 * Magic-byte verification (which requires the file body) is a separate step
 * — see `verifyMagicBytes` below.
 *
 * The MIME check normalizes case (RFC 6838 declares MIME types case-
 * insensitive) but does NOT trim parameters — `text/plain; charset=utf-8` is
 * rejected on purpose; the upload contract is "send the bare type, we attach
 * a charset on read".
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
  return { ok: true, mimeType: mime };
}

/**
 * Result of magic-byte (file-content) verification. Distinct from
 * `UploadValidationResult` because the failure modes only make sense once we
 * have the actual bytes:
 *
 *   - `exempt`          -> Declared MIME doesn't have a magic-number signature
 *                          (text/plain, text/csv); no sniff was performed.
 *   - `match`           -> file-type detected a MIME that's an accepted match
 *                          for the declared type.
 *   - `mismatch`        -> file-type detected a recognizable type that does
 *                          NOT match what was declared. This is the classic
 *                          "renamed payload.exe to logo.png" case.
 *   - `unrecognized`    -> file-type couldn't identify the bytes at all. For
 *                          MIMEs that DO have magic numbers, this means the
 *                          file is corrupt or actually a different format —
 *                          we treat it as a rejection.
 */
export type MagicByteVerificationResult =
  | { ok: true; kind: "match"; detectedMime: string; detectedExt: string }
  | { ok: true; kind: "exempt"; declaredMime: AllowedMimeType }
  | {
      ok: false;
      kind: "mismatch";
      declaredMime: AllowedMimeType;
      detectedMime: string;
      detectedExt: string;
    }
  | {
      ok: false;
      kind: "unrecognized";
      declaredMime: AllowedMimeType;
    };

/**
 * Verify that the *bytes* of an upload match its declared MIME type by
 * sniffing the magic number with the `file-type` package.
 *
 * The check is the second line of defense after `validateUpload`: a malicious
 * client can lie about `Content-Type` (multipart parts are attacker-supplied
 * strings), so we only trust the declared type after the bytes prove it.
 *
 * For declared MIMEs in `MAGIC_BYTE_EXEMPT_MIMES` we short-circuit and return
 * `kind: "exempt"` — plain-text formats have no signature to verify.
 *
 * Otherwise the buffer is fed to `fileTypeFromBuffer`, which inspects the
 * first ~4 KiB and returns `{ ext, mime }` or `undefined`. We then look up
 * the per-declared-MIME accept-set in `ACCEPTED_DETECTED_MIMES`. A hit is a
 * `match`; a miss is a `mismatch` (recognized as something else) or
 * `unrecognized` (couldn't be identified at all).
 *
 * The buffer arg is `Uint8Array` because that's what `Buffer.from(arrayBuffer)`
 * structurally is, and it's also what `file-type` expects — no extra copy.
 */
export async function verifyMagicBytes(
  bytes: Uint8Array,
  declaredMime: AllowedMimeType,
): Promise<MagicByteVerificationResult> {
  if (MAGIC_BYTE_EXEMPT_MIMES.has(declaredMime)) {
    return { ok: true, kind: "exempt", declaredMime };
  }

  const detected = await fileTypeFromBuffer(bytes);
  if (!detected) {
    return { ok: false, kind: "unrecognized", declaredMime };
  }

  const accepted = ACCEPTED_DETECTED_MIMES[declaredMime];
  if (accepted.has(detected.mime)) {
    return {
      ok: true,
      kind: "match",
      detectedMime: detected.mime,
      detectedExt: detected.ext,
    };
  }

  return {
    ok: false,
    kind: "mismatch",
    declaredMime,
    detectedMime: detected.mime,
    detectedExt: detected.ext,
  };
}

/**
 * Format a human-readable error message for a metadata validation failure.
 * Centralized so every upload route surfaces the same wording for the same
 * failure mode.
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
      return "File type not allowed";
    case "missing_name":
      return "Uploaded file is missing a filename.";
  }
}
