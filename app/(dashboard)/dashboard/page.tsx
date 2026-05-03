import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowRight, FolderKanban, Users } from "lucide-react";

import { auth } from "@/lib/server/auth";
import { db } from "@/lib/db";
import { tenants } from "@/lib/db/schema";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = {
  title: "Dashboard",
};

// Always render the dashboard against the live session/tenant; the welcome
// strip and tenant name are inherently per-request.
export const dynamic = "force-dynamic";

type QuickLink = {
  href: string;
  label: string;
  description: string;
  Icon: React.ComponentType<{ className?: string }>;
};

const QUICK_LINKS: ReadonlyArray<QuickLink> = [
  {
    href: "/teams",
    label: "Teams",
    description: "Invite teammates and manage who has access to your tenant.",
    Icon: Users,
  },
  {
    href: "/projects",
    label: "Projects",
    description: "Spin up a new project or jump back into an existing one.",
    Icon: FolderKanban,
  },
];

/**
 * Resolve the current tenant for the signed-in user. The session JWT carries
 * `tenantId` (populated in the auth `session` callback), so we hit the
 * tenants table by id directly instead of round-tripping through an internal
 * HTTP endpoint — same trust boundary, fewer hops.
 *
 * Returns `null` when the tenantId is missing from the session or no row
 * matches; the page falls back to a neutral label so the welcome strip
 * still renders.
 */
async function getCurrentTenant(
  tenantId: string | undefined,
): Promise<{ id: string; name: string } | null> {
  if (!tenantId) return null;
  const [row] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row ?? null;
}

/**
 * Pick the friendliest available greeting target. Prefer the user's display
 * name, fall back to the local-part of their email, and last-resort to a
 * generic salutation so we never render `Welcome, null`.
 */
function getGreetingName(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedEmail = email?.trim();
  if (trimmedEmail) return trimmedEmail.replace(/@.*$/, "");
  return "there";
}

/**
 * Post-login landing page. The dashboard layout (`app/(dashboard)/layout.tsx`)
 * has already validated the session and rendered the top nav, so we focus on
 * the welcome content and quick links to the main feature surfaces.
 */
export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    // The layout's `auth()` check should have already redirected, but guard
    // here too so this page never renders for an unauthenticated request
    // even if it's hit through a code path that bypasses the layout cache.
    redirect("/login?next=/dashboard");
  }

  const { name, email, tenantId } = session.user;
  const tenant = await getCurrentTenant(tenantId);
  const greetingName = getGreetingName(name, email);

  return (
    <div className="space-y-8">
      <section
        aria-labelledby="dashboard-welcome-heading"
        className="space-y-2"
      >
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {tenant?.name ?? "Your workspace"}
        </p>
        <h1
          id="dashboard-welcome-heading"
          className="text-3xl font-semibold tracking-tight"
        >
          Welcome back, {greetingName}.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          {tenant?.name
            ? `You're signed in to ${tenant.name}. Pick a workspace below to keep going.`
            : "You're signed in. Pick a workspace below to keep going."}
        </p>
      </section>

      <section aria-labelledby="dashboard-quick-links-heading">
        <h2
          id="dashboard-quick-links-heading"
          className="sr-only"
        >
          Quick links
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {QUICK_LINKS.map(({ href, label, description, Icon }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-lg outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Card className="h-full transition-colors group-hover:border-foreground/40 group-hover:bg-muted/40">
                <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="flex-1 space-y-1">
                    <CardTitle className="flex items-center justify-between text-lg">
                      <span>{label}</span>
                      <ArrowRight
                        aria-hidden="true"
                        className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                      />
                    </CardTitle>
                    <CardDescription>{description}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <span className="text-sm font-medium text-primary group-hover:underline">
                    Open {label.toLowerCase()}
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
