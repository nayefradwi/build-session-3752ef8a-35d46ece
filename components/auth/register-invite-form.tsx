"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import {
  isPasswordAcceptable,
  passwordStrength,
} from "@/lib/client/password-strength";
import { cn } from "@/lib/client/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Successful payload from `GET /api/auth/invite/[token]`. The endpoint
 * deliberately exposes only the two fields needed to render the form, so we
 * mirror the same minimum here.
 */
type InvitationDetails = {
  email: string;
  tenantName: string;
};

type FieldErrors = Partial<
  Record<"password" | "name" | "form", string>
>;

/**
 * Map a token-lookup error response code (from `GET /api/auth/invite/[token]`)
 * to user-visible copy. The codes mirror the server's `InviteLookupErrorCode`.
 *
 * For invalid-input we deliberately use the same "not found" copy: from the
 * recipient's POV a malformed URL and an unknown token are the same problem
 * ("this link doesn't work"), and there's no reason to surface the structural
 * distinction.
 */
function mapLookupError(code: string | undefined, status: number): string {
  switch (code) {
    case "INVITATION_ALREADY_ACCEPTED":
      return "This invitation has already been redeemed. Try signing in instead.";
    case "INVITATION_EXPIRED":
      return "This invitation has expired. Ask an admin to send you a new one.";
    case "NOT_FOUND":
    case "INVALID_INPUT":
      return "We couldn't find that invitation. Double-check the link from your email.";
    default:
      return status >= 500
        ? "We couldn't verify your invitation right now. Please try again in a moment."
        : "We couldn't verify your invitation. Double-check the link from your email.";
  }
}

/**
 * Map a register-endpoint error response code (from `POST /api/auth/register`)
 * to either a per-field message or a top-level `form` message.
 *
 * The register route returns a tagged `code` (see `RegisterErrorCode`) plus
 * an optional `details` tree from `z.treeifyError` for validation failures.
 * We surface the precise condition where we can (e.g. `EMAIL_TAKEN` becomes
 * "you already have an account — sign in instead") and otherwise fall back
 * to the server-supplied human message.
 */
function mapRegisterError(err: ApiError): FieldErrors {
  const code = err.code;
  switch (code) {
    case "EMAIL_TAKEN":
      return {
        form: "An account with this email already exists. Try signing in instead.",
      };
    case "INVITATION_ALREADY_ACCEPTED":
      return {
        form: "This invitation has already been redeemed. Try signing in instead.",
      };
    case "INVITATION_EXPIRED":
      return {
        form: "This invitation has expired. Ask an admin to send you a new one.",
      };
    case "INVITATION_INVALID":
    case "INVITATION_EMAIL_MISMATCH":
      return {
        form: "This invitation link is no longer valid. Ask an admin to send you a new one.",
      };
    case "RATE_LIMITED":
      return {
        form: "Too many attempts. Please wait a minute and try again.",
      };
    case "INVALID_INPUT": {
      // Pull a per-field hint out of the zod tree if one is present.
      const fields = extractZodFieldErrors(err.data);
      if (Object.keys(fields).length > 0) return fields;
      return { form: err.message || "Please check your details and try again." };
    }
    default:
      return {
        form:
          err.message ||
          (err.status >= 500
            ? "We couldn't create your account right now. Please try again."
            : "Unable to create your account."),
      };
  }
}

/**
 * Walk a `z.treeifyError` payload and surface the first message for each of
 * the form fields we render. The schema's tree shape is:
 *   { properties: { name: { errors: [...] }, password: { errors: [...] } } }
 * but we tolerate older `{ errors: { name: [...] } }` shapes too.
 */
function extractZodFieldErrors(data: unknown): FieldErrors {
  if (!data || typeof data !== "object") return {};
  const out: FieldErrors = {};
  const obj = data as Record<string, unknown>;

  const details =
    (obj.details as Record<string, unknown> | undefined) ??
    (obj as Record<string, unknown>);

  // z.treeifyError shape (zod 4): { properties: { <field>: { errors: [...] } } }
  const properties = (details.properties as Record<string, unknown> | undefined) ??
    undefined;
  if (properties && typeof properties === "object") {
    for (const key of ["name", "password"] as const) {
      const node = properties[key];
      if (node && typeof node === "object") {
        const errs = (node as { errors?: unknown }).errors;
        if (Array.isArray(errs) && typeof errs[0] === "string") {
          out[key] = errs[0];
        }
      }
    }
    if (Object.keys(out).length > 0) return out;
  }

  // Legacy shape fallback: { fieldErrors: { ... } } / { errors: { ... } }
  const candidate =
    (details.fieldErrors as Record<string, unknown> | undefined) ??
    (details.errors as Record<string, unknown> | undefined);
  if (candidate && typeof candidate === "object") {
    for (const key of ["name", "password"] as const) {
      const value = candidate[key];
      if (typeof value === "string" && value) {
        out[key] = value;
      } else if (Array.isArray(value) && typeof value[0] === "string") {
        out[key] = value[0];
      }
    }
  }
  return out;
}

export type RegisterInviteFormProps = {
  token: string;
};

/**
 * Two-phase form:
 *
 *  1. On mount, fetch `GET /api/auth/invite/[token]` to validate the token.
 *     - 200 → render the editable form with `email` pre-filled (read-only)
 *       and the inviting tenant name in the heading.
 *     - 4xx/5xx → render an inline error state with a link back to /login.
 *
 *  2. On submit, POST `{ email, password, name, invitationToken }` to
 *     `/api/auth/register`. On success, auto sign-in via NextAuth credentials
 *     and route to `next` (defaults to `/dashboard`). On failure, surface a
 *     per-field or top-level error inline.
 */
export function RegisterInviteForm({ token }: RegisterInviteFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Restrict `next` to a same-origin absolute path — protects against
  // open-redirects via `?next=https://evil.example`. Mirrors LoginForm.
  const rawNext = searchParams.get("next") ?? "/dashboard";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  // Lookup state. `lookup` is set after the GET resolves.
  const [lookup, setLookup] = useState<InvitationDetails | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(true);

  // Form state.
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const strength = useMemo(() => passwordStrength(password), [password]);

  useEffect(() => {
    let cancelled = false;

    async function loadInvitation() {
      try {
        const data = await apiClient.get<InvitationDetails>(
          `/api/auth/invite/${encodeURIComponent(token)}`,
          { silent: true, skipAuthRedirect: true },
        );
        if (cancelled) return;
        setLookup(data);
        setLookupError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setLookupError(mapLookupError(err.code, err.status));
        } else {
          setLookupError(
            "We couldn't reach the server. Check your connection and try again.",
          );
        }
        setLookup(null);
      } finally {
        if (!cancelled) setLookupLoading(false);
      }
    }

    void loadInvitation();
    return () => {
      cancelled = true;
    };
  }, [token]);

  function validate(): FieldErrors {
    const result: FieldErrors = {};
    if (!name.trim()) result.name = "Your name is required.";
    if (!password) {
      result.password = "Password is required.";
    } else if (!isPasswordAcceptable(password)) {
      result.password =
        "Password must be at least 8 characters and include a mix of letters, numbers, or symbols.";
    }
    return result;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !lookup) return;

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      await apiClient.post(
        "/api/auth/register",
        {
          email: lookup.email,
          password,
          name: name.trim(),
          invitationToken: token,
        },
        { silent: true, skipAuthRedirect: true },
      );
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        setErrors(mapRegisterError(err));
        return;
      }
      setErrors({
        form: "Unable to create your account. Please try again.",
      });
      return;
    }

    // Registration succeeded — auto sign-in via NextAuth credentials so the
    // recipient lands on the dashboard already authenticated.
    try {
      const result = await signIn("credentials", {
        email: lookup.email,
        password,
        redirect: false,
      });

      if (!result || result.error) {
        toast.success("Account created", {
          description: "Please sign in to continue.",
        });
        router.push(`/login?next=${encodeURIComponent(next)}`);
        return;
      }

      toast.success("Welcome aboard", {
        description: `You've joined ${lookup.tenantName}.`,
      });
      router.push(next);
      router.refresh();
    } catch {
      toast.success("Account created", {
        description: "Please sign in to continue.",
      });
      router.push(`/login?next=${encodeURIComponent(next)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (lookupLoading) {
    return (
      <div
        className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Verifying your invitation…</span>
      </div>
    );
  }

  if (lookupError || !lookup) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-3 text-sm text-destructive"
        >
          {lookupError ??
            "We couldn't verify your invitation. Double-check the link from your email."}
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Go to sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <p className="text-sm text-muted-foreground">
        You&apos;ve been invited to join{" "}
        <span className="font-medium text-foreground">{lookup.tenantName}</span>.
        Set up your account to get started.
      </p>

      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          value={lookup.email}
          readOnly
          aria-readonly="true"
          // Read-only fields shouldn't get the "this is interactive" tinting
          // shadcn applies on focus — muted bg + hidden caret signal that
          // this value can't be changed.
          className="bg-muted/50 caret-transparent focus-visible:ring-0"
        />
        <p className="text-xs text-muted-foreground">
          Your invitation was issued to this address.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Full name</Label>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "name-error" : undefined}
          disabled={submitting}
          required
          autoFocus
        />
        {errors.name ? (
          <p id="name-error" className="text-sm text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(errors.password)}
          aria-describedby="password-strength password-error"
          disabled={submitting}
          required
        />
        <div id="password-strength" aria-live="polite" className="space-y-1">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={4}
            aria-valuenow={strength.score}
            aria-label={`Password strength: ${strength.label}`}
          >
            <div
              className={cn(
                "h-full transition-all duration-200",
                strength.color,
              )}
              style={{ width: `${strength.percent}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Strength:{" "}
            <span className="font-medium text-foreground">
              {strength.label}
            </span>
            {" — "}
            use 8+ characters with a mix of letters, numbers, or symbols.
          </p>
        </div>
        {errors.password ? (
          <p id="password-error" className="text-sm text-destructive">
            {errors.password}
          </p>
        ) : null}
      </div>

      {errors.form ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errors.form}
        </div>
      ) : null}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2 className="animate-spin" />
            Creating account…
          </>
        ) : (
          "Accept invitation"
        )}
      </Button>
    </form>
  );
}
