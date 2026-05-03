import type { Metadata } from "next";
import Link from "next/link";

import { RegisterInviteForm } from "@/components/auth/register-invite-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Accept invitation",
  description: "Accept your invitation and create your account.",
};

/**
 * Invitation-acceptance landing page.
 *
 * The token in the URL is a v4 UUID minted by `POST /api/tenant/invite` and
 * embedded in the email link the recipient followed. We don't validate the
 * token here on the server — the client form does that with a single fetch
 * to `GET /api/auth/invite/[token]` so it can render the precise
 * invalid/expired/already-redeemed state inline without forcing a full page
 * round-trip.
 *
 * Next 15 makes route params async; we await before passing the token down
 * so the client component never has to deal with the Promise wrapper.
 */
export default async function InviteRegisterPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <Card>
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle>Accept your invitation</CardTitle>
        <CardDescription>
          Finish setting up your account to join your team.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RegisterInviteForm token={token} />
      </CardContent>
      <CardFooter className="justify-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/login"
          className="ml-1 font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </CardFooter>
    </Card>
  );
}
