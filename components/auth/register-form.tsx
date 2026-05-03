"use client";

import { useMemo, useState, type FormEvent } from "react";
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

type FieldErrors = Partial<
  Record<"email" | "password" | "name" | "organizationName" | "form", string>
>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pull a per-field error map out of an arbitrary API error body. */
function extractFieldErrors(data: unknown): FieldErrors {
  if (!data || typeof data !== "object") return {};
  const result: FieldErrors = {};
  const obj = data as Record<string, unknown>;

  // Common shapes: { fieldErrors: { email: "..." } } or { errors: { ... } }
  const candidate =
    (obj.fieldErrors as Record<string, unknown> | undefined) ??
    (obj.errors as Record<string, unknown> | undefined);

  if (candidate && typeof candidate === "object") {
    for (const key of [
      "email",
      "password",
      "name",
      "organizationName",
    ] as const) {
      const value = candidate[key];
      if (typeof value === "string" && value) {
        result[key] = value;
      } else if (Array.isArray(value) && typeof value[0] === "string") {
        result[key] = value[0];
      }
    }
  }

  return result;
}

export function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const strength = useMemo(() => passwordStrength(password), [password]);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!name.trim()) next.name = "Your name is required.";
    if (!organizationName.trim())
      next.organizationName = "Organization name is required.";
    if (!email.trim()) {
      next.email = "Email is required.";
    } else if (!EMAIL_RE.test(email.trim())) {
      next.email = "Enter a valid email address.";
    }
    if (!password) {
      next.password = "Password is required.";
    } else if (!isPasswordAcceptable(password)) {
      next.password =
        "Password must be at least 8 characters and include a mix of letters, numbers, or symbols.";
    }
    return next;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

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
          email: email.trim(),
          password,
          name: name.trim(),
          organizationName: organizationName.trim(),
        },
        { silent: true, skipAuthRedirect: true },
      );
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        const fieldErrors = extractFieldErrors(err.data);
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          return;
        }
        setErrors({ form: err.message || "Unable to create your account." });
        return;
      }
      setErrors({ form: "Unable to create your account. Please try again." });
      return;
    }

    // Registration succeeded — auto sign-in via NextAuth credentials.
    try {
      const result = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
      });

      if (!result || result.error) {
        // Account was created, but auto sign-in failed for some reason.
        toast.success("Account created", {
          description: "Please sign in to continue.",
        });
        router.push(`/login?next=${encodeURIComponent(next)}`);
        return;
      }

      toast.success("Welcome aboard", {
        description: "Your account is ready.",
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

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
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
        />
        {errors.name ? (
          <p id="name-error" className="text-sm text-destructive">
            {errors.name}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="organizationName">Organization name</Label>
        <Input
          id="organizationName"
          name="organizationName"
          autoComplete="organization"
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
          aria-invalid={Boolean(errors.organizationName)}
          aria-describedby={
            errors.organizationName ? "organizationName-error" : undefined
          }
          disabled={submitting}
          required
        />
        {errors.organizationName ? (
          <p id="organizationName-error" className="text-sm text-destructive">
            {errors.organizationName}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "email-error" : undefined}
          disabled={submitting}
          required
        />
        {errors.email ? (
          <p id="email-error" className="text-sm text-destructive">
            {errors.email}
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
          "Create account"
        )}
      </Button>
    </form>
  );
}
