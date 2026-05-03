import "server-only";

/**
 * Public entry point for the attachment storage layer. Importing this module
 * also runs the eager `ensureUploadDirSync` bootstrap in `./storage` — which
 * is the intended side-effect: any handler that touches attachments imports
 * from here, and the upload directory is guaranteed to exist by the time the
 * first request runs.
 */
export { getUploadDir } from "./config";
export {
  ensureUploadDir,
  ensureUploadDirSync,
  uploadBootstrapFailed,
} from "./storage";
export {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_SIZE_BYTES,
  describeUploadValidationFailure,
  isAllowedMimeType,
  validateUpload,
} from "./validation";
export type {
  AllowedMimeType,
  UploadValidationResult,
  ValidatableUpload,
} from "./validation";
