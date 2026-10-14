"use client"

import { useEffect, useState } from "react"
import { AppWindow, ChevronDown, ClipboardPaste, FileUp, Link2, Loader2, NotebookPen, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { sendBrowserCommand } from "@/lib/browser/bridge"
import { isSafeOpenUrl } from "@/lib/browser/protocol"
import { getExtensionInstallInfo, EXTENSION_DOWNLOAD_URL } from "@/lib/extension-config"
import { inputsFromText } from "./add-source-dialog"
import type { BrowserTabInfo } from "@/lib/browser/protocol"
import type { IngestOutcome } from "@/lib/resources/ingest"
import type { ResourceInput } from "@/lib/resources/types"
import type { CaptureMode } from "@/components/memory/capture-dialog"

/** "Alt+Shift+H" as Chrome reports it → "Alt + Shift + H". */
function formatKeys(shortcut: string): string {
  return shortcut
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean)
    .join(" + ")
}

/**
 * + Add — the one way in to a project.
 *
 *     + Add ▾
 *       Paste a conversation      (from any AI app)
 *       Write a note
 *       Import a file             (a ChatGPT or Claude export, Markdown, text)
 *       ─────
 *       Browser tabs
 *       Link
 *
 * Links and tabs go through the same ingestion as everything else (the
 * shell's handleAddSources): the same duplicate rule, the same reading in
 * the background, the same toast with Undo. Conversations and notes go
 * through the capture dialog and the one conversation save
 * (lib/conversations/save.ts). Saving the open conversation in an AI app is
 * Hubble for Chrome's job, from that page. Dragging a link or the address bar
 * onto the page still works too; it just isn't something anyone has to read
 * about first.
 */
export function AddMenu({
  subjectName,
  onAdd,
  onOpenLink,
  onCapture,
  quickAdd,
  size = "lg",
  variant = "default",
}: {
  subjectName: string
  onAdd: (inputs: ResourceInput[]) => IngestOutcome[]
  /** Opens the paste-a-link dialog (owned by the subject page, which also opens it from elsewhere). */
  onOpenLink: () => void
  /** Opens the capture dialog (paste a conversation, write a note, import a file). Absent: those entries are not offered. */
  onCapture?: (mode: CaptureMode) => void
  /** Present once Hubble for Chrome has said it is here (see use-extension-quick-add). */
  quickAdd?: { shortcut: string }
  size?: "sm" | "default" | "lg"
  variant?: "default" | "secondary" | "outline"
}) {
  const [tabsOpen, setTabsOpen] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" size={size} variant={variant} data-add-menu>
              <Plus /> Add <ChevronDown className="opacity-60" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-52">
          {onCapture && (
            <>
              <DropdownMenuItem onClick={() => onCapture("conversation")}>
                <ClipboardPaste /> Paste a conversation
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCapture("note")}>
                <NotebookPen /> Write a note
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCapture("import")}>
                <FileUp /> Import a file
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => setTabsOpen(true)}>
            <AppWindow /> Browser tabs
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenLink}>
            <Link2 /> Link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {tabsOpen && <BrowserTabsDialog subjectName={subjectName} onAdd={onAdd} quickAdd={quickAdd} onClose={() => setTabsOpen(false)} onOpenLink={onOpenLink} />}
    </>
  )
}

type Loaded = { kind: "loading" } | { kind: "tabs"; tabs: BrowserTabInfo[] } | { kind: "unavailable" }

/**
 * Browser tabs: the tabs open in Chrome, ticked to add.
 *
 * Read through Hubble for Chrome's existing `list_browser_tabs` command —
 * the same bridge "open tab" and title lookup use. Hubble's own tabs and
 * anything that is not a web page are left out. With no extension to ask
 * (not installed, or Hubble Desktop, which Chrome reaches the other way), it
 * says how tabs get here from Chrome instead, in one line, with a paste box
 * underneath for anything already copied.
 */
function BrowserTabsDialog({
  subjectName,
  onAdd,
  quickAdd,
  onClose,
  onOpenLink,
}: {
  subjectName: string
  onAdd: (inputs: ResourceInput[]) => IngestOutcome[]
  quickAdd?: { shortcut: string }
  onClose: () => void
  onOpenLink: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" })
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [pasted, setPasted] = useState("")

  useEffect(() => {
    let alive = true
    void sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs: 2500 }).then((result) => {
      if (!alive) return
      if (!result.ok) {
        setLoaded({ kind: "unavailable" })
        return
      }
      const here = typeof window !== "undefined" ? window.location.origin : ""
      const seen = new Set<string>()
      const tabs = result.result.tabs.filter((tab) => {
        if (!isSafeOpenUrl(tab.url) || (here && tab.url.startsWith(here)) || seen.has(tab.url)) return false
        seen.add(tab.url)
        return true
      })
      setLoaded({ kind: "tabs", tabs })
    })
    return () => {
      alive = false
    }
  }, [])

  function addChosen() {
    if (loaded.kind !== "tabs") return
    const inputs = loaded.tabs
      .filter((tab) => chosen.has(tab.tabId))
      .map((tab) => ({ url: tab.url, ...(tab.title ? { title: tab.title } : {}), ...(tab.favIconUrl ? { favicon: tab.favIconUrl } : {}) }))
    if (inputs.length > 0) onAdd(inputs)
    onClose()
  }

  function addPasted() {
    const inputs = inputsFromText(pasted)
    if (inputs.length > 0) onAdd(inputs)
    onClose()
  }

  const install = getExtensionInstallInfo()
  const allChosen = loaded.kind === "tabs" && loaded.tabs.length > 0 && chosen.size === loaded.tabs.length

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add browser tabs</DialogTitle>
        </DialogHeader>

        {loaded.kind === "loading" && (
          <p className="mt-4 flex items-center gap-2 text-body-sm text-tertiary">
            <Loader2 aria-hidden className="size-3.5 animate-spin" /> Looking for your tabs…
          </p>
        )}

        {loaded.kind === "tabs" &&
          (loaded.tabs.length === 0 ? (
            <p className="mt-4 text-body-sm text-muted-foreground">No web pages are open in Chrome.</p>
          ) : (
            <>
              <div className="mt-3 flex items-center justify-between">
                <p className="text-meta text-tertiary">{chosen.size > 0 ? `${chosen.size} selected` : "Choose what to add"}</p>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setChosen(allChosen ? new Set() : new Set(loaded.tabs.map((tab) => tab.tabId)))}
                >
                  {allChosen ? "Select none" : "Select all"}
                </Button>
              </div>
              <ul className="mt-1 flex max-h-80 flex-col overflow-y-auto rounded-md border border-subtle" aria-label="Open tabs">
                {loaded.tabs.map((tab) => {
                  let domain = ""
                  try {
                    domain = new URL(tab.url).hostname
                  } catch {
                    domain = tab.url
                  }
                  const checked = chosen.has(tab.tabId)
                  return (
                    <li key={tab.tabId}>
                      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-surface-hover">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() =>
                            setChosen((current) => {
                              const next = new Set(current)
                              if (next.has(tab.tabId)) next.delete(tab.tabId)
                              else next.add(tab.tabId)
                              return next
                            })
                          }
                        />
                        <TabFavicon domain={domain} icon={tab.favIconUrl} size={16} />
                        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{tab.title || domain}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </>
          ))}

        {loaded.kind === "unavailable" && (
          <div className="mt-4 flex flex-col gap-3">
            {quickAdd ? (
              <p className="text-body-sm text-foreground">
                In Chrome, right-click a tab → <span className="font-medium">Add to {subjectName}</span>
                {quickAdd.shortcut && (
                  <span className="ml-2 text-meta text-tertiary">
                    or <Kbd>{formatKeys(quickAdd.shortcut)}</Kbd>
                  </span>
                )}
              </p>
            ) : (
              <p className="text-body-sm text-foreground">
                Add tabs straight from Chrome with{" "}
                {install.mode === "store" ? (
                  <a className="text-link hover:underline" href={install.url} target="_blank" rel="noreferrer">
                    Hubble for Chrome
                  </a>
                ) : (
                  <a className="text-link hover:underline" href={EXTENSION_DOWNLOAD_URL} download>
                    Hubble for Chrome
                  </a>
                )}
                .
              </p>
            )}
            <label className="text-meta text-muted-foreground">
              Or paste links
              <Textarea
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                placeholder={"https://…\nhttps://…"}
                className="mt-1 min-h-24 text-body-sm"
              />
            </label>
          </div>
        )}

        <DialogFooter>
          {loaded.kind === "tabs" && loaded.tabs.length > 0 ? (
            <Button type="button" size="lg" disabled={chosen.size === 0} onClick={addChosen}>
              Add {chosen.size > 1 ? `${chosen.size} tabs` : "tab"}
            </Button>
          ) : loaded.kind === "unavailable" ? (
            <Button type="button" size="lg" disabled={inputsFromText(pasted).length === 0} onClick={addPasted}>
              Add
            </Button>
          ) : loaded.kind === "tabs" ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                onClose()
                onOpenLink()
              }}
            >
              Add a link instead
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
