"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { getSettings, setPlayIntro } from "@/lib/settings"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Lazy initializer, same reasoning as LandingView's onboarding/intro
  // state: this dialog only ever mounts client-side, well after hydration.
  const [playIntro, setPlayIntroState] = useState(() => getSettings().playIntro)

  function handlePlayIntroChange(checked: boolean) {
    setPlayIntroState(checked)
    setPlayIntro(checked)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div>
          <p className="px-0.5 pb-2 text-label text-tertiary">APPEARANCE</p>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-subtle p-3">
            <div>
              <p className="text-body-sm font-medium text-foreground">Play intro animation</p>
              <p className="mt-0.5 text-meta text-muted-foreground">
                Show the TabDump cinematic intro when opening the app.
              </p>
            </div>
            <Switch
              checked={playIntro}
              onCheckedChange={handlePlayIntroChange}
              aria-label="Play intro animation"
              className="mt-0.5 shrink-0"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
