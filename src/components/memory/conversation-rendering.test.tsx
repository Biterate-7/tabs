import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { readConversationFromPage } from "../../../extension/src/ai-pages.js"
import { ConversationView } from "./conversation-view"
import { NoteDialog } from "./note-dialog"
import { SourceDetailsDialog } from "@/components/project/source-details-dialog"
import { readConversationCapture } from "@/lib/conversations/capture"
import { parseConversationExport } from "@/lib/conversations/exports"
import { parseConversationText } from "@/lib/conversations/parse-text"
import { planConversationSave } from "@/lib/conversations/save"
import { putContent, resetContentStoreForTests } from "@/lib/resources/content-store"
import type { ConversationInput } from "@/lib/conversations/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * A saved conversation's formulas, from every door into Hubble to the dialog
 * that shows them: the AI app's page (as Hubble for Chrome reads it), a
 * provider's export file, and a paste. The stored text is what each door
 * produced — the reader is the only thing that formats it — so these hold
 * conversations saved before the reader existed to the same result.
 */

const NOW = Date.UTC(2026, 9, 19)

/** KaTeX as the AI apps draw it: MathML carrying the TeX, then the glyphs, hidden from screen readers. */
const katex = (tex: string, glyphs: string, display = false) =>
  `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ""}><semantics><mrow><mi>${glyphs}</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">${glyphs}</span></span></span></span>`

const QUESTION = "Solve 3/2 θ = sin θ"
const ANSWER =
  `<p>Rewrite it as ${katex("\\frac{3}{2}\\theta - \\sin\\theta = 0", "32θ−sinθ=0")}, where ${katex("\\sin\\theta \\neq 0", "sinθ≠0")} unless θ = 0.</p>` +
  `<span class="katex-display">${katex("\\left|\\frac{2}{3}\\sin\\theta\\right| \\leq \\frac{2}{3}", "∣32sinθ∣≤32", true)}</span>` +
  `<span class="katex-display">${katex("\\boxed{\\theta = 0} \\quad \\text{is the only solution}", "θ=0 is the only solution", true)}</span>` +
  `<p>It costs nothing to check: $5 says it holds.</p>`

const PAGES: Record<string, { url: string; html: string }> = {
  chatgpt: {
    url: "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f",
    html: `<main><div data-message-author-role="user"><div class="whitespace-pre-wrap">${QUESTION}</div></div><div data-message-author-role="assistant"><div class="markdown">${ANSWER}</div></div></main>`,
  },
  claude: {
    url: "https://claude.ai/chat/446f8e09-fd3c-43b5-a8fa-5c5861dfb044",
    html: `<div data-testid="user-message"><p>${QUESTION}</p></div><div data-testid="assistant-message"><div data-perf-reply-text="">${ANSWER}</div></div>`,
  },
  gemini: {
    url: "https://gemini.google.com/app/ed0431c2728ddb16",
    html: `<user-query><div class="query-text"><p class="query-text-line">${QUESTION}</p></div></user-query><model-response><message-content><div class="markdown">${ANSWER}</div></message-content></model-response>`,
  },
  perplexity: {
    url: "https://www.perplexity.ai/search/07f15fc6-ef25-4f50-aa41-4a551474a5b0",
    html: `<div data-message-bubble="right"><p>${QUESTION}</p></div><div class="prose">${ANSWER}</div>`,
  },
}

function pageOf(html: string): Document {
  const doc = document.implementation.createHTMLDocument("Solve Trigonometric Equation")
  doc.body.innerHTML = html
  return doc
}

async function capture(provider: keyof typeof PAGES): Promise<ConversationInput> {
  const read = await readConversationFromPage(pageOf(PAGES[provider]!.html), PAGES[provider]!.url, 0)
  const checked = readConversationCapture(read)
  if (!checked.ok) throw new Error(`capture refused: ${checked.reason}`)
  return checked.conversation
}

/** What a person sees: KaTeX's hidden MathML copy of the TeX left out. */
function visible(element: Element): string {
  const copy = element.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll(".katex-mathml")) hidden.remove()
  return copy.textContent ?? ""
}

function typeset(element: Element): string[] {
  return [...element.querySelectorAll('.katex annotation[encoding="application/x-tex"]')].map((node) => node.textContent ?? "")
}

const EXPECTED = ["\\frac{3}{2}\\theta - \\sin\\theta = 0", "\\sin\\theta \\neq 0", "\\left|\\frac{2}{3}\\sin\\theta\\right| \\leq \\frac{2}{3}", "\\boxed{\\theta = 0} \\quad \\text{is the only solution}"]

function expectTypesetReply(view: HTMLElement) {
  const reply = view.querySelector('[data-role="assistant"]')!
  expect(typeset(reply)).toEqual(EXPECTED)
  expect(reply.querySelectorAll('[data-math="display"]')).toHaveLength(2)
  expect(reply.querySelectorAll("[data-math-error]")).toHaveLength(0)
  expect(visible(reply)).not.toMatch(/\\(frac|left|right|neq|leq|boxed|text|sin|theta)|\$\$/)
  // A price beside the formulas stays a price.
  expect(visible(reply)).toContain("It costs nothing to check: $5 says it holds.")
}

afterEach(() => resetContentStoreForTests())

describe("a conversation saved from each AI app's page", () => {
  it.each(Object.keys(PAGES))("%s: stores TeX between delimiters and shows typeset formulas", async (provider) => {
    const conversation = await capture(provider)
    // Stored as Hubble for Chrome wrote it — the reader never rewrites the text.
    expect(conversation.turns[1]!.text).toContain("$$\\boxed{\\theta = 0} \\quad \\text{is the only solution}$$")
    const { container } = render(<ConversationView turns={conversation.turns} provider={conversation.provider} />)
    expectTypesetReply(container)
    expect(container.querySelector('[data-role="user"]')!.textContent).toContain(QUESTION)
  })
})

describe("a conversation imported from an export file", () => {
  it("ChatGPT export: reads its \\( \\) and \\[ \\] delimiters", () => {
    const exported = [
      {
        title: "Solve Trigonometric Equation",
        conversation_id: "6720a1b2-1111-2222-3333-444455556666",
        current_node: "n2",
        mapping: {
          root: { message: null, parent: null },
          n1: { parent: "root", message: { author: { role: "user" }, content: { content_type: "text", parts: [QUESTION] } } },
          n2: {
            parent: "n1",
            message: {
              author: { role: "assistant" },
              content: {
                content_type: "text",
                parts: [
                  "Rewrite it as \\(\\frac{3}{2}\\theta - \\sin\\theta = 0\\), where \\(\\sin\\theta \\neq 0\\) unless θ = 0.\n\n\\[\n\\left|\\frac{2}{3}\\sin\\theta\\right| \\leq \\frac{2}{3}\n\\]\n\n\\[\n\\boxed{\\theta = 0} \\quad \\text{is the only solution}\n\\]\n\nIt costs nothing to check: $5 says it holds.",
                ],
              },
            },
          },
        },
      },
    ]
    const parsed = parseConversationExport(JSON.stringify(exported))
    if (!parsed.ok) throw new Error(parsed.reason)
    const { container } = render(<ConversationView turns={parsed.conversations[0]!.turns} provider="chatgpt" />)
    expectTypesetReply(container)
  })

  it("Claude export: reads $$ $$ written inline and on its own line", () => {
    const exported = [
      {
        uuid: "0b6f6d3e-aaaa-bbbb-cccc-111122223333",
        name: "Solve Trigonometric Equation",
        chat_messages: [
          { sender: "human", text: QUESTION },
          {
            sender: "assistant",
            content: [
              {
                type: "text",
                text: "Rewrite it as $\\frac{3}{2}\\theta - \\sin\\theta = 0$, where $\\sin\\theta \\neq 0$ unless θ = 0.\n\n$$\\left|\\frac{2}{3}\\sin\\theta\\right| \\leq \\frac{2}{3}$$\n\n$$\\boxed{\\theta = 0} \\quad \\text{is the only solution}$$\n\nIt costs nothing to check: $5 says it holds.",
              },
            ],
          },
        ],
      },
    ]
    const parsed = parseConversationExport(JSON.stringify(exported))
    if (!parsed.ok) throw new Error(parsed.reason)
    const { container } = render(<ConversationView turns={parsed.conversations[0]!.turns} provider="claude" />)
    expectTypesetReply(container)
  })
})

describe("a pasted conversation", () => {
  it("formats formulas in labelled turns, and in text kept as one block", () => {
    const pasted = parseConversationText("You: Solve $\\frac{3}{2}\\theta = \\sin\\theta$\n\nChatGPT: The only solution is\n\n$$\\boxed{\\theta = 0}$$")
    const { container } = render(<ConversationView turns={pasted.turns} provider="chatgpt" />)
    expect(typeset(container)).toEqual(["\\frac{3}{2}\\theta = \\sin\\theta", "\\boxed{\\theta = 0}"])

    const block = parseConversationText("Notes on $\\sin\\theta$:\n\n$$\\theta = 0$$")
    expect(block.structured).toBe(false)
    const { container: whole } = render(<ConversationView turns={block.turns} {...(block.text ? { text: block.text } : {})} />)
    expect(typeset(whole)).toEqual(["\\sin\\theta", "\\theta = 0"])
  })
})

describe("the dialogs a saved conversation opens in", () => {
  const store = { workspaces: [{ id: "w", name: "Maths", tabs: [], notes: [] }] } as unknown as WorkspaceStore

  it("the source's dialog — the 'Solve Trigonometric Equation' conversation saved with its address", async () => {
    const conversation = await capture("chatgpt")
    const plan = planConversationSave(store, "w", conversation, NOW, () => "n1")
    if (plan?.target !== "source") throw new Error("expected a source")
    await putContent("w", plan.tab.id, plan.content)
    const noop = vi.fn()
    render(
      <SourceDetailsDialog tab={plan.tab} workspaceId="w" onOpenChange={noop} onRename={noop} onRetry={noop} onOpen={noop} onAttachPdf={vi.fn(async () => {})} onAttachTranscript={vi.fn(async () => ({}))} />
    )
    const section = await screen.findByRole("region", { name: "The saved conversation" })
    await waitFor(() => expect(section.querySelector(".katex")).toBeTruthy())
    expectTypesetReply(section)
    // The dialog's own title and details are plain text, never formatted.
    expect(screen.getByRole("dialog").querySelector("h2")!.textContent).toBe("Solve Trigonometric Equation")
  })

  it("a note's dialog — a conversation saved without an address, and a note's own text", async () => {
    const parsed = parseConversationExport(
      JSON.stringify([{ uuid: "u1", name: "Trig", chat_messages: [{ sender: "human", text: QUESTION }, { sender: "assistant", text: "So $$\\boxed{\\theta = 0}$$ and $\\theta \\leq 1$." }] }])
    )
    if (!parsed.ok) throw new Error(parsed.reason)
    const conversation = { ...parsed.conversations[0]!, url: undefined } as ConversationInput
    const plan = planConversationSave(store, "w", conversation, NOW, () => "n1")
    if (plan?.target !== "note") throw new Error("expected a note")
    await putContent("w", plan.note.id, plan.content)
    const noop = vi.fn()
    const { unmount } = render(<NoteDialog note={plan.note} workspaceId="w" onOpenChange={noop} onUpdate={noop} onSaveText={vi.fn(async () => true)} onDelete={noop} />)
    const section = await screen.findByRole("region", { name: "The saved conversation" })
    await waitFor(() => expect(typeset(section)).toEqual(["\\boxed{\\theta = 0}", "\\theta \\leq 1"]))
    unmount()

    const note = { ...plan.note, id: "n2", kind: "excerpt" as const, contentHash: "h2" }
    await putContent("w", "n2", { kind: "note", text: "Kept: $$\\frac{3}{2}\\theta=\\sin\\theta$$", extractedAt: NOW })
    render(<NoteDialog note={note} workspaceId="w" onOpenChange={noop} onUpdate={noop} onSaveText={vi.fn(async () => true)} onDelete={noop} />)
    const text = await screen.findByRole("document", { name: "Note text" })
    await waitFor(() => expect(typeset(text)).toEqual(["\\frac{3}{2}\\theta=\\sin\\theta"]))
    // Editing still edits the words as written.
    screen.getByRole("button", { name: "Edit text" }).click()
    const editor = await screen.findByRole("textbox", { name: "Note text" })
    expect((editor as HTMLTextAreaElement).value).toBe("Kept: $$\\frac{3}{2}\\theta=\\sin\\theta$$")
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Save text" })).toBeTruthy()
  })
})
