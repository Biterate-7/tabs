"use client"

import { useMemo, useRef, useState } from "react"
import { Check, ClipboardCopy, Search } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Textarea } from "@/components/ui/textarea"
import { ProviderBadge } from "./provider-mark"
import { useProjectContents } from "@/hooks/use-project-contents"
import { buildMemoryBundle } from "@/lib/memory/bundle"
import { findKnowledgeItem, KNOWLEDGE_TYPE_LABEL, knowledgeItemsOf, refKey } from "@/lib/memory/items"
import { searchKnowledge } from "@/lib/memory/search"
import { subjectName } from "@/lib/product/subjects"
import { cn } from "@/lib/utils"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { Workspace } from "@/lib/workspace/types"

const LENGTHS = [
  { value: "short", label: "Short", budget: 5_000 },
  { value: "standard", label: "Standard", budget: 12_000 },
  { value: "long", label: "Long", budget: 30_000 },
] as const

type Length = (typeof LENGTHS)[number]["value"]

/** What copying did. "selected" means the browser refused the clipboard and the text is selected for the person to copy. */
type CopyState = { status: "idle" } | { status: "copied"; at: number } | { status: "selected" }

/**
 * "Use in an AI chat": choose what to bring from one project, see exactly
 * the text an AI app will receive, edit it, copy it.
 *
 * One project at a time, by design — context from one project never leaks
 * into another's conversation. The preview is the whole truth: what is in
 * the box is what the clipboard gets, and the dialog says that the AI app it
 * is pasted into receives it. Nothing is sent from here; Hubble for Chrome
 * can type the same context into an AI app's message box (never sending it).
 */
export function ReuseDialog({
  open,
  onOpenChange,
  workspace,
  initialRefs,
  onCopied,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: Workspace
  /** What was chosen where the dialog was opened from. Empty: the person picks here. */
  initialRefs: readonly KnowledgeItemRef[]
  onCopied?: (info: { items: number; chars: number }) => void
}) {
  const items = useMemo(() => {
    const listed = knowledgeItemsOf(workspace)
    // A saved tab chosen elsewhere that is not a source is offered too, by its title and link.
    const extra = initialRefs
      .filter((ref) => !listed.some((item) => refKey(item.ref) === refKey(ref)))
      .map((ref) => findKnowledgeItem(workspace, ref))
      .filter((item): item is KnowledgeItem => Boolean(item))
    return [...extra, ...listed]
  }, [workspace, initialRefs])

  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(initialRefs.map(refKey)))
  const [request, setRequest] = useState("")
  const [filter, setFilter] = useState("")
  const [length, setLength] = useState<Length>("standard")
  const [includeBrief, setIncludeBrief] = useState(true)
  const [draft, setDraft] = useState<string | null>(null)
  const [copy, setCopy] = useState<CopyState>({ status: "idle" })
  const previewRef = useRef<HTMLTextAreaElement>(null)

  const contents = useProjectContents(useMemo(() => (open ? [workspace] : []), [open, workspace]))
  const projectContents = contents.get(workspace.id)
  const loading = open && !projectContents

  const shown = useMemo(() => {
    if (filter.trim().length < 2) return items
    const hits = searchKnowledge({ query: filter, workspaces: [workspace], contents, limit: 200 })
    const keys = new Set(hits.map((hit) => refKey(hit.ref)))
    return items.filter((item) => keys.has(refKey(item.ref)) || chosen.has(refKey(item.ref)))
  }, [filter, items, workspace, contents, chosen])

  const refs = useMemo(() => items.filter((item) => chosen.has(refKey(item.ref))).map((item) => item.ref), [items, chosen])
  const budget = LENGTHS.find((entry) => entry.value === length)!.budget
  const bundle = useMemo(
    () => buildMemoryBundle({ workspace, refs, contents: projectContents ?? new Map(), request, includeBrief, budget }),
    [workspace, refs, projectContents, request, includeBrief, budget]
  )
  const text = draft ?? bundle.text
  const stale = draft !== null && draft !== bundle.text

  function toggle(item: KnowledgeItem) {
    setChosen((current) => {
      const next = new Set(current)
      const key = refKey(item.ref)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setCopy({ status: "idle" })
  }

  async function copyText() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard")
      await navigator.clipboard.writeText(text)
      setCopy({ status: "copied", at: Date.now() })
      onCopied?.({ items: refs.length, chars: text.length })
    } catch {
      // The browser refused: select the text so a keyboard copy works, and say exactly that.
      previewRef.current?.focus()
      previewRef.current?.select()
      setCopy({ status: "selected" })
    }
  }

  const name = subjectName(workspace)
  const nothingChosen = refs.length === 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setDraft(null)
          setCopy({ status: "idle" })
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl" data-reuse-dialog>
        <DialogHeader>
          <DialogTitle>Use in an AI chat</DialogTitle>
          <DialogDescription>
            Choose what to bring from {name}. You&apos;ll copy the text below and paste it into ChatGPT, Claude, Gemini or any AI app — that app receives exactly this text, nothing else.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 grid min-h-0 gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          {/* Choosing */}
          <div className="flex min-w-0 flex-col gap-2">
            <label className="flex flex-col gap-1 text-meta text-muted-foreground">
              What are you about to ask? <span className="text-tertiary">(optional — picks the most relevant parts)</span>
              <Input value={request} onChange={(event) => setRequest(event.target.value)} placeholder="e.g. Compare the causes of WW1 my chats came up with" maxLength={2000} />
            </label>
            <label className="relative">
              <span className="sr-only">Filter {name}</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
              <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`Find in ${name}…`} className="pl-7" />
            </label>
            <ul className="flex max-h-72 min-h-24 flex-col overflow-y-auto rounded-md border border-subtle" aria-label={`Items in ${name}`}>
              {shown.length === 0 ? (
                <li className="p-3 text-body-sm text-muted-foreground">{items.length === 0 ? `Nothing is saved in ${name} yet.` : "Nothing here matches."}</li>
              ) : (
                shown.map((item) => {
                  const key = refKey(item.ref)
                  const checked = chosen.has(key)
                  return (
                    <li key={key}>
                      <label className={cn("flex cursor-pointer items-start gap-2 px-2.5 py-2 hover:bg-surface-hover", checked && "bg-surface-selected")}>
                        <Checkbox className="mt-0.5" checked={checked} onCheckedChange={() => toggle(item)} aria-label={`Include ${item.title}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm text-foreground">{item.title}</span>
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-tertiary">
                            {item.provider ? <ProviderBadge provider={item.provider} /> : null}
                            <span>{KNOWLEDGE_TYPE_LABEL[item.type]}</span>
                            {!item.hasText && <span>link only</span>}
                          </span>
                        </span>
                      </label>
                    </li>
                  )
                })
              )}
            </ul>
            <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
              <SegmentedControl size="sm" value={length} onValueChange={setLength} options={LENGTHS.map(({ value, label }) => ({ value, label }))} />
              <label className="flex items-center gap-1.5">
                <Checkbox checked={includeBrief} onCheckedChange={(value) => setIncludeBrief(value === true)} />
                Project details
              </label>
            </div>
          </div>

          {/* The text, exactly as it will be pasted */}
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-meta text-muted-foreground">
                {nothingChosen ? "Choose what to include." : `${refs.length} item${refs.length === 1 ? "" : "s"} · ${text.length.toLocaleString()} characters`}
                {loading && " · loading…"}
              </span>
              {draft !== null && (
                <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>
                  {stale ? "Rebuild from selection" : "Undo my edits"}
                </Button>
              )}
            </div>
            <Textarea
              ref={previewRef}
              aria-label="Text to paste into an AI chat"
              className="max-h-[55dvh] min-h-72 flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed"
              value={nothingChosen && draft === null ? "" : text}
              onChange={(event) => {
                setDraft(event.target.value)
                setCopy({ status: "idle" })
              }}
              disabled={nothingChosen && draft === null}
            />
            <p className="text-meta text-tertiary" data-bundle-notes>
              {[
                bundle.omitted.missing > 0 ? `${bundle.omitted.missing} chosen item${bundle.omitted.missing === 1 ? " is" : "s are"} no longer in ${name}` : "",
                bundle.omitted.overBudget > 0 ? `${bundle.omitted.overBudget} named but not quoted, to stay ${length}` : "",
                bundle.omitted.noText > 0 ? `${bundle.omitted.noText} link${bundle.omitted.noText === 1 ? "" : "s"} without saved text` : "",
                bundle.providers.length > 1 ? "conversations from different AI apps are quoted separately" : "",
              ]
                .filter(Boolean)
                .join(" · ") || "Quoted text keeps where it came from. You can edit anything before copying."}
            </p>
          </div>
        </div>

        <DialogFooter className="items-center gap-3 sm:justify-between">
          <p role="status" className="text-meta text-muted-foreground">
            {copy.status === "copied"
              ? "Copied. Paste it into your AI chat — it hasn't been sent anywhere."
              : copy.status === "selected"
                ? "Your browser didn't allow copying. The text is selected — press Ctrl+C (⌘C on a Mac)."
                : "On ChatGPT, Claude, Gemini or Perplexity, Hubble for Chrome can also type this into the message box for you."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="button" onClick={() => void copyText()} disabled={text.trim().length === 0 || (nothingChosen && draft === null)}>
              {copy.status === "copied" ? <Check /> : <ClipboardCopy />} {copy.status === "copied" ? "Copied" : "Copy"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
