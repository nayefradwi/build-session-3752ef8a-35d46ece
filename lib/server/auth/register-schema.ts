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
 */
export const registerInputSchema = z.object({
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
    .max(120, { message: "Organization name is too long" }),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;
