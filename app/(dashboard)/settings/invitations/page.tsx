import type { Metadata } from "next";

import { InvitationsManager } from "@/components/invitations/invitations-manager";

export const metadata: Metadata = {
  title: "Invitations · Settings",
  description: "Invite teammates to your tenant and manage pending invitations.",
};

/**
 * Always render against the live session — the client component reads
 * `useSession()` for role gating, and the pending-invitations list is per-
 * tenant so caching across users would be a tenant isolation bug.
 */
export const dynamic = "force-dynamic";

/**
 * Admin-only "Invite users" surface.
 *
 * The dashboard layout (`app/(dashboard)/layout.tsx`) already enforces that
 * the visitor is signed in via `auth()`; the role-based admin gate is
 * performed inside the client component (per spec: "check session role
 * client-side, redirect if member") so we don't have to thread the role
 * through props from the server.
 */
export default function InvitationsPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Settings
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Invite teammates
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Send an invitation email to add a new member to your tenant. Pending
          invitations are valid for 7 days.
        </p>
      </header>

      <InvitationsManager />
    </div>
  );
}
