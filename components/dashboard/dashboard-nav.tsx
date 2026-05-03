"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { LogOut, User as UserIcon } from "lucide-react";

import { cn } from "@/lib/client/utils";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  navigationMenuTriggerStyle,
} from "@/components/ui/navigation-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type DashboardNavProps = {
  user: {
    name: string | null;
    email: string | null;
    image?: string | null;
  };
};

const NAV_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/teams", label: "Teams" },
  { href: "/projects", label: "Projects" },
];

/**
 * Build display initials for an avatar fallback. Falls back to a single
 * neutral glyph when we have neither name nor email so the avatar still
 * has consistent dimensions.
 */
function getInitials(name: string | null, email: string | null): string {
  const source = (name?.trim() || email?.trim() || "").replace(/@.*$/, "");
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function DashboardNav({ user }: DashboardNavProps) {
  const pathname = usePathname();
  const initials = getInitials(user.name, user.email);
  const displayName = user.name?.trim() || user.email || "Account";

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
            aria-label="Go to dashboard home"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-bold"
            >
              ◈
            </span>
            <span className="hidden sm:inline">Workspace</span>
          </Link>

          <NavigationMenu>
            <NavigationMenuList>
              {NAV_LINKS.map((link) => {
                const isActive =
                  pathname === link.href ||
                  pathname.startsWith(`${link.href}/`);
                return (
                  <NavigationMenuItem key={link.href}>
                    <NavigationMenuLink asChild active={isActive}>
                      <Link
                        href={link.href}
                        className={cn(
                          navigationMenuTriggerStyle(),
                          isActive && "bg-muted text-foreground",
                        )}
                      >
                        {link.label}
                      </Link>
                    </NavigationMenuLink>
                  </NavigationMenuItem>
                );
              })}
            </NavigationMenuList>
          </NavigationMenu>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex items-center gap-2 rounded-full outline-none ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Open user menu"
          >
            <Avatar>
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="truncate text-sm font-medium leading-none">
                  {displayName}
                </p>
                {user.email ? (
                  <p className="truncate text-xs leading-none text-muted-foreground">
                    {user.email}
                  </p>
                ) : null}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account" className="cursor-pointer">
                <UserIcon className="mr-2 h-4 w-4" />
                <span>Account</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                void signOut({ callbackUrl: "/login" });
              }}
              className="cursor-pointer text-destructive focus:text-destructive"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
