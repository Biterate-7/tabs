# Conversation intelligence

Hubble understands the AI conversations a person saved — what they decided,
what an AI only suggested, what is still open, and how conversations in
different AI apps are about the same work — rather than only knowing which AI
sites they visited.

```
saved conversation ──► ConversationRecord ──► ConversationExtraction ──► ConversationIndex ──► views
(cross-ai-memory.md:     canonical.ts           extract.ts                corpus.ts               Conversations,
 Tab.resource / note,    ids, order, hashes,    topics, entities,         threads, entities,      Graph (inferred
 turns in IndexedDB)     content types          intent, decisions,        contradictions,         edges), Settings
                                                tasks, knowledge,         memory, insights;
                                                open questions            retrieve.ts, context.ts
```

It extends what exists — it is not a second store or a second ingestion
path. Capture, storage, sync and search are described in
[cross-ai-memory.md](./cross-ai-memory.md); this document covers what is
built on top.

## 1. Architecture map (audit, 2026-10-30)

| Spec area | What already existed | What this adds |
|---|---|---|
| Ingestion | Extension DOM readers per provider (`extension/src/ai-pages.js`), export parsers (`lib/conversations/exports.ts`), one save (`lib/conversations/save.ts`) keyed by `sourceKey`, re-save = unchanged / kept / updated, durable capture queue with retries, `captureId` idempotency | Nothing new in the extension. Message-level diff (`diffMessages`) for "new vs edited" on re-save |
| Canonical model | `Tab.resource` (kind `conversation`, meta: provider, conversationId, contentHash, turnCount, capture, provider times) + `ResourceContent.turns` in IndexedDB, account-partitioned | `ConversationRecord`/`ConversationMessage` — a *view* (never stored): stable message ids, per-message hash, content types (code, math, table, list, link) and named unavailable content (images, attachments) |
| Intelligence System | Context intelligence (`lib/intelligence`) works on *browsing activity* topic words; workspace topics/insight (`lib/knowledge/workspace`) work on tab titles | Extraction from conversation *content*, reusing `textTerms`/`topicStem` so a "word" means the same thing everywhere |
| World Model / graph | Knowledge Graph (`lib/knowledge-graph`) with edges proven from records; galaxy renderer | One inferred edge kind, `related`, with evidence; never used for layout; drawn only around the focused node |
| Memory | Memory items, cross-project search, context bundle (`lib/memory`) | Derived memory categories (working, project, long-term, episodic) with relevance, recency, provenance, conflict flags |
| Retrieval | Term search over turns (`lib/memory/search.ts`) | Question parsing (app, time, project, focus) + ranked, attributed answers; thread expansion; entity-resolved names |
| Privacy | Local-first; content device-local; `SCOPED_STORAGE_KEYS` per account; text treated as data | Derived data never persisted; corrections stored under a new scoped key and pruned with their conversations |
| Server / DB | Postgres for auth/sync/integrations; sync carries no conversation text | **No schema or migration.** Nothing server-side |

## 2. Where things live

| Piece | File |
|---|---|
| Types (records, facts, threads, memory, insights) | `src/lib/conversations/intelligence/types.ts` |
| Canonical records from saved items | `canonical.ts` (`conversationRecordsOf`, `messagesOf`, `diffMessages`) |
| Entity lexicon (aliases, ambiguous words) | `lexicon.ts` |
| Per-conversation extraction | `extract.ts` (`extractConversation`, `attributionLabel`) |
| Cross-conversation index | `corpus.ts` (`buildConversationIndex`, `resolveEntities`) |
| Questions → answers | `retrieve.ts` (`parseQuery`, `answerQuery`, `relevantConversations`) |
| Thread write-up for an AI chat | `context.ts` (`threadContext`) |
| The person's settings and corrections | `settings.ts` (`tabdump:conversation-intelligence:v1`, scoped) |
| Background processing, cache, two-stage index | `src/hooks/use-conversation-intelligence.ts` |
| On-device cache of derived data (extractions, vectors) | `store.ts` (IndexedDB `hubble-intelligence`) |
| Meaning: chunks, vectors, neighbours | `semantic.ts` (pure), `embedding.worker.ts` (model), `semantic-client.ts` (page side) |
| "Why are these related?" — closest messages | `explain.ts` |
| Checking links on real history | `review.ts`, `src/components/conversations/link-review.tsx` |
| Benchmarks (not in the normal suite) | `bench/*.perf.ts`, `vitest.perf.config.mts` |
| UI | `src/components/conversations/*`, sidebar **Conversations**, ⌘K "Go to Conversations", Settings → **Conversations** |
| Graph | `ConversationAwareGraph` → `KnowledgeGraphView` `conversationLinks`; `build.ts`, `layout.ts`, `renderer.ts` |

## 3. Extraction rules

Speaker = the turn's role as the page/export recorded it. Text that *claims*
a speaker ("User: I decided…" inside an AI reply) changes nothing.

| Kind | Status | Needs |
|---|---|---|
| decision | `decided` | the person's words: "let's use", "I'll go with", "we decided", "I chose" (not a question) |
| | `accepted` | an AI suggestion, then the person's next message agrees ("yes", "let's do that", "go with option 2"). With several suggestions, only an option number or a unique word overlap picks one — "yes" to three ideas accepts none |
| | `suggested` | the AI recommended it — never more, whatever the wording |
| | `considered` | the person weighed it ("I'm thinking about…", "should I…?") and never settled it in that conversation |
| | `rejected` | "let's not…", "no, …" to a suggestion |
| task | `committed` / `suggested` / `done` | "I need to…/I'll add…" vs the AI's "Next steps"; done when the same or a later related conversation says so |
| knowledge | `confirmed` / `unconfirmed` | a fix the person said worked; a finding in their words; an AI explanation (unconfirmed) |
| question | `unresolved` | asked last with no reply, or "still not working" with nothing later saying it worked, or explicitly left open. Asking a question is not leaving it open |

Every fact carries evidence (message index, role, quote), a confidence from
the pattern that found it (not a probability), and an id stable for the same
statement in the same conversation. Bounds: 20k characters a message, 300k a
conversation; past that the extraction says it was cut.

Intent is scored over all of the person's turns (the first weighted double),
plus structure (code, named technologies, decisions) — no single keyword
decides it; below a threshold no intent is claimed.

## 4. Across conversations

- **Same conversation in two projects** is one conversation (same
  `identity`); the fullest copy speaks for it.
- **Evidence for a pair** (each kept on the relation, with every reason in
  words):
  - *words* — tf-idf cosine over topic words + idf-weighted shared names,
    gated on two shared words, or one word and one name. AI-app names and
    big organisations never count;
  - *meaning* — cosine of the two conversations' embeddings, when the
    person turned "Compare by meaning" on (§9);
  - *project* — the same Hubble project, projects whose names share a word
    ("Hubble web" / "Hubble desktop"), or a project both name;
  - *time* — how far apart they happened (ordering only).
- **Levels**, strongest first: *same problem* (only these form threads),
  *same project*, *related topic*, *shared name only* (shown, never drawn on
  the graph, never threaded). With meaning available, only closeness in
  meaning (≥ 0.42) makes two conversations the same problem — shared words
  make them related; words far apart in meaning (< 0.15) are vetoed as
  coincidence ("python" the snake and the language). Across two projects
  known to be different, only meaning ≥ 0.55 can claim the same problem;
  otherwise it is a related topic.
- **The person's word wins**: "not related" is final; "yes, related" (or a
  review answer) keeps the pair at the level they gave.
- **Bounded**: each conversation keeps its 12 strongest relations.
- **Threads**: average-linkage grouping of same-problem pairs; capped at 20.
- **Entity resolution**: lexicon ids are exact; free-text names merge only
  when equal after case, punctuation, a plural "s" or a trailing
  app/project/service — "Hubble app" = "Hubble", never "Auth" = "Author".
- **Decisions over time** — only within the same work (one conversation,
  project, thread, or a same-problem / same-project relation); two projects
  that choose differently are never a contradiction:
  - *changed decision* — the person settled on one thing, then another (or
    said "instead of"): the earlier is kept, marked `supersededBy` the
    later, and ranked below it in memory;
  - *rejected suggestion* — an AI recommended something and later the
    person turned it down or settled on something else;
  - *providers disagree* — two AI apps recommended different things and the
    person hasn't settled it: nothing is marked current.
- **Memory**: working (open commitments and questions, 7-day half-life,
  revalidate after 14 days), project (settled decisions, confirmed knowledge,
  90-day half-life), long-term (confirmed in ≥2 conversations; names in ≥3),
  episodic (changes of direction, cross-app work). AI suggestions are never
  memory.
- **Insights** (max 8, ≤3 per kind, confidence ≥ 0.5, dismissible): related
  work across apps/projects, a later decision that conflicts, a commitment
  older than 3 days not reported done, open questions in a thread, a week's
  progress. Each says why, names its sources and suggests — never performs —
  an action.

Thresholds were calibrated on hand-written labelled conversations
(`__fixtures__/relatedness-eval.ts`) and checked on a second set written
afterwards (`relatedness-holdout.ts`) — not on a person's real history (§10).

## 5. Retrieval

`parseQuery` reads an app ("Claude", "GPT"), "… later discussed with
ChatGPT", time ("yesterday", "last week" = the previous Monday–Sunday, "last
30 days"), a project's name, and the focus (decisions, open questions, tasks,
accomplished, suggestions). `answerQuery` ranks by title/topic/tf-idf terms
and resolved names, pulls in thread-mates of the top matches (marked "same
thread as …"), returns the best-matching message as evidence, and answers
"Nothing in your N analysed conversations … answers this" rather than the
nearest thing. Per-index work (document frequencies, thread lookup) is done
once per index; a "later discussed with" query checks suggestions newest
first and stops once an answer is full. Question answering is still by
words and names — meaning is used for relations, not yet for questions.

## 6. Privacy, security, deletion

- Analysis runs on this device. No conversation text is sent to any AI app
  or server; no new route exists. The extension and its permissions are
  unchanged. With "Compare by meaning" on, the one network request is the
  model itself (huggingface.co and its CDN, once, then the browser cache);
  the ONNX runtime and the worker are served by Hubble (`public/ort`,
  `public/workers`, generated on dev/build) — no third-party code runs.
- Derived data (extractions, vectors) is cached in IndexedDB
  `hubble-intelligence`, keyed exactly like the text in the content store
  (`<account>|<project>|<item>`). The content store's own deletion paths
  (`deleteContent`, `pruneContentExcept`) delete it with the text, from any
  screen; leaving a conversation out of analysis deletes its derived data;
  Settings → Conversations shows what is kept and deletes the vectors. The
  index itself is never stored. `pruneSettings` removes every correction,
  exclusion, related / not-related pair, review answer and dismissed insight
  that named a deleted conversation.
- Settings are scoped per account (`SCOPED_STORAGE_KEYS`) and re-read
  strictly; a test proves two accounts never see each other's.
- Imported text is untrusted: extraction is fixed patterns, never execution;
  UI renders it as text; `threadContext` quotes every line with `>`,
  scrubs secret shapes, redacts addresses and frames the whole as reference,
  not instructions (tested with an injection attempt).

## 7. Providers

| | Capture | History import | Automatic sync |
|---|---|---|---|
| ChatGPT | page (extension) | `conversations.json` export | no |
| Claude | page (extension) | `conversations.json` export | no |
| Gemini | page (extension) | none (Takeout is activity, not conversations) | no |
| Perplexity | page (extension) | none (per-thread Markdown only) | no |
| Grok | **not supported** — no grok.com reader, xAI export unverified | — | no |

No provider offers an API for a person's conversation history that Hubble can
use; an API key gives access to new completions, not the account's chats.
"Incremental sync" therefore means: saving a conversation again updates the
saved copy (`updated`), never shrinks it (`kept`), and re-analysis happens
only for the changed fingerprint.

## 8. Processing only what changed

- Each extraction is cached with its record's fingerprint (title + every
  message's role and text hash) and the extractor version
  (`EXTRACTOR_VERSION`, now 2): an unchanged conversation is read from the
  cache; a changed one, or one read by an older extractor, is analysed again
  (a whole conversation — acceptance and question resolution span messages,
  so per-message extraction would be wrong).
- Embedding is per chunk: a conversation saved again with one new message
  embeds that message's chunk (and the gist), and reuses the rest.
- Neighbours update incrementally: a changed conversation recomputes its own
  row; the result equals a full rebuild (tested).
- The index is two stages: the corpus (relations, threads) is rebuilt when
  conversations, their analysis, or which ones are in change; facts, memory
  and insights are re-derived on every correction without re-scoring a pair.
  The graph's inferred edges depend on the corpus only.
- Corrections are keyed by fact id (`<record>:<kind>:<hash of the
  statement>`), which a re-analysis reproduces, so they survive it (tested).
- Not incremental: the corpus stage itself (any change rebuilds it) and the
  first neighbour search after the model has embedded everything.

## 9. Compare by meaning (opt-in)

Settings → Conversations → **Compare by meaning** (off by default). A worker
runs `Xenova/all-MiniLM-L6-v2` (int8 ONNX, 384 dims, ≈23 MB, via
transformers.js on the WASM backend, single-threaded unless the page is
cross-origin isolated). Each conversation is a gist (title + the person's
words) plus up to 9 prose windows (code removed); the conversation vector is
half gist, half the mean of the windows. Vectors are kept as int8.

Unavailable — and Hubble says so and links by words — where workers or
WebAssembly can't run, and in the desktop app: its CSP allows neither the
model host nor `wasm-unsafe-eval`, and that was left unchanged.

## 10. Measured (2026-11-01)

Quality, with the real model in Node, on hand-labelled sets written for the
purpose (`bench/quality.perf.ts`). "Related" = should be linked at all;
"same problem" = should be one thread.

| Set | Method | Related P / R / FPR | Same problem P / R / FPR |
|---|---|---|---|
| calibration (26 conv., 325 pairs) | words only (phase 1) | 0.80 / 0.13 / 0.003 | 0.14 / 0.13 / 0.019 |
| | hybrid | 1.00 / 0.50 / 0 | 1.00 / 0.63 / 0 |
| holdout (13 conv., 78 pairs, thresholds frozen) | words only | — / 0 / 0 | — / 0 / 0 |
| | hybrid | 0.75 / 0.67 / 0.029 | 0.50 / 0.67 / 0.027 |

The calibration figures are optimistic (thresholds were read off that set).
The holdout is the honest estimate; its errors: "coffee pod machine" linked
to "Kubernetes pods" (meaning 0.39), and a Grafana memory dashboard threaded
with the out-of-memory conversations. Small sets: direction, not a guarantee.

Scale, generated corpora (`bench/scale.perf.ts`, Node on the dev machine;
a browser is slower). Baseline = phase 1 engine, same harness.

| Conversations | Index build | One conversation changed | A correction | Query p50 / p95 | Relations | Index heap |
|---|---|---|---|---|---|---|
| 1,000 (baseline) | 171 ms | 156 ms | 160 ms | 7.6 / 24.5 ms | 24,894 | 9.7 MB |
| 1,000 | 269 ms | 312 ms | 51 ms | 4.1 / 8.2 ms | 10,100 | 9.4 MB |
| 5,000 (baseline) | 3,758 ms | 3,529 ms | 3,343 ms | 46 / 747 ms | 624,497 | 193 MB |
| 5,000 | 2,021 ms | 1,900 ms | 371 ms | 13 / 75 ms | 56,922 | 59 MB |

Extraction ≈1.1 ms per conversation (5,000 = 5.8 s, sliced, once — then
cached). Extraction cache ≈8 KB per conversation; vectors ≈5.4 KB per
conversation. Neighbour search: 0.45 s for 1,000 and 14.6 s for 5,000 from
scratch, 11 ms / 71 ms per changed conversation (in the worker). Embedding:
3–12 ms per chunk in Node; in Chrome (production build, QA set of 5
conversations / 20 chunks) the model loaded in ≈3 s and embedding took ≈1 s;
a reload reached "compared by meaning" in 0.1 s with nothing re-analysed or
re-embedded.

Still on the page's thread: the corpus stage (≈0.27 s at 1,000, ≈2 s at
5,000 dense conversations) and the first read of the cache.

## 11. Checking links on your own history

Conversations → **Check Hubble's links** (opened by the person; nothing
leaves the device). It shows how many conversations were analysed and how
many links each kind of evidence found, then asks about a sample: links of
each method and level, and near misses Hubble did not link. Each answer
(same problem / same project / related topic / not related) corrects that
pair and is recorded with the scores at the time, so the page can show, on
the person's own history: how often links were right and wrong, how often a
near miss was really related, whether the level matched, and how words
alone and meaning alone would have done. No conversation is moved between
projects. No real-history figures exist yet: the workflow has only been run
on QA data.

## 12. Testing

```bash
npx vitest run src/lib/conversations/intelligence src/components/conversations src/hooks/use-conversation-intelligence.test.tsx src/lib/knowledge-graph/conversation-links.test.ts
```

Benchmarks (the quality run downloads the model once into `.bench-cache`):

```bash
npx vitest run --config vitest.perf.config.mts
```

Visual QA (2026-10-30): dev server + headless Chrome with four seeded
conversations (ChatGPT, Claude, Perplexity, Gemini) in three projects —
overview, ask, thread, detail, messages, related, Settings, Graph (galaxy and
list/inspector), 390px with no horizontal overflow. Not checked against a
person's real saved history.
