import type { Metadata } from "next"
import { LegalPage } from "@/components/legal/legal-page"

export const metadata: Metadata = {
  title: "Cookie Policy — Hubble",
  description: "The two sign-in cookies Hubble sets, and what it stores in your browser instead of cookies.",
}

export default function CookiePolicyPage() {
  return (
    <LegalPage title="Cookie Policy" lastUpdated="September 14, 2026">
      <section>
        <h2>Hubble uses cookies only to sign you in</h2>
        <p>
          Hubble sets no analytics cookies, no advertising or marketing cookies, and nothing that follows you
          across other sites. The only cookies it sets at all are the two below, and it sets them only if you
          choose to sign in. Browse Hubble without signing in and no cookie is set.
        </p>
        <p>
          There is no cookie-consent banner here because there is nothing non-essential to ask consent for:
          the sign-in cookies are strictly necessary to keep you signed in, and every piece of local storage
          described further down is strictly necessary for the app to work at all. If that ever changes, this
          page — and a consent mechanism — will change with it.
        </p>
      </section>

      <section>
        <h2>The cookies Hubble sets</h2>
        <ul>
          <li>
            <strong><code>tabdump_session</code></strong> — keeps you signed in after you sign in with
            Google. It holds a random token, not your personal details. It is marked HttpOnly so page scripts
            cannot read it, restricted to this site, sent only over HTTPS in production, and lasts up to 30
            days, extending as you keep using Hubble. Signing out deletes the matching session on the server
            and clears the cookie.
          </li>
          <li>
            <strong><code>tabdump_login_nonce</code></strong> — a short-lived cookie used once, during the
            sign-in exchange, to confirm the sign-in came from the page you started on. It expires within
            minutes and is not used to identify you afterwards.
          </li>
        </ul>
      </section>

      <section>
        <h2>What Hubble stores outside cookies</h2>
        <p>
          Almost everything Hubble keeps in your browser is not a cookie. It uses two other browser storage
          mechanisms, <code>localStorage</code> and <code>IndexedDB</code>, which are never attached to
          network requests the way a cookie is. Both are scoped to this site&apos;s origin, stay on your
          device, and are readable only by Hubble.
        </p>
        <p>
          If you sign in, your workspaces can also be synced to our server — that is described in the{" "}
          <a href="/privacy">Privacy Policy</a> rather than here, because it is not browser storage.
        </p>
      </section>

      <section>
        <h2>Strictly necessary (functionality) storage</h2>
        <p>Stored in <code>localStorage</code>, all used only to make the app work and remember your own choices:</p>
        <ul>
          <li><strong>Your workspaces, tabs, sections, and collections</strong> — the core data Hubble exists to hold.</li>
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
          If you use Auto-Organize&apos;s optional semantic-clustering hints, Hubble stores the resulting
          embeddings in an <code>IndexedDB</code> database on your device (named <code>tabdump-ai</code>),
          keyed to your workspace and tabs, so they don&apos;t need to be recomputed every time. This is only
          created if that feature actually runs.
        </p>
      </section>

      <section>
        <h2>Analytics and marketing cookies</h2>
        <p>
          Hubble does not use analytics cookies, advertising cookies, or any third-party marketing/tracking
          scripts. There is no Google Analytics, Meta Pixel, or similar tool integrated into this application.
        </p>
      </section>

      <section>
        <h2>Third-party cookies</h2>
        <p>
          Hubble&apos;s server-side integrations (page-title resolution, and the optional Gemini API calls
          for Auto-Organize — see the <a href="/privacy">Privacy Policy</a>) are server-to-server requests
          initiated from Hubble&apos;s own server, not from your browser — so they cannot set cookies in
          your browser. Fonts are self-hosted at build time rather than loaded from Google Fonts at runtime,
          so no font-related cookie or tracking request happens either.
        </p>
        <p>
          There is one exception, and it belongs to Google rather than to us. When the Sign in with Google
          button is shown, your browser loads Google&apos;s sign-in script from{" "}
          <code>accounts.google.com</code>. That is a request from your browser to Google, so Google may set
          or read its own cookies for its domain as part of signing you in — governed by Google&apos;s
          privacy and cookie policies, not this one. Hubble cannot read those cookies.
        </p>
      </section>

      <section>
        <h2>Managing or clearing this data</h2>
        <p>You are always in control of what Hubble has stored on your device:</p>
        <ul>
          <li>Use Hubble&apos;s own delete/clear-workspace actions to remove specific data.</li>
          <li>Clear this site&apos;s data from your browser&apos;s settings to remove everything Hubble has stored at once (this also resets your appearance preferences).</li>
          <li>Uninstall the Hubble browser extension to stop it from being able to read your tabs or history.</li>
          <li>Sign out to clear the session cookie and delete that session on our server.</li>
        </ul>
        <p>Clearing local storage will remove your saved workspaces from this browser — export them first if you want to keep a copy. If you are signed in and have synced them, the copy on our server is not removed by clearing your browser.</p>
      </section>

      <section>
        <h2>Changes to This Cookie Policy</h2>
        <p>
          If the cookies Hubble sets change, or if analytics or other tracking is ever introduced, this page
          will be updated to describe them accurately, and a consent mechanism will be added before any
          non-essential tracking loads.
        </p>
      </section>
    </LegalPage>
  )
}
