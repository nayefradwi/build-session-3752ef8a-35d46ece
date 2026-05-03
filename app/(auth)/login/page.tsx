import type { Metadata } from "next";
import Link from "next/link";

import { LoginForm } from "@/components/auth/login-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your account.",
};

export default function LoginPage() {
  return (
    <Card>
      <CardHeader className="space-y-1.5 text-center">
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>
          Sign in to continue to your dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm />
      </CardContent>
      <CardFooter className="justify-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="ml-1 font-medium text-foreground underline-offset-4 hover:underline"
        >
          Create one
        </Link>
      </CardFooter>
    </Card>
  );
}
