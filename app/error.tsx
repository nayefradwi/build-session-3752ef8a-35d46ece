"use client";

import { useEffect } from "react";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Root-level error boundary. Renders for any uncaught error in a Server
 * Component or Client Component anywhere in the app tree (outside of more
 * specific error boundaries).
 *
 * Note: this file MUST be a Client Component — Next.js requires it.
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // Log to the browser console; production hooks (Sentry, Datadog, etc.)
    // can be wired here later.
    // eslint-disable-next-line no-console
    console.error("[app/error] Uncaught error:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-24 text-center">
      <div className="mx-auto max-w-md space-y-6">
        <div className="space-y-2">
          <p className="text-sm font-medium uppercase tracking-wide text-destructive">
            Something went wrong
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            We hit an unexpected error
          </h1>
          <p className="text-muted-foreground">
            The team has been notified. You can try again, or head back home.
          </p>
        </div>

        {process.env.NODE_ENV !== "production" && error?.message ? (
          <pre className="overflow-auto rounded-md border border-border bg-muted p-3 text-left text-xs text-muted-foreground">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : null}
          </pre>
        ) : null}

        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Go home
          </a>
        </div>
      </div>
    </main>
  );
}
