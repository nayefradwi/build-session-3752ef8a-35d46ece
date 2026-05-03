import { and, eq, gt, like, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { invitations, tenants, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/server/auth/password";
import { registerInputSchema } from "@/lib/server/auth/register-schema";

// Always treat as dynamic: this handler reads the request body and writes to
// the database, so prerender / cache modes must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RegisterErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "EMAIL_TAKEN"
  | "INVITATION_INVALID"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_ACCEPTED"
  | "INVITATION_EMAIL_MISMATCH"
  | "DOMAIN_TAKEN"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: RegisterErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

/**
 * Pull the lowercase domain part of an email. The zod schema has already
 * trimmed + lowercased + validated the address, so a missing `@` here is a
 * "should never happen" case — return null so the caller can no-op.
 */
function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

/**
 * Escape SQL `LIKE` wildcards so a domain like `evil_co.com` is matched
 * literally rather than as a one-char wildcard. Postgres uses backslash as
 * the default `LIKE` escape character.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Parse JSON body. Malformed JSON should be a 400, not a 500.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON",
    );
  }

  // 2. Validate shape & complexity rules. The schema enforces XOR between
  //    `organizationName` and `invitationToken`, so by this point exactly
  //    one of them is set.
  const parsed = registerInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { email, password, name, organizationName, invitationToken } =
    parsed.data;

  // 3. Pre-flight uniqueness check (cheap path — gives a clean 409 before we
  //    burn ~250 ms hashing). The transaction below still relies on the DB
  //    unique index for the race-condition path.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return errorResponse(
      409,
      "EMAIL_TAKEN",
      "An account with this email already exists",
    );
  }

  // 4. Branch: invitation redemption vs. new-tenant self-serve.
  //
  //    For invitations, we look up the token *outside* the transaction so we
  //    can return precise error codes (expired vs. already-accepted vs.
  //    bogus). The transaction below re-reads the row with `FOR UPDATE` to
  //    close the redeem-twice race.
  if (invitationToken) {
    const [invitation] = await db
      .select({
        id: invitations.id,
        tenantId: invitations.tenantId,
        email: invitations.email,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(eq(invitations.token, invitationToken))
      .limit(1);

    if (!invitation) {
      return errorResponse(
        400,
        "INVITATION_INVALID",
        "This invitation link is not recognized",
      );
    }

    if (invitation.status === "accepted") {
      return errorResponse(
        409,
        "INVITATION_ALREADY_ACCEPTED",
        "This invitation has already been redeemed",
      );
    }

    if (invitation.expiresAt.getTime() <= Date.now()) {
      return errorResponse(
        410,
        "INVITATION_EXPIRED",
        "This invitation has expired",
      );
    }

    // Invitations are issued to a specific email address; the recipient
    // shouldn't be able to register under a different identity even if the
    // token leaks. Compare on the lowercased forms (the DB stores raw text
    // but `POST /api/tenant/invite` lowercases on insert).
    if (invitation.email.toLowerCase() !== email) {
      return errorResponse(
        400,
        "INVITATION_EMAIL_MISMATCH",
        "This invitation was issued to a different email address",
      );
    }

    // Hash OUTSIDE the transaction so we don't hold a connection while
    // bcrypt churns through ~12 rounds.
    const passwordHash = await hashPassword(password);

    try {
      const result = await db.transaction(async (tx) => {
        // Re-read the invitation under a row lock to close the race where
        // two redemptions arrive concurrently. The second one will see
        // `status='accepted'` and abort.
        const [locked] = await tx
          .select({
            id: invitations.id,
            tenantId: invitations.tenantId,
            email: invitations.email,
            status: invitations.status,
            expiresAt: invitations.expiresAt,
          })
          .from(invitations)
          .where(eq(invitations.token, invitationToken))
          .for("update")
          .limit(1);

        if (!locked) {
          throw new InvitationRedeemError("INVITATION_INVALID");
        }
        if (locked.status === "accepted") {
          throw new InvitationRedeemError("INVITATION_ALREADY_ACCEPTED");
        }
        if (locked.expiresAt.getTime() <= Date.now()) {
          throw new InvitationRedeemError("INVITATION_EXPIRED");
        }
        if (locked.email.toLowerCase() !== email) {
          throw new InvitationRedeemError("INVITATION_EMAIL_MISMATCH");
        }

        const [user] = await tx
          .insert(users)
          .values({
            email,
            name,
            passwordHash,
            tenantId: locked.tenantId,
            role: "member",
          })
          .returning({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            tenantId: users.tenantId,
            createdAt: users.createdAt,
          });

        await tx
          .update(invitations)
          .set({ status: "accepted" })
          .where(eq(invitations.id, locked.id));

        const [tenant] = await tx
          .select({
            id: tenants.id,
            name: tenants.name,
            createdAt: tenants.createdAt,
          })
          .from(tenants)
          .where(eq(tenants.id, locked.tenantId))
          .limit(1);

        return { tenant, user };
      });

      return NextResponse.json(
        {
          user: result.user,
          tenant: result.tenant,
        },
        { status: 201 },
      );
    } catch (err: unknown) {
      if (err instanceof InvitationRedeemError) {
        switch (err.reason) {
          case "INVITATION_INVALID":
            return errorResponse(
              400,
              "INVITATION_INVALID",
              "This invitation link is not recognized",
            );
          case "INVITATION_ALREADY_ACCEPTED":
            return errorResponse(
              409,
              "INVITATION_ALREADY_ACCEPTED",
              "This invitation has already been redeemed",
            );
          case "INVITATION_EXPIRED":
            return errorResponse(
              410,
              "INVITATION_EXPIRED",
              "This invitation has expired",
            );
          case "INVITATION_EMAIL_MISMATCH":
            return errorResponse(
              400,
              "INVITATION_EMAIL_MISMATCH",
              "This invitation was issued to a different email address",
            );
        }
      }

      // Race-condition path: another request created a user with this email
      // between the pre-flight check and the insert.
      const sqlState =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (sqlState === "23505") {
        return errorResponse(
          409,
          "EMAIL_TAKEN",
          "An account with this email already exists",
        );
      }

      console.error("[POST /api/auth/register] invitation flow error", err);
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "Unable to create account at this time",
      );
    }
  }

  // 5. New-tenant self-serve flow. Block creation when the email's domain
  //    already has at least one user — those organizations should onboard
  //    via invitation rather than spawning a parallel tenant. The check is
  //    informational, not strictly authoritative (we don't claim domains as
  //    a hard schema concept yet), but it prevents the most common foot-gun
  //    where two coworkers each register with their work email and end up
  //    in disconnected workspaces.
  if (!organizationName) {
    // Defense-in-depth — the schema's superRefine already forbids this.
    return errorResponse(
      400,
      "INVALID_INPUT",
      "organizationName is required when no invitation token is provided",
    );
  }

  const domain = emailDomain(email);
  if (domain) {
    const escaped = escapeLikePattern(domain);
    const [domainHit] = await db
      .select({ id: users.id })
      .from(users)
      .where(like(sql`lower(${users.email})`, `%@${escaped}`))
      .limit(1);
    if (domainHit) {
      return errorResponse(
        409,
        "DOMAIN_TAKEN",
        "An organization for this email domain already exists. Ask an admin to invite you instead.",
      );
    }
  }

  // 6. Hash the password OUTSIDE the transaction so we don't hold a DB
  //    connection while bcrypt churns.
  const passwordHash = await hashPassword(password);

  // 7. Create tenant + admin user atomically.
  try {
    const result = await db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: organizationName })
        .returning({
          id: tenants.id,
          name: tenants.name,
          createdAt: tenants.createdAt,
        });

      const [user] = await tx
        .insert(users)
        .values({
          email,
          name,
          passwordHash,
          tenantId: tenant.id,
          role: "admin",
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          tenantId: users.tenantId,
          createdAt: users.createdAt,
        });

      return { tenant, user };
    });

    return NextResponse.json(
      {
        user: result.user,
        tenant: result.tenant,
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    // Race-condition path: another request created a user with this email
    // between the pre-flight check and the insert. Postgres reports unique
    // violations with SQLSTATE 23505.
    const sqlState =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (sqlState === "23505") {
      return errorResponse(
        409,
        "EMAIL_TAKEN",
        "An account with this email already exists",
      );
    }
    console.error("[POST /api/auth/register] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to create account at this time",
    );
  }
}

/**
 * Internal sentinel used to bubble validation failures out of the transaction
 * callback so the outer `catch` can map them to HTTP responses. We can't use
 * a plain `return` because Drizzle's `db.transaction` doesn't have a built-in
 * "abort with success" path — throwing is the documented way to roll back.
 */
class InvitationRedeemError extends Error {
  readonly reason:
    | "INVITATION_INVALID"
    | "INVITATION_ALREADY_ACCEPTED"
    | "INVITATION_EXPIRED"
    | "INVITATION_EMAIL_MISMATCH";

  constructor(reason: InvitationRedeemError["reason"]) {
    super(reason);
    this.reason = reason;
    this.name = "InvitationRedeemError";
  }
}
