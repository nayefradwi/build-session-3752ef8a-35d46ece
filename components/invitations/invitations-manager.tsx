"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Loader2, Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Loose RFC-5322-ish guard, mirrored from the registration form. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Shape returned by `GET /api/tenant/invitations`. */
type Invitation = {
  id: string;
  tenantId: string;
  email: string;
  token: string;
  status: "pending" | "accepted";
  createdAt: string;
  expiresAt: string;
};

type InvitationsListResponse = { invitations: Invitation[] };
type InviteCreatedResponse = { invitation: Invitation };

/** Format a UTC ISO timestamp as a friendly local-time relative+absolute label. */
function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const now = Date.now();
  const diffMs = date.getTime() - now;
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const absolute = date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (diffMs <= 0) return `Expired · ${absolute}`;
  if (days === 0) return `Expires today · ${absolute}`;
  if (days === 1) return `Expires in 1 day · ${absolute}`;
  return `Expires in ${days} days · ${absolute}`;
}

/**
 * Admin-only "invite users" widget.
 *
 *  - Performs a client-side session role check via `useSession()` and
 *    redirects non-admins to `/dashboard` (server-side enforcement still
 *    happens inside the API routes themselves — this gate is purely UX).
 *  - Submits new invitations to `POST /api/tenant/invite` and reflects
 *    success/error in a sonner toast.
 *  - Renders the list of currently-pending invitations from
 *    `GET /api/tenant/invitations`, with a manual refresh control.
 */
export function InvitationsManager() {
  const router = useRouter();
  const { data: session, status } = useSession();

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const role = session?.user?.role;
  const isAdmin = role === "admin";

  // ── Role gate ────────────────────────────────────────────────────────────
  // Run only when the session has actually resolved. While `status` is
  // "loading" we render a placeholder so we don't redirect prematurely on
  // the first render (which would fire before NextAuth reads the cookie).
  useEffect(() => {
    if (status === "loading") return;
    if (status === "unauthenticated") {
      router.replace("/login?next=/settings/invitations");
      return;
    }
    if (role && role !== "admin") {
      toast.error("Admins only", {
        description: "You need admin access to invite teammates.",
      });
      router.replace("/dashboard");
    }
  }, [router, role, status]);

  // ── Pending invitations list ─────────────────────────────────────────────
  const loadInvitations = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await apiClient.get<InvitationsListResponse>(
        "/api/tenant/invitations",
        { silent: true },
      );
      setInvitations(data.invitations ?? []);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Unable to load pending invitations.";
      setListError(message);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadInvitations();
  }, [isAdmin, loadInvitations]);

  // ── Submit handler ───────────────────────────────────────────────────────
  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;

      const trimmed = email.trim();
      if (!trimmed) {
        setEmailError("Email is required.");
        return;
      }
      if (!EMAIL_RE.test(trimmed)) {
        setEmailError("Enter a valid email address.");
        return;
      }
      setEmailError(null);
      setSubmitting(true);

      try {
        const data = await apiClient.post<InviteCreatedResponse>(
          "/api/tenant/invite",
          { email: trimmed },
          { silent: true, skipAuthRedirect: true },
        );

        toast.success("Invitation sent", {
          description: `An invitation has been created for ${data.invitation.email}.`,
        });
        // Optimistically prepend the new row, then re-sync from the server so
        // anything created by another admin in the meantime shows up too.
        setInvitations((prev) => [data.invitation, ...prev]);
        setEmail("");
        void loadInvitations();
      } catch (err) {
        if (err instanceof ApiError) {
          // Field-level: surface message inline next to the input.
          if (err.code === "EMAIL_TAKEN" || err.code === "ALREADY_INVITED") {
            setEmailError(err.message);
          }
          toast.error("Couldn't send invitation", {
            description: err.message,
          });
        } else {
          toast.error("Couldn't send invitation", {
            description: "Something went wrong. Please try again.",
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [email, loadInvitations, submitting],
  );

  // ── Render states ────────────────────────────────────────────────────────
  if (status === "loading") {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>Loading session…</span>
        </CardContent>
      </Card>
    );
  }

  if (!isAdmin) {
    // Either redirecting (handled in the effect) or session is in a
    // non-admin state. Show a neutral placeholder instead of the form to
    // avoid a flash of admin-only UI.
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>Checking access…</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Invite a new member</CardTitle>
          <CardDescription>
            We&apos;ll email this person a link to join your tenant. The
            invitation is valid for 7 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Work email</Label>
              <Input
                id="invite-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="teammate@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (emailError) setEmailError(null);
                }}
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? "invite-email-error" : undefined}
                disabled={submitting}
                required
              />
              {emailError ? (
                <p
                  id="invite-email-error"
                  className="text-sm text-destructive"
                  role="alert"
                >
                  {emailError}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    Send invitation
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <PendingInvitationsList
        invitations={invitations}
        loading={listLoading}
        error={listError}
        onRefresh={loadInvitations}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Pending invitations list                          */
/* -------------------------------------------------------------------------- */

type PendingInvitationsListProps = {
  invitations: Invitation[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
};

function PendingInvitationsList({
  invitations,
  loading,
  error,
  onRefresh,
}: PendingInvitationsListProps) {
  const headerId = useMemo(() => "pending-invitations-heading", []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle id={headerId} className="text-xl">
            Pending invitations
          </CardTitle>
          <CardDescription>
            Invitations that haven&apos;t been redeemed yet.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={loading}
          aria-label="Refresh pending invitations"
        >
          <RefreshCw
            className={cn("h-4 w-4", loading && "animate-spin")}
            aria-hidden="true"
          />
          <span>Refresh</span>
        </Button>
      </CardHeader>
      <CardContent>
        {loading && invitations.length === 0 ? (
          <div className="flex items-center gap-3 py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Loading invitations…</span>
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        ) : invitations.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No pending invitations. Use the form above to invite someone.
          </p>
        ) : (
          <ul
            aria-labelledby={headerId}
            className="divide-y divide-border rounded-md border"
          >
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {invitation.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatExpiry(invitation.expiresAt)}
                  </p>
                </div>
                <StatusBadge status={invitation.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: Invitation["status"] }) {
  const styles =
    status === "pending"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  const label = status === "pending" ? "Pending" : "Accepted";
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        styles,
      )}
    >
      {label}
    </span>
  );
}
