import type { Metadata } from "next"
import { LegalPage } from "@/components/legal/legal-page"

export const metadata: Metadata = {
  title: "Cookie Policy — TabDump",
  description: "TabDump does not use cookies. Here is what it stores locally instead, and why.",
}

export default function CookiePolicyPage() {
  return (
    <LegalPage title="Cookie Policy" lastUpdated="September 6, 2026">
      <section>
        <h2>TabDump does not use cookies</h2>
        <p>
          TabDump does not set any HTTP cookies — no session cookies, no analytics cookies, no advertising or
          marketing cookies. There is no cookie-consent banner on this site because there is nothing
          non-essential to ask consent for: every piece of local storage described below is strictly
          necessary for TabDump&apos;s core function (it is how your workspace is saved at all, since TabDump
          has no server-side database), not tracking or advertising. If that ever changes, this page — and a
          consent mechanism — will change with it.
        </p>
      </section>

      <section>
        <h2>What TabDump stores instead</h2>
        <p>
          TabDump uses two browser storage mechanisms that are not cookies and are never sent to a server:
          <code> localStorage</code> and <code>IndexedDB</code>. Both are scoped to this site&apos;s origin,
          stay on your device, and are readable only by TabDump.
        </p>
      </section>

      <section>
        <h2>Strictly necessary (functionality) storage</h2>
        <p>Stored in <code>localStorage</code>, all used only to make the app work and remember your own choices:</p>
        <ul>
          <li><strong>Your workspaces, tabs, sections, and collections</strong> — the core data TabDump exists to hold.</li>
          <li><strong>Notes and relationships</strong> you add between tabs.</li>
          <li><strong>Appearance settings</strong> — theme, typography, layout, and motion preferences (Settings → Appearance).</li>
          <li><strong>UI state</strong> — whether the sidebar is collapsed, and whether you have dismissed onboarding.</li>
          <li><strong>A small cache of resolved page titles</strong>, so a title already looked up once does not need to be fetched again.</li>
        </ul>
        <p>None of these are used for analytics, advertising, or cross-site tracking — each is read back only to restore your own workspace or preferences on your next visit.</p>
      </section>

      <section>
        <h2>IndexedDB</h2>
        <p>
          If you use Auto-Organize&apos;s optional semantic-clustering hints, TabDump stores the resulting
          embeddings in an <code>IndexedDB</code> database on your device (named <code>tabdump-ai</code>),
          keyed to your workspace and tabs, so they don&apos;t need to be recomputed every time. This is only
          created if that feature actually runs.
        </p>
      </section>

      <section>
        <h2>Analytics and marketing cookies</h2>
        <p>
          TabDump does not use analytics cookies, advertising cookies, or any third-party marketing/tracking
          scripts. There is no Google Analytics, Meta Pixel, or similar tool integrated into this application.
        </p>
      </section>

      <section>
        <h2>Third-party cookies</h2>
        <p>
          TabDump&apos;s server-side integrations (page-title resolution, and the optional Gemini API calls
          for Auto-Organize — see the <a href="/privacy">Privacy Policy</a>) are server-to-server requests
          initiated from TabDump&apos;s own server, not from your browser — so they cannot set cookies in
          your browser. Fonts are self-hosted at build time rather than loaded from Google Fonts at runtime,
          so no font-related cookie or tracking request happens either.
        </p>
      </section>

      <section>
        <h2>Managing or clearing this data</h2>
        <p>You are always in control of what TabDump has stored on your device:</p>
        <ul>
          <li>Use TabDump&apos;s own delete/clear-workspace actions to remove specific data.</li>
          <li>Clear this site&apos;s data from your browser&apos;s settings to remove everything TabDump has stored at once (this also resets your appearance preferences).</li>
          <li>Uninstall the TabDump browser extension to stop it from being able to read your tabs or history.</li>
        </ul>
        <p>Clearing local storage will remove your saved workspaces — export them first if you want to keep a copy.</p>
      </section>

      <section>
        <h2>Changes to This Cookie Policy</h2>
        <p>
          If TabDump ever introduces cookies, analytics, or other tracking, this page will be updated to
          describe them accurately, and a consent mechanism will be added before any non-essential tracking
          loads.
        </p>
      </section>
    </LegalPage>
  )
}
