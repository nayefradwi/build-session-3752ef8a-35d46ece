import { and, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { invitations, users } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Always treat as dynamic: the handler reads the session cookie + body and
// writes to the database, so prerender / route caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Invitations are valid for 7 days from creation. Recipients who don't redeem
 * within the window must be re-invited. We compute the expiry server-side so
 * the client can't extend (or shorten) it by manipulating the request body.
 */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type InviteErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "EMAIL_TAKEN"
  | "ALREADY_INVITED"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: InviteErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

const inviteInputSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(254)
    .email(),
});

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Authenticate. `auth()` returns null for unauthenticated requests; we
  //    check explicitly so we don't accidentally pass `undefined` into the
  //    tenant-scoped queries below.
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  // 2. Authorize. Only tenant admins can issue invitations. Members hitting
  //    this endpoint get a 403 (so the client can distinguish "log in" from
  //    "you can't do this").
  if (session.user.role !== "admin") {
    return errorResponse(
      403,
      "FORBIDDEN",
      "Only tenant admins can invite new members",
    );
  }

  const tenantId = session.user.tenantId;

  // 3. Parse JSON body. Malformed JSON should be a 400, not a 500.
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

  // 4. Validate shape.
  const parsed = inviteInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { email } = parsed.data;

  // 5. Pre-flight conflict checks. We run these as cheap selects so the
  //    caller gets a precise error code rather than a generic 500 from the
  //    DB unique index. The DB still has the unique constraint on token as
  //    the ultimate race-condition guard.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingUser) {
    return errorResponse(
      409,
      "EMAIL_TAKEN",
      "A user with this email already exists",
    );
  }

  const now = new Date();
  const [existingInvite] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.tenantId, tenantId),
        eq(invitations.email, email),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    )
    .limit(1);
  if (existingInvite) {
    return errorResponse(
      409,
      "ALREADY_INVITED",
      "An active invitation for this email already exists",
    );
  }

  // 6. Create the invitation. Token + id default to gen_random_uuid() at the
  //    DB level (see lib/db/schema.ts), so we only need to supply the bits
  //    we control: tenant scope, email, and the explicit expiry.
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);

  try {
    const [invitation] = await db
      .insert(invitations)
      .values({
        tenantId,
        email,
        expiresAt,
      })
      .returning({
        id: invitations.id,
        tenantId: invitations.tenantId,
        email: invitations.email,
        token: invitations.token,
        status: invitations.status,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
      });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (err: unknown) {
    // Race: a concurrent request created an invitation with the same token
    // (astronomically unlikely with v4 UUIDs, but handle the unique-violation
    // path defensively rather than 500-ing). Postgres reports unique
    // violations with SQLSTATE 23505.
    const sqlState =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (sqlState === "23505") {
      return errorResponse(
        409,
        "ALREADY_INVITED",
        "An active invitation for this email already exists",
      );
    }
    console.error("[POST /api/tenant/invite] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to create invitation at this time",
    );
  }
}
