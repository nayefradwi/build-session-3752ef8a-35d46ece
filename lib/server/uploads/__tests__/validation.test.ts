/**
 * Unit tests for the file-type whitelist + magic-byte verification used by
 * POST /api/tasks/[taskId]/attachments.
 *
 * Goals (per task d840ae72):
 *   - Lock in the exact MIME whitelist required by the contract: jpeg, png,
 *     gif, webp, pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, zip.
 *   - Verify the metadata-level rejection ("invalid_type") fires when a
 *     declared MIME isn't on the whitelist.
 *   - Verify the content-level rejection (`verifyMagicBytes`) fires when the
 *     bytes don't match what was declared, and exempts the plain-text MIMEs
 *     that have no signature.
 *
 * Run with:
 *   npx tsx --test lib/server/uploads/__tests__/validation.test.ts
 *
 * No vitest / jest dependency — uses Node's built-in test runner
 * (`node:test`) with strict assertions, driven through `tsx` so the
 * TypeScript file runs without a separate compile.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALLOWED_MIME_TYPES,
  MAGIC_BYTE_EXEMPT_MIMES,
  validateUpload,
  verifyMagicBytes,
} from "../validation";

// Minimal magic-number fixtures. file-type only needs a handful of bytes from
// the start of the file, so each fixture is just the signature plus a
// trailing pad — a real PNG/JPEG/PDF/ZIP would have more content but the
// sniffer's decision is made on these first few bytes.

/**
 * 1×1 transparent PNG.
 *
 * Magic: 89 50 4E 47 0D 0A 1A 0A. Followed by a complete IHDR + IDAT + IEND
 * so file-type's PNG decoder is confident — `fileTypeFromBuffer` checks more
 * than just the 8-byte signature for some formats.
 */
const PNG_FIXTURE = Buffer.from(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082",
  "hex",
);

/**
 * Minimal PDF: header, one trivial object, xref, trailer, EOF marker.
 *
 * Magic: %PDF- (25 50 44 46 2D). file-type just looks for the header so
 * anything after is filler from a real-document perspective.
 */
const PDF_FIXTURE = Buffer.from(
  "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\nxref\n0 1\n0000000000 65535 f \ntrailer<<>>\nstartxref\n0\n%%EOF\n",
  "binary",
);

/**
 * Minimal JPEG: SOI marker (FF D8 FF) + a JFIF APP0 segment + EOI (FF D9).
 *
 * file-type's JPEG check verifies the SOI prefix; the APP0 segment makes the
 * blob structurally a JFIF JPEG so the result is unambiguous.
 */
const JPEG_FIXTURE = Buffer.from(
  "FFD8FFE000104A46494600010100000100010000FFD9",
  "hex",
);

describe("ALLOWED_MIME_TYPES whitelist", () => {
  it("contains every MIME the task contract requires", () => {
    const required = [
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
    ];
    for (const mime of required) {
      assert.ok(
        (ALLOWED_MIME_TYPES as readonly string[]).includes(mime),
        `expected ALLOWED_MIME_TYPES to include ${mime}`,
      );
    }
  });

  it("does not silently allow anything outside the contract", () => {
    // Spot-check a handful of common-but-not-allowed types — guards against
    // someone accidentally widening the list.
    const disallowed = [
      "application/octet-stream",
      "image/svg+xml",
      "application/x-msdownload",
      "video/mp4",
      "audio/mpeg",
      "text/html",
    ];
    for (const mime of disallowed) {
      assert.equal(
        (ALLOWED_MIME_TYPES as readonly string[]).includes(mime),
        false,
        `expected ${mime} to NOT be in ALLOWED_MIME_TYPES`,
      );
    }
  });
});

describe("validateUpload", () => {
  it("accepts a well-formed PNG metadata triple", () => {
    const result = validateUpload({
      size: 1024,
      type: "image/png",
      name: "screenshot.png",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mimeType, "image/png");
    }
  });

  it("rejects an unknown declared MIME with reason=invalid_type", () => {
    const result = validateUpload({
      size: 1024,
      type: "application/x-msdownload",
      name: "evil.exe",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_type");
    }
  });

  it("rejects empty files", () => {
    const result = validateUpload({
      size: 0,
      type: "image/png",
      name: "empty.png",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "empty");
    }
  });

  it("rejects oversize uploads", () => {
    const result = validateUpload({
      size: 50 * 1024 * 1024, // 50 MiB
      type: "application/pdf",
      name: "huge.pdf",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "too_large");
    }
  });

  it("rejects parameterized MIMEs (e.g. 'text/plain; charset=utf-8')", () => {
    // The contract is "send the bare type"; charset is added on read. A
    // parameterized MIME is treated as invalid_type so the rejection path is
    // exercised.
    const result = validateUpload({
      size: 10,
      type: "text/plain; charset=utf-8",
      name: "notes.txt",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_type");
    }
  });
});

describe("verifyMagicBytes", () => {
  it("accepts a real PNG buffer declared as image/png", async () => {
    const result = await verifyMagicBytes(PNG_FIXTURE, "image/png");
    assert.equal(result.ok, true);
    if (result.ok && result.kind === "match") {
      assert.equal(result.detectedMime, "image/png");
    }
  });

  it("accepts a real JPEG buffer declared as image/jpeg", async () => {
    const result = await verifyMagicBytes(JPEG_FIXTURE, "image/jpeg");
    assert.equal(result.ok, true);
  });

  it("accepts a real PDF buffer declared as application/pdf", async () => {
    const result = await verifyMagicBytes(PDF_FIXTURE, "application/pdf");
    assert.equal(result.ok, true);
  });

  it("rejects PNG bytes declared as application/pdf (mismatch)", async () => {
    // Classic renamed-payload case: bytes are PNG, multipart claims PDF.
    const result = await verifyMagicBytes(PNG_FIXTURE, "application/pdf");
    assert.equal(result.ok, false);
    if (!result.ok && result.kind === "mismatch") {
      assert.equal(result.detectedMime, "image/png");
      assert.equal(result.declaredMime, "application/pdf");
    }
  });

  it("rejects PDF bytes declared as image/png (mismatch)", async () => {
    const result = await verifyMagicBytes(PDF_FIXTURE, "image/png");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "mismatch");
    }
  });

  it("rejects unrecognized garbage even if declared MIME is allowed", async () => {
    // 32 bytes of 0x00 — file-type can't classify this; the result must be
    // `unrecognized` so the route falls through to a 422.
    const garbage = Buffer.alloc(32);
    const result = await verifyMagicBytes(garbage, "image/png");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "unrecognized");
    }
  });

  it("exempts text/plain (no magic bytes to verify)", async () => {
    const text = Buffer.from("hello world\nthis is a plain-text file", "utf8");
    const result = await verifyMagicBytes(text, "text/plain");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.kind, "exempt");
    }
  });

  it("exempts text/csv (no magic bytes to verify)", async () => {
    const csv = Buffer.from("a,b,c\n1,2,3\n", "utf8");
    const result = await verifyMagicBytes(csv, "text/csv");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.kind, "exempt");
    }
  });

  it("declares text/plain and text/csv as the only exempt MIMEs", () => {
    assert.equal(MAGIC_BYTE_EXEMPT_MIMES.size, 2);
    assert.ok(MAGIC_BYTE_EXEMPT_MIMES.has("text/plain"));
    assert.ok(MAGIC_BYTE_EXEMPT_MIMES.has("text/csv"));
  });
});
