import { z } from "zod";

/**
 * Password complexity policy:
 *  - minimum 8 characters
 *  - at least one lowercase letter
 *  - at least one uppercase letter
 *  - at least one digit
 *
 * We intentionally do not require punctuation/symbols — empirical research
 * suggests symbol requirements push users toward predictable substitutions
 * without meaningfully raising entropy. The length-plus-class rules below
 * are aligned with NIST SP 800-63B guidance for memorized secrets.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters long`,
  })
  .refine((value) => /[a-z]/.test(value), {
    message: "Password must contain at least one lowercase letter",
  })
  .refine((value) => /[A-Z]/.test(value), {
    message: "Password must contain at least one uppercase letter",
  })
  .refine((value) => /[0-9]/.test(value), {
    message: "Password must contain at least one number",
  });

/**
 * Schema for the JSON body of `POST /api/auth/register`.
 *
 * Two registration paths share this endpoint:
 *
 *   1. **Self-serve (new tenant).** The caller supplies `organizationName`
 *      and we provision a new tenant + admin user.
 *   2. **Invitation redemption.** The caller supplies `invitationToken`
 *      (issued previously by `POST /api/tenant/invite`) and joins the
 *      invitation's tenant as a `member`.
 *
 * Exactly one of the two must be present — supplying both is ambiguous, and
 * supplying neither leaves us with no tenant to associate the user with.
 */
export const registerInputSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, { message: "Email is required" })
      .max(254, { message: "Email is too long" })
      .email({ message: "Email must be a valid address" }),
    password: passwordSchema,
    name: z
      .string()
      .trim()
      .min(1, { message: "Name is required" })
      .max(120, { message: "Name is too long" }),
    organizationName: z
      .string()
      .trim()
      .min(1, { message: "Organization name is required" })
      .max(120, { message: "Organization name is too long" })
      .optional(),
    // Invitation tokens are server-generated UUIDs (see lib/db/schema.ts).
    // We accept them case-insensitively but otherwise enforce the canonical
    // UUID shape so a malformed token short-circuits before we hit the DB.
    invitationToken: z
      .string()
      .trim()
      .uuid({ message: "Invitation token must be a valid UUID" })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const hasOrg = typeof value.organizationName === "string" &&
      value.organizationName.length > 0;
    const hasToken = typeof value.invitationToken === "string" &&
      value.invitationToken.length > 0;

    if (!hasOrg && !hasToken) {
      // Path on `organizationName` keeps backwards-compat with existing
      // self-serve frontends that surface the error next to that field.
      ctx.addIssue({
        code: "custom",
        path: ["organizationName"],
        message:
          "Provide an organization name to create a new workspace, or an invitation token to join an existing one",
      });
      return;
    }

    if (hasOrg && hasToken) {
      ctx.addIssue({
        code: "custom",
        path: ["invitationToken"],
        message:
          "Provide either an organization name or an invitation token, not both",
      });
    }
  });

export type RegisterInput = z.infer<typeof registerInputSchema>;
