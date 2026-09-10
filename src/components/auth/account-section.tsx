"use client"

import { useState } from "react"
import { LogIn, LogOut } from "lucide-react"
import { toast } from "sonner"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconButton } from "@/components/ui/icon-button"
import { SignInDialog } from "@/components/auth/sign-in-dialog"
import { useOptionalAuth } from "@/components/auth/auth-provider"
import { cn } from "@/lib/utils"

/**
 * The account row at the foot of the sidebar — signed out it is a "Sign in"
 * entry, signed in it is the user's avatar and name with a small menu.
 *
 * Read through useOptionalAuth so it disappears rather than throws when
 * mounted outside an AuthProvider (the sidebar's own unit tests do exactly
 * that), and returns null entirely on a deployment with no accounts
 * configured — TabDump then looks exactly as it did before accounts
 * existed, rather than showing a control that cannot work.
 *
 * Visually it reuses the same IconButton row shape as Favorites / Recent /
 * Graph / Settings directly above it, so it reads as one more entry in that
 * group rather than a bolted-on account widget.
 */
export function AccountSection({ showLabels }: { showLabels: boolean }) {
  const auth = useOptionalAuth()
  const [signInOpen, setSignInOpen] = useState(false)

  if (!auth || !auth.configured || auth.status === "loading") return null

  async function handleSignOut() {
    const result = await auth?.signOut()
    if (result && !result.ok) toast.error(result.error.message)
  }

  if (auth.status === "unauthenticated" || !auth.user) {
    return (
      <>
        <IconButton
          aria-label="Sign in to TabDump"
          tooltip="Sign in"
          onClick={() => setSignInOpen(true)}
          className={cn("w-full", showLabels && "justify-start gap-2 px-2")}
        >
          <LogIn />
          {showLabels && <span className="text-body-sm">Sign in</span>}
        </IconButton>
        <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
      </>
    )
  }

  const user = auth.user
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase()

  return (
    <DropdownMenu>
      {/* The trigger is a plain button rather than a tooltip-wrapped one:
          the collapsed rail already announces the account through
          aria-label, and layering a Tooltip in as the menu's trigger
          element stops the menu opening at all. */}
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Account"
            title={showLabels ? undefined : user.name}
            className={cn(
              "flex w-full items-center rounded-lg border border-transparent p-1 transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:bg-muted",
              showLabels ? "justify-start gap-2" : "justify-center"
            )}
          >
            <Avatar size="sm">
              {/* Google's image CDN can fail or be blocked; the initial
                  fallback means this never renders as a blank circle. */}
              {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />}
              <AvatarFallback>{initial}</AvatarFallback>
            </Avatar>
            {showLabels && <span className="min-w-0 truncate text-body-sm text-foreground">{user.name}</span>}
          </button>
        }
      />
      <DropdownMenuContent align="start" side="top" className="w-56">
        {/* The account identity itself, rather than a menu entry pointing at
            a settings page that doesn't exist. */}
        <div className="px-1.5 py-1.5">
          <p className="truncate text-body-sm font-medium text-foreground">{user.name}</p>
          <p className="truncate text-meta text-tertiary">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={auth.signingOut} onClick={handleSignOut}>
          <LogOut /> {auth.signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
