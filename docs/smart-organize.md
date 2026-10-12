# Smart Organize

Sorts a messy set of tabs into groups the person reviews, edits and confirms.
Nothing changes before the confirm button, no tab is ever closed, and nothing
is deleted. Built from the October 2026 student survey (too many tabs, wanting
visual workspaces and research collections, re-finding the same thing).

## Two scopes, one review

| Scope | Entry point | Reads | A confirmed group becomes |
| --- | --- | --- | --- |
| Open tabs | Home → **Organize open tabs**; ⌘K → *Organize open tabs* | Chrome's tabs, through Hubble for Chrome's existing `list_browser_tabs` command | Sources in a subject (existing, or created with the group's name) |
| A subject | Subject header ⋯ → **Organize tabs**; ⌘K → *Organize tabs*; a one-line offer after a bulk import | The subject's saved tabs | A collection in that subject (existing, or new) |

Both render `SmartOrganizeDialog` (`src/components/organize/`), so loading,
unavailable, empty, error and review states are the same everywhere.

**Surface limits.** Reading open tabs needs Hubble for Chrome on the web. Hubble
Desktop has no channel to ask Chrome for its tabs (Chrome pushes to it; see
`desktop-import.md`), so there the dialog says so and points to the subject
scope, which works on both.

**Private windows.** If the person has allowed the extension in incognito,
Chrome hands those tabs over too. Smart Organize also asks for
`list_browser_windows` and reads a tab only if its window is known to be an
ordinary one: a private window, or a window Chrome did not describe (opened
between the two answers), is skipped. If it cannot get the window list, it
reads nothing.

**First run.** Home's first-run screen is deliberately one line and one
button (pinned by `home-view.test.tsx` and the shell tests). Smart Organize is
not added there; it is in ⌘K from the start and joins Home beside *New subject*
once a subject exists.

## Grouping (no API key, nothing leaves the device)

`src/lib/organize/smart/group.ts`. Deterministic and explainable:

1. **Topic words** — each title minus the parts that only name the site
   ("… - YouTube", "… | Khan Academy"), stopwords, and page-type words
   ("notes", "worksheet", "past paper"), lightly stemmed.
2. **Similarity** — IDF-weighted Jaccard over those words. A niche site counts a
   little; a platform that hosts any topic (YouTube, Wikipedia, Docs, ChatGPT…)
   never does. Words only one tab uses count at half weight.
3. **Groups** — average-linkage agglomerative clustering at `MERGE_THRESHOLD`.
   An average, not one shared word, holds a group together.
4. **Sites** — leftovers sharing a site that *is* the activity (Instagram, a
   course site) group under the site's own spelling ("Common App").
5. Everything else goes to **Not sure** and is left as it is.

Names and reasons come only from the tabs' words ("Titles mention “Gatsby” and
“Great”"). A group defaults to the existing subject/collection it clearly fits
(same name, or most of its shared words already there), else a new one.

The older Auto-Organize (`lib/organize/analyze.ts`), which sent tab URLs for
Gemini embeddings and proposed invisible `workspace.groups`, no longer has a UI;
Smart Organize replaced its panel and its post-import trigger.

## What leaves the device

- **Grouping:** nothing. No AI provider, no Hubble server call; the proposal is
  built in the page from titles and addresses Chrome already reported.
- **Reading Chrome's tabs:** `list_browser_tabs` and `list_browser_windows`,
  page → content script → extension service worker. Local to the browser.
- **While reviewing:** each listed tab's icon loads, the way every Hubble tab
  list does — Chrome's own favicon URL (a request to that site) or Hubble's
  `/api/favicon?host=` resolver. This happens before anything is confirmed,
  for tabs that may end up left out; private-window tabs are never listed.
- **After confirming:** each added page becomes a pending source and is read
  by the normal resource pipeline (`/api/resources/extract` on Hubble's
  server fetches the page; a YouTube transcript goes to the transcript
  provider only when the operator configured one) — exactly as for any page
  added another way.
- **Not used:** the sections pipeline (`/api/ai/organize`). It runs on tab
  dumps and *Reorganize into sections*, not on Smart Organize. When the
  server has `GEMINI_API_KEY`, it sends sample titles and domains per
  cluster, and title + URL (first 160 characters) + domain for leftover
  tabs, to Google Gemini, with no disclosure in the product. That is a
  separate, pre-existing feature; Smart Organize neither calls nor changes it.

## Safety

- **Already organized work is left out by default**: a page already saved in
  any subject, as a source or a plain tab (open tabs); a tab already in a
  collection (subject). Including one is an explicit choice in the review.
- **Duplicates** are found by Hubble's source identity (`resourceKey`: tracking
  parameters, www/http, YouTube address shapes and timestamps folded; every
  other query parameter kept) — never by title. They are shown, not acted on;
  open-tabs ingestion saves one copy, subject scope links to Clean up.
- **Apply** reuses `ingestResources` (open tabs) and the collection store's
  all-or-nothing batch (subject). Both are idempotent: a subject or collection
  is found by name before one is made, a saved page is a duplicate, a tab
  already in its target is skipped. A group whose subject vanished meanwhile is
  reported; the rest apply in one commit.
- **Undo** (toast): open tabs — `undoSmartToSubjects` removes a source it added
  only while it is still in the subject it was added to and the person has not
  made it theirs: no note, star, rename or section pin, not filed in a
  collection, and no content supplied for it (an uploaded PDF or pasted
  transcript, recorded by the shell as it happens). Adopted tabs go back to
  plain tabs unless content was supplied for them. A created subject is removed
  only while it is empty, still has its created name and has no brief, icon or
  folder. Anything kept is reported, and only the tabs actually taken back have
  their stored content dropped. Subject — the collection store's guarded restore, which refuses
  (changing nothing) if the collections were edited since.

## Known limits

- Grouping reads titles, so pages on one topic in different words land in
  *Not sure*. A group goes to an existing subject only when most of its shared
  words are already there; matching one of two (a "Gatsby" group against a
  subject with one Gatsby page) stays *New subject* on purpose, since loosening
  it would also send "French Revolution" into a "French" class.
- Several pages from one niche site (a school portal) form a site group even if
  their topics differ.
- Undo errs towards keeping: a source whose empty or address-like title Hubble
  itself filled in looks renamed and is kept. Supplied-content tracking lives
  for the session, as the Undo toast does.
- The private-window guard was verified with unit tests and a real extension
  in ordinary windows; a real incognito window with "Allow in incognito" has
  not been exercised.

