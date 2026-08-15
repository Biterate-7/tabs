"use client"

import { LogIn } from "lucide-react"
import { signIn } from "next-auth/react"
import { Button } from "@/components/ui/button"

export function GoogleSignInBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-subtle bg-primary/[0.06] px-3 py-2">
      <LogIn className="size-4 shrink-0 text-accent-text" aria-hidden />
      <p className="text-body-sm text-foreground">
        Sign in with Google to show real titles for Docs, Sheets, and Slides links.
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto shrink-0"
        onClick={() => signIn("google")}
      >
        Sign in
      </Button>
    </div>
  )
}
