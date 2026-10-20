"use client"

import { useMemo, useRef, useState } from "react"
import { Check, ClipboardCopy, Download, Loader2, Search, Send } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Textarea } from "@/components/ui/textarea"
import { ProviderBadge, ProviderMark } from "./provider-mark"
import { useAiTransfer } from "@/hooks/use-ai-transfer"
import { useProjectContents } from "@/hooks/use-project-contents"
import { packageTransfer } from "@/lib/ai-transfer/package"
import { errorWords, stateWords } from "@/lib/ai-transfer/protocol"
import { findKnowledgeItem, KNOWLEDGE_TYPE_LABEL, knowledgeItemsOf, refKey } from "@/lib/memory/items"
import { searchKnowledge } from "@/lib/memory/search"
import { openExternal, saveFile } from "@/lib/platform"
import { subjectName } from "@/lib/product/subjects"
import { AI_PROVIDER_IDS, AI_PROVIDERS, isAiProviderId } from "@/lib/providers/registry"
import { getFile } from "@/lib/resources/content-store"
import { cn } from "@/lib/utils"
import type { ItemStrategy, TransferMode } from "@/lib/ai-transfer/package"
import type { KnowledgeItem, KnowledgeItemRef } from "@/lib/memory/items"
import type { AiProviderId } from "@/lib/providers/registry"
import type { Workspace } from "@/lib/workspace/types"

const LENGTHS = [
  { value: "short", label: "Short", budget: 5_000 },
  { value: "standard", label: "Standard", budget: 12_000 },
  { value: "long", label: "Long", budget: 30_000 },
] as const

type Length = (typeof LENGTHS)[number]["value"]

const MODES: { value: TransferMode; label: string }[] = [
  { value: "prepare", label: "Prepare message" },
  { value: "send", label: "Send automatically" },
]

const STRATEGY_WORDS: Record<ItemStrategy, string> = {
  attach: "attached as the file",
  text: "",
  link: "link only",
  unavailable: "no text",
}

/** The AI app last chosen here: a per-device convenience, never required. */
const PROVIDER_KEY = "hubble.useInAi.provider"

function rememberedProvider(): AiProviderId {
  try {
    const value = window.localStorage.getItem(PROVIDER_KEY)
    return isAiProviderId(value) ? value : "chatgpt"
  } catch {
    return "chatgpt"
  }
}

/** What copying (or the copy fallback) did. "selected": the browser refused the clipboard and the text is selected instead. */
type CopyState = { status: "idle" } | { status: "copied"; opened?: AiProviderId } | { status: "selected" }

/**
 * Use in AI: choose what to bring from one project, choose the AI app, add
 * instructions, see exactly the message it will receive — then Hubble for
 * Chrome opens a new chat there and puts it in (attaching uploaded files'
 * originals where the app takes them), or the person copies it.
 *
 * - One project at a time, by design — context from one project never leaks
 *   into another's conversation.
 * - The preview is the message, and editable. What is copied is what is in
 *   the box; what the extension types is what is in the box.
 * - Prepare message is the default and leaves the message for the person to
 *   send. Send automatically is chosen per transfer, never remembered.
 * - Without Hubble for Chrome (or in Hubble Desktop, which can't reach the
 *   browser) the same button copies the message and opens the app, and says
 *   that is what it did.
 */
export function ReuseDialog({
  open,
  onOpenChange,
  workspace,
  initialRefs,
  initialProvider,
  onCopied,
  onTransferred,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: Workspace
  /** What was chosen where the dialog was opened from. Empty: the person picks here. */
  initialRefs: readonly KnowledgeItemRef[]
  /** Start on this AI app instead of the last one used. */
  initialProvider?: AiProviderId
  onCopied?: (info: { items: number; chars: number }) => void
  /** A transfer reached the AI app's message box (and was sent, when `sent`). */
  onTransferred?: (info: { items: number; provider: AiProviderId; sent: boolean }) => void
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

  // Chosen keys in the order they were chosen: the message keeps that order within each of its sections.
  const [chosen, setChosen] = useState<readonly string[]>(() => [...new Set(initialRefs.map(refKey))])
  const [request, setRequest] = useState("")
  const [filter, setFilter] = useState("")
  const [length, setLength] = useState<Length>("standard")
  const [includeBrief, setIncludeBrief] = useState(true)
  const [provider, setProviderState] = useState<AiProviderId>(() => initialProvider ?? rememberedProvider())
  const [mode, setMode] = useState<TransferMode>("prepare")
  const [attachOriginals, setAttachOriginals] = useState(true)
  const [asFile, setAsFile] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [copy, setCopy] = useState<CopyState>({ status: "idle" })
  const previewRef = useRef<HTMLTextAreaElement>(null)
  const transfer = useAiTransfer(open)
  const support = transfer.support
  const canTransfer = support?.available === true
  const capabilities = AI_PROVIDERS[provider].capabilities

  const contents = useProjectContents(useMemo(() => (open ? [workspace] : []), [open, workspace]))
  const projectContents = contents.get(workspace.id)
  const loading = open && !projectContents

  const chosenSet = useMemo(() => new Set(chosen), [chosen])
  const shown = useMemo(() => {
    if (filter.trim().length < 2) return items
    const hits = searchKnowledge({ query: filter, workspaces: [workspace], contents, limit: 200 })
    const keys = new Set(hits.map((hit) => refKey(hit.ref)))
    return items.filter((item) => keys.has(refKey(item.ref)) || chosenSet.has(refKey(item.ref)))
  }, [filter, items, workspace, contents, chosenSet])

  const refs = useMemo(() => {
    const byKey = new Map(items.map((item) => [refKey(item.ref), item.ref]))
    return chosen.map((key) => byKey.get(key)).filter((ref): ref is KnowledgeItemRef => Boolean(ref))
  }, [items, chosen])
  const budget = LENGTHS.find((entry) => entry.value === length)!.budget
  // Originals travel only through Hubble for Chrome; copying always quotes the files' text.
  const attaching = canTransfer && attachOriginals && capabilities.attachFiles.supported
  const packageInput = useMemo(
    () => ({ workspace, refs, contents: projectContents ?? new Map(), provider, instructions: request, includeBrief, budget, attachOriginals: attaching, asFile: asFile && attaching }),
    [workspace, refs, projectContents, provider, request, includeBrief, budget, attaching, asFile]
  )
  const plan = useMemo(() => packageTransfer(packageInput), [packageInput])
  const bundle = plan.bundle
  const text = draft ?? plan.text
  const stale = draft !== null && draft !== plan.text
  const strategies = useMemo(() => new Map(plan.items.map((item) => [item.key, item])), [plan.items])
  const files = plan.items.filter((item) => item.fileName)
  const running = transfer.run.status === "running"
  const overLimit = draft === null ? plan.overLimit : draft.length > plan.limit

  function setProvider(next: AiProviderId) {
    setProviderState(next)
    setDraft(null)
    transfer.reset()
    try {
      window.localStorage.setItem(PROVIDER_KEY, next)
    } catch {
      // Not remembered on this device; chosen again next time.
    }
  }

  function changed() {
    setCopy({ status: "idle" })
    transfer.reset()
  }

  function toggle(item: KnowledgeItem) {
    const key = refKey(item.ref)
    setChosen((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]))
    changed()
  }

  async function writeClipboard(value: string): Promise<boolean> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard")
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // The browser refused: select the text so a keyboard copy works, and say exactly that.
      previewRef.current?.focus()
      previewRef.current?.select()
      setCopy({ status: "selected" })
      return false
    }
  }

  async function copyText() {
    if (await writeClipboard(text)) {
      setCopy({ status: "copied" })
      onCopied?.({ items: refs.length, chars: text.length })
    }
  }

  /** Without Hubble for Chrome: copy the message (files as text), then open the app for the person to paste. */
  async function copyAndOpen() {
    if (!(await writeClipboard(text))) return
    setCopy({ status: "copied", opened: provider })
    onCopied?.({ items: refs.length, chars: text.length })
    await openExternal(AI_PROVIDERS[provider].homeUrl).catch(() => undefined)
  }

  async function startTransfer() {
    const outcome = await transfer.start({
      workspaceId: workspace.id,
      provider,
      mode,
      plan,
      draft,
      replan: (missing) => packageTransfer({ ...packageInput, unavailableOriginals: missing }),
    })
    if (outcome.status === "done") onTransferred?.({ items: refs.length, provider, sent: outcome.result.state === "submitted" })
  }

  async function saveOriginal(noteId: string, name: string) {
    const stored = await getFile(workspace.id, noteId).catch(() => undefined)
    if (stored) await saveFile(name, new Uint8Array(stored.bytes), stored.type || "application/octet-stream").catch(() => false)
  }

  const name = subjectName(workspace)
  const providerName = AI_PROVIDERS[provider].name
  const nothingChosen = refs.length === 0
  const empty = text.trim().length === 0 || (nothingChosen && draft === null)
  const desktop = support?.available === false && support.reason === "desktop"

  // While Hubble looks for the extension (a moment), the button reads as it will with it, disabled.
  const primaryLabel = canTransfer || support === null ? (mode === "send" ? `Send to ${providerName}` : `Open in ${providerName}`) : `Copy & open ${providerName}`

  const savedFiles = files.filter((item) => item.ref.kind === "note")
  const offerSaves = copy.status === "copied" && copy.opened && savedFiles.length > 0

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
          <DialogTitle>Use in AI</DialogTitle>
          <DialogDescription>
            {canTransfer
              ? `Bring what you choose from ${name} into a new chat. Nothing is sent unless you choose Send automatically.`
              : `Copy what you choose from ${name} into any AI chat. The app receives only this text.`}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 grid min-h-0 gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          {/* Choosing */}
          <div className="flex min-w-0 flex-col gap-2">
            <label className="flex flex-col gap-1 text-meta text-muted-foreground">
              Instructions
              <Input
                value={request}
                onChange={(event) => {
                  setRequest(event.target.value)
                  changed()
                }}
                placeholder="Optional — e.g. Summarize these and find the key arguments"
                maxLength={2000}
              />
            </label>
            <label className="relative">
              <span className="sr-only">Filter {name}</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
              <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`Find in ${name}…`} className="pl-7" />
            </label>
            {shown.length > 1 && (
              <div className="-mb-1 flex items-center justify-between">
                <span className="text-meta text-tertiary">{refs.length > 0 ? `${refs.length} chosen` : "Choose what to include"}</span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    const keys = shown.map((item) => refKey(item.ref))
                    const all = keys.every((key) => chosenSet.has(key))
                    setChosen((current) => (all ? current.filter((key) => !keys.includes(key)) : [...current, ...keys.filter((key) => !current.includes(key))]))
                    changed()
                  }}
                >
                  {shown.every((item) => chosenSet.has(refKey(item.ref))) ? "Select none" : "Select all"}
                </Button>
              </div>
            )}
            <ul className="flex max-h-64 min-h-24 flex-col overflow-y-auto rounded-md border border-subtle" aria-label={`Items in ${name}`}>
              {shown.length === 0 ? (
                <li className="p-3 text-body-sm text-muted-foreground">{items.length === 0 ? `Nothing is saved in ${name} yet.` : "Nothing here matches."}</li>
              ) : (
                shown.map((item) => {
                  const key = refKey(item.ref)
                  const checked = chosenSet.has(key)
                  const planned = checked ? strategies.get(key) : undefined
                  const how = planned ? STRATEGY_WORDS[planned.strategy] : ""
                  return (
                    <li key={key}>
                      <label className={cn("flex cursor-pointer items-start gap-2 px-2.5 py-2 hover:bg-surface-hover", checked && "bg-surface-selected")}>
                        <Checkbox className="mt-0.5" checked={checked} onCheckedChange={() => toggle(item)} aria-label={`Include ${item.title}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body-sm text-foreground">{item.title}</span>
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-tertiary">
                            {item.provider ? <ProviderBadge provider={item.provider} /> : null}
                            <span>{KNOWLEDGE_TYPE_LABEL[item.type]}</span>
                            {how ? <span data-strategy={planned!.strategy}>{how}</span> : !item.hasText && <span>{item.fileName ? (item.status === "processing" ? "still reading" : "no text") : "link only"}</span>}
                            {planned?.privateLink && <span>private address</span>}
                          </span>
                        </span>
                      </label>
                    </li>
                  )
                })
              )}
            </ul>
            <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
              <SegmentedControl
                size="sm"
                label="Length"
                value={length}
                onValueChange={(next) => {
                  setLength(next)
                  changed()
                }}
                options={LENGTHS.map(({ value, label }) => ({ value, label }))}
              />
              <label className="flex items-center gap-1.5">
                <Checkbox
                  checked={includeBrief}
                  onCheckedChange={(value) => {
                    setIncludeBrief(value === true)
                    changed()
                  }}
                />
                Project details
              </label>
              {canTransfer && capabilities.attachFiles.supported && files.length > 0 && (
                <label className="flex items-center gap-1.5">
                  <Checkbox
                    checked={attachOriginals}
                    onCheckedChange={(value) => {
                      setAttachOriginals(value === true)
                      setDraft(null)
                      changed()
                    }}
                  />
                  Attach original files
                </label>
              )}
            </div>
          </div>

          {/* The message, exactly as the AI app will receive it */}
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-meta text-muted-foreground">
                {nothingChosen ? "Nothing chosen" : `${refs.length} item${refs.length === 1 ? "" : "s"} · ${text.length.toLocaleString()} characters`}
                {plan.attachments.length > 0 && ` · ${plan.attachments.length} file${plan.attachments.length === 1 ? "" : "s"} attached`}
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
              aria-label="Message for the AI app"
              className="max-h-[50dvh] min-h-64 flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed"
              value={nothingChosen && draft === null ? "" : text}
              onChange={(event) => {
                setDraft(event.target.value)
                changed()
              }}
              disabled={nothingChosen && draft === null}
            />
            <p className="text-meta text-tertiary" data-bundle-notes>
              {[
                bundle.omitted.missing > 0 ? `${bundle.omitted.missing} chosen item${bundle.omitted.missing === 1 ? " is" : "s are"} no longer in ${name}` : "",
                bundle.omitted.overBudget > 0 ? `${bundle.omitted.overBudget} named but not quoted, to stay ${length}` : "",
                bundle.omitted.noText > 0 ? `${bundle.omitted.noText} without saved text` : "",
                bundle.providers.length > 1 ? "conversations from different AI apps are quoted separately" : "",
                ...plan.items.filter((item) => item.notAttachedBecause && item.strategy !== "attach" && attaching).map((item) => `${item.fileName} goes as text: ${item.notAttachedBecause}`),
                plan.items.some((item) => item.privateLink) ? `${providerName} can't open private addresses` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {overLimit && !empty && (
              <p className="text-meta text-warning" role="note" data-over-limit>
                {`That's more than Hubble puts into ${providerName} at once (${plan.limit.toLocaleString()} characters). Choose a shorter length or fewer items`}
                {attaching && !asFile ? (
                  <>
                    {", or "}
                    <button type="button" className="underline underline-offset-2" onClick={() => setAsFile(true)}>
                      send the context as a file
                    </button>
                  </>
                ) : (
                  ", or copy it"
                )}
                .
              </p>
            )}
            {asFile && attaching && (
              <p className="text-meta text-tertiary">
                The context goes as the attached file “{plan.attachments[0]?.name}”.{" "}
                <button type="button" className="underline underline-offset-2" onClick={() => setAsFile(false)}>
                  Put it in the message instead
                </button>
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-subtle pt-3">
          <div role="radiogroup" aria-label="AI app" className="flex flex-wrap gap-1">
            {AI_PROVIDER_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={provider === id}
                disabled={running}
                onClick={() => setProvider(id)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-body-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60",
                  provider === id ? "border-foreground/40 bg-surface-selected text-foreground" : "border-subtle text-muted-foreground hover:bg-surface-hover"
                )}
              >
                <ProviderMark provider={id} size={14} />
                {AI_PROVIDERS[id].name}
              </button>
            ))}
          </div>
          {canTransfer && (
            <SegmentedControl
              size="sm"
              label="When it's ready"
              value={mode}
              onValueChange={(next) => {
                setMode(next)
                transfer.reset()
              }}
              options={MODES}
            />
          )}
        </div>

        <DialogFooter className="items-center gap-3 sm:justify-between">
          <div role="status" className="flex min-w-0 flex-col gap-1 text-meta text-muted-foreground" data-transfer-status>
            <TransferStatus
              run={transfer.run}
              provider={provider}
              copy={copy}
              support={support}
              desktop={desktop}
              onRetry={() => void startTransfer()}
              onCopy={() => void copyText()}
            />
            {offerSaves && (
              <span className="flex flex-wrap items-center gap-1">
                Its files are in the message as text. To attach the originals yourself, save them:
                {savedFiles.map((item) => (
                  <Button key={item.key} type="button" size="xs" variant="ghost" onClick={() => void saveOriginal((item.ref as { noteId: string }).noteId, item.fileName!)}>
                    <Download /> {item.fileName}
                  </Button>
                ))}
              </span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="button" variant="secondary" onClick={() => void copyText()} disabled={empty || running}>
              {copy.status === "copied" && !copy.opened ? <Check /> : <ClipboardCopy />} Copy
            </Button>
            <Button
              type="button"
              onClick={() => void (canTransfer ? startTransfer() : copyAndOpen())}
              disabled={empty || running || support === null || (canTransfer && overLimit)}
              data-transfer-action
            >
              {running ? <Loader2 className="animate-spin" aria-hidden /> : <Send />} {primaryLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TransferStatus({
  run,
  provider,
  copy,
  support,
  desktop,
  onRetry,
  onCopy,
}: {
  run: ReturnType<typeof useAiTransfer>["run"]
  provider: AiProviderId
  copy: CopyState
  support: ReturnType<typeof useAiTransfer>["support"]
  desktop: boolean
  onRetry: () => void
  onCopy: () => void
}) {
  const providerName = AI_PROVIDERS[provider].name
  if (run.status === "running") {
    return (
      <span className="flex items-center gap-1.5">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> {stateWords(run.state, provider)}
      </span>
    )
  }
  if (run.status === "done") {
    const { result } = run
    return (
      <>
        <span className="text-foreground">{stateWords(result.state, provider)}</span>
        {result.attached.length > 0 && <span>Attached {result.attached.join(", ")}.</span>}
        {result.notAttached.length > 0 && (
          <span>
            {result.notAttached.map((file) => `${file.name}: ${file.reason}`).join("; ")}
            {result.usedFallback ? " — so the files' text was put in the message instead." : "."}
          </span>
        )}
        {result.submitProblem && <span>Not sent: {result.submitProblem}. Review it there and send it yourself.</span>}
      </>
    )
  }
  if (run.status === "failed") {
    return (
      <>
        <span className="text-destructive">{errorWords(run.error, provider)}</span>
        {run.notAttached && run.notAttached.length > 0 && <span>{run.notAttached.map((file) => `${file.name}: ${file.reason}`).join("; ")}.</span>}
        <span className="flex gap-1">
          {run.error !== "already-running" && (
            <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
              Try again
            </Button>
          )}
          <Button type="button" size="xs" variant="ghost" onClick={onCopy}>
            Copy instead
          </Button>
        </span>
      </>
    )
  }
  if (copy.status === "copied") {
    return copy.opened ? (
      <span>
        Copied, and {providerName} opened {desktop ? "in your browser" : "in a new tab"} — paste it into the message box. Nothing was sent.
      </span>
    ) : (
      <span>Copied — nothing was sent.</span>
    )
  }
  if (copy.status === "selected") return <span>Copying was blocked. The text is selected — press Ctrl+C (⌘C on a Mac).</span>
  if (support?.available === false) {
    return (
      <span>
        {support.reason === "desktop"
          ? "Hubble Desktop can't type into your browser, so it copies the message and opens the app for you to paste."
          : errorWords(support.reason, provider)}
      </span>
    )
  }
  return null
}
