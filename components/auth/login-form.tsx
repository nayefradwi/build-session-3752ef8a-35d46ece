"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FieldErrors = Partial<Record<"email" | "password" | "form", string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Map a NextAuth `signIn` error code to a human-friendly message.
 * The credentials provider returns `CredentialsSignin` for any auth failure
 * (bad email, bad password, missing account, etc.) — we collapse all of those
 * into a single "Invalid email or password" message to avoid leaking which
 * field was wrong.
 */
function mapSignInError(code: string | undefined): string {
  switch (code) {
    case "CredentialsSignin":
      return "Invalid email or password";
    case "AccessDenied":
      return "Your account doesn't have access. Contact your administrator.";
    case "Verification":
      return "This sign-in link is no longer valid.";
    default:
      return GENERIC_ERROR;
  }
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const result: FieldErrors = {};
    if (!email.trim()) {
      result.email = "Email is required.";
    } else if (!EMAIL_RE.test(email.trim())) {
      result.email = "Enter a valid email address.";
    }
    if (!password) {
      result.password = "Password is required.";
    }
    return result;
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
      const result = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
      });

      if (!result) {
        setErrors({ form: GENERIC_ERROR });
        return;
      }

      if (result.error) {
        setErrors({ form: mapSignInError(result.error) });
        return;
      }

      if (!result.ok) {
        setErrors({ form: GENERIC_ERROR });
        return;
      }

      toast.success("Welcome back");
      // `next` is restricted to a same-origin path to prevent open-redirects.
      const target = next.startsWith("/") && !next.startsWith("//")
        ? next
        : "/dashboard";
      router.push(target);
      router.refresh();
    } catch {
      setErrors({ form: GENERIC_ERROR });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
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
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? "password-error" : undefined}
          disabled={submitting}
          required
        />
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
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}
