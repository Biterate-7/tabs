"use client"

import { useState, type ReactNode } from "react"
import { ChevronDown, Download, ExternalLink, Puzzle } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EXTENSION_INSTALL_STEPS } from "@/components/extension-install-guide"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { useBrowserConnected } from "@/hooks/use-tab-sessions"
import { EXTENSION_DOWNLOAD_URL, getExtensionInstallInfo } from "@/lib/extension-config"
import { openExternal } from "@/lib/platform"
import { AI_PROVIDERS, AI_PROVIDER_IDS } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import { ProviderMark } from "./provider-mark"

/**
 * Bringing AI conversations in: Hubble for Chrome's Save to Hubble, from the
 * conversation's own page, is the one way. This is what Hubble shows
 * wherever someone would look for that way in:
 *
 *   install    Bring your AI conversations into Hubble · how it works · [Get the Chrome Extension]
 *   connected  Your AI conversations, organized · [Open AI chat ▾]
 *   desktop    as install, plus [Open AI chat ▾] — Hubble Desktop never hears from the extension, so it can't know
 *
 * "Connected" is only ever the extension answering this page right now (the
 * browser bridge's ping), never a guess from the browser or a past visit.
 */
export type SaveFromAiState = "install" | "connected" | "desktop"

export function useSaveFromAiState(): SaveFromAiState {
  const desktop = useIsDesktop()
  const connected = useBrowserConnected()
  return desktop ? "desktop" : connected ? "connected" : "install"
}

/** The AI apps Hubble for Chrome saves conversations from, as the provider registry records them. */
const CAPTURE_PROVIDERS = AI_PROVIDER_IDS.filter((id) => AI_PROVIDERS[id].capabilities.pageCapture.supported)

function listWords(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : (names[0] ?? "")
}

export const SAVE_FROM_AI_STEPS = [
  "Install Hubble for Chrome.",
  `Open a conversation in ${listWords(CAPTURE_PROVIDERS.map((id) => AI_PROVIDERS[id].name))}.`,
  "Click the Hubble extension and choose Save to Hubble.",
  "Find it in Hubble, in the project you chose.",
] as const

const COPY: Record<SaveFromAiState, { title: string; description: string }> = {
  install: {
    title: "Bring your AI conversations into Hubble",
    description: "Save conversations from your supported AI tools directly to Hubble with the Chrome extension.",
  },
  connected: {
    title: "Your AI conversations, organized",
    description: "Open a supported AI conversation and save it to your Hubble workspace using the extension.",
  },
  desktop: {
    title: "Bring your AI conversations into Hubble",
    description: "Save conversations from your supported AI tools directly to Hubble with the Chrome extension. While Hubble Desktop is open, they're saved here.",
  },
}

type Size = "xs" | "sm" | "default" | "lg"

/** Opens a new chat in one of the AI apps the extension saves from — in a browser tab, or the default browser from Hubble Desktop. */
export function OpenAiChatMenu({ size = "default", variant = "default" }: { size?: Size; variant?: "default" | "secondary" | "ghost" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" size={size} variant={variant}>
            <ExternalLink /> Open AI chat <ChevronDown className="opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-40">
        {CAPTURE_PROVIDERS.map((id) => (
          <DropdownMenuItem key={id} onClick={() => void openExternal(AI_PROVIDERS[id].homeUrl).catch(() => undefined)}>
            <ProviderMark provider={id} size={14} /> {AI_PROVIDERS[id].name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * "Get the Chrome Extension": the Chrome Web Store listing when one is
 * configured (lib/extension-config), otherwise the install steps for the
 * packaged download — `onShowSteps`, or a dialog of its own.
 */
export function GetExtensionButton({ size = "default", variant = "default", onShowSteps }: { size?: Size; variant?: "default" | "secondary" | "ghost"; onShowSteps?: () => void }) {
  const install = getExtensionInstallInfo()
  const desktop = useIsDesktop()
  const [stepsOpen, setStepsOpen] = useState(false)
  const label = (
    <>
      <Puzzle /> Get the Chrome Extension
    </>
  )
  if (install.mode === "store") {
    // Hubble Desktop's webview opens no new windows: the store goes to the default browser.
    return desktop ? (
      <Button type="button" size={size} variant={variant} onClick={() => void openExternal(install.url).catch(() => undefined)}>
        {label}
      </Button>
    ) : (
      <a href={install.url} target="_blank" rel="noreferrer" className={buttonVariants({ size, variant })}>
        {label}
      </a>
    )
  }
  return (
    <>
      <Button type="button" size={size} variant={variant} onClick={() => (onShowSteps ? onShowSteps() : setStepsOpen(true))}>
        {label}
      </Button>
      {!onShowSteps && (
        <Dialog open={stepsOpen} onOpenChange={setStepsOpen}>
          <DialogContent className="sm:max-w-md">
            <InstallSteps />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** The packaged extension and how to load it — the same steps as onboarding and Settings → Chrome extension. */
function InstallSteps({ onBack }: { onBack?: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Install Hubble for Chrome</DialogTitle>
        <DialogDescription>Install it in Chrome, then come back here.</DialogDescription>
      </DialogHeader>
      <ol className="mt-3 flex flex-col gap-2" aria-label="Install steps">
        {EXTENSION_INSTALL_STEPS.map((step, index) => (
          <li key={index} className="flex gap-3 text-body-sm text-muted-foreground">
            <span className="w-4 shrink-0 text-meta leading-5 text-tertiary tabular-nums">{index + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <DialogFooter>
        {onBack && (
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        {/* The bundled ZIP, as Settings → Chrome extension offers it (Hubble Desktop's webview saves it to Downloads). */}
        <a href={EXTENSION_DOWNLOAD_URL} download className={buttonVariants()}>
          <Download /> Download Extension
        </a>
      </DialogFooter>
    </>
  )
}

/** What to do next, for the state Hubble is in. */
function Actions({ state, size, quiet = false, onShowSteps }: { state: SaveFromAiState; size?: Size; quiet?: boolean; onShowSteps?: () => void }) {
  if (state === "connected") return <OpenAiChatMenu size={size} variant={quiet ? "ghost" : "default"} />
  return (
    <>
      <GetExtensionButton size={size} variant={quiet ? "ghost" : "default"} {...(onShowSteps ? { onShowSteps } : {})} />
      {state === "desktop" && <OpenAiChatMenu size={size} variant={quiet ? "ghost" : "secondary"} />}
    </>
  )
}

/** The four steps, for anyone who hasn't set the extension up yet. */
function HowItWorks() {
  return (
    <ol className="flex flex-col gap-1" aria-label="How it works">
      {SAVE_FROM_AI_STEPS.map((step, index) => (
        <li key={index} className="flex gap-2.5 text-body-sm text-muted-foreground">
          <span className="w-3 shrink-0 text-meta leading-5 text-tertiary tabular-nums">{index + 1}</span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

/** The call to action in a page: where "Paste a conversation" and "Add a link" used to be. */
export function SaveFromAiCard({ className }: { className?: string }) {
  const state = useSaveFromAiState()
  const copy = COPY[state]
  return (
    <div className={cn("flex w-full max-w-xl flex-col gap-3 rounded-md border border-subtle bg-card p-4", className)} data-save-from-ai={state}>
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium text-foreground">{copy.title}</p>
        <p className="text-body-sm text-muted-foreground">{copy.description}</p>
      </div>
      {state !== "connected" && <HowItWorks />}
      <div className="flex flex-wrap gap-2">
        <Actions state={state} />
      </div>
    </div>
  )
}

/** The same, as a dialog: from + Add and the command palette. */
export function SaveFromAiDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const state = useSaveFromAiState()
  const copy = COPY[state]
  const [steps, setSteps] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSteps(false)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md" data-save-from-ai={state}>
        {steps ? (
          <InstallSteps onBack={() => setSteps(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            {state !== "connected" && (
              <div className="mt-3">
                <HowItWorks />
              </div>
            )}
            <DialogFooter>
              <Actions state={state} onShowSteps={() => setSteps(true)} />
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** One quiet line for a project that has things but no AI conversation yet. */
export function SaveFromAiInvite({ children }: { children?: ReactNode }) {
  const state = useSaveFromAiState()
  return (
    <p className="flex flex-wrap items-center gap-x-1 gap-y-1 text-body-sm text-muted-foreground" data-capture-invite data-save-from-ai={state}>
      <span className="mr-1">No AI conversations yet</span>
      <Actions state={state} size="xs" quiet />
      {children}
    </p>
  )
}
