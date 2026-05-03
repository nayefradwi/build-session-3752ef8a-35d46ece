import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { invitations, tenants } from "@/lib/db/schema";

// Forced dynamic: this handler reads a path param that varies per request and
// queries the DB on every call. Caching the response would be a correctness
// bug — an invitation can flip from pending → accepted (via the register
// endpoint) or pending → expired (with the passage of time) at any moment, and
// the registration page MUST observe the latest state on each load.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type InviteLookupErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_ACCEPTED"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: InviteLookupErrorCode,
  message: string,
): NextResponse =>
  NextResponse.json({ error: message, code }, { status });

// The token is a v4 UUID minted by `POST /api/tenant/invite` (see schema:
// `invitations.token` defaults to `gen_random_uuid()` and has a unique index).
// Validate before hitting Postgres so an obviously-malformed token (e.g. a
// random string copy-pasted from somewhere) becomes a clean 404 rather than a
// 500 from a uuid-cast error in the WHERE clause.
const tokenParamSchema = z.uuid();

/**
 * GET /api/auth/invite/[token]
 *
 * Public, unauthenticated lookup used by the invite-acceptance page to:
 *   1. Confirm the link the recipient followed is real (and not a typo / a
 *      revoked invitation), and
 *   2. Pre-fill the registration form with the recipient's email and the
 *      organization name they're being invited to join.
 *
 * Auth: NONE. The token itself is the capability — anyone holding it can read
 * the invited email + tenant name. We deliberately do not require a session
 * because the recipient hasn't registered yet, by definition.
 *
 * Response shape:
 *   - 200 `{ email, tenantName }` when the invitation is pending and not
 *     expired. We expose ONLY the two fields the registration UI needs; we do
 *     NOT echo the token, the tenant id, the invitation id, or any timestamps,
 *     because those leak structure that an unauthenticated caller has no use
 *     for.
 *   - 400 `INVALID_INPUT` for a non-UUID token. (We could fold this into the
 *     404 branch — a malformed token can never match a real invitation — but
 *     the explicit code makes "the URL is shaped wrong" easier to debug than
 *     "no such invitation".)
 *   - 404 `NOT_FOUND` when no invitation has the supplied token. Includes the
 *     case where a record was deleted server-side (e.g. tenant was removed,
 *     cascading the invitation row away).
 *   - 410 `INVITATION_EXPIRED` when the row exists but `expiresAt` has passed.
 *     410 (Gone) communicates "this resource was once valid but is no longer"
 *     — the right semantic for a bounded-lifetime token.
 *   - 410 `INVITATION_ALREADY_ACCEPTED` when the row exists but `status =
 *     "accepted"`. Same 410 rationale: the invitation was redeemed and is no
 *     longer usable. We surface a distinct code so the client can render
 *     "this invite was already used — sign in instead" rather than the
 *     generic "expired" copy.
 *
 * The accepted-vs-expired distinction matters: when a token is both expired
 * AND accepted (recipient redeemed it, then time passed), we report
 * `INVITATION_ALREADY_ACCEPTED` first because it's the more precise / less
 * confusing message — the user genuinely already has an account.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token: rawToken } = await context.params;

  const tokenParse = tokenParamSchema.safeParse(rawToken);
  if (!tokenParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid invitation token");
  }
  const token = tokenParse.data;

  try {
    // Single-shot LEFT JOIN against tenants so we read both the invitation
    // status fields and the owning tenant name in one round-trip. The join
    // is on a NOT NULL FK with ON DELETE CASCADE, so in practice tenant is
    // always present when the invitation row exists; we still treat a null
    // join result defensively as a 404 rather than 500-ing.
    const [row] = await db
      .select({
        email: invitations.email,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        tenantName: tenants.name,
      })
      .from(invitations)
      .leftJoin(tenants, eq(tenants.id, invitations.tenantId))
      .where(eq(invitations.token, token))
      .limit(1);

    if (!row || !row.tenantName) {
      return errorResponse(404, "NOT_FOUND", "Invitation not found");
    }

    // Status check first — an accepted invitation is "gone" regardless of
    // whether its TTL has also lapsed, and the more precise message is the
    // useful one for the recipient ("you already have an account" beats
    // "this link expired").
    if (row.status === "accepted") {
      return errorResponse(
        410,
        "INVITATION_ALREADY_ACCEPTED",
        "This invitation has already been redeemed",
      );
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      return errorResponse(
        410,
        "INVITATION_EXPIRED",
        "This invitation has expired",
      );
    }

    return NextResponse.json(
      { email: row.email, tenantName: row.tenantName },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error(
      "[GET /api/auth/invite/[token]] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to look up invitation at this time",
    );
  }
}
