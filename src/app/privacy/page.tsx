import type { Metadata } from "next"
import { LegalPage, ContactEmail } from "@/components/legal/legal-page"

export const metadata: Metadata = {
  title: "Privacy Policy — Hubble",
  description: "How Hubble handles the tabs, notes, and workspace data you bring into it.",
}

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="September 14, 2026">
      <section>
        <h2>Introduction</h2>
        <p>
          Hubble is a tool for organizing your browser tabs into workspaces. This policy explains, as
          accurately as we can describe it from how the application is actually built, what information
          Hubble collects, where it is stored, and when — if ever — it leaves your device.
        </p>
        <p>
          The short version: Hubble works without an account. The tabs, notes, and workspaces you create
          live in your own browser&apos;s local storage, and if you never sign in, they stay there.
        </p>
        <p>
          If you choose to sign in with Google, two things change. Hubble creates an account for you, and
          your workspaces can then be synced to a database on the server so the same tabs are available in
          another browser. Both are described in detail under{" "}
          <a href="#accounts-and-sync">Accounts and Sync</a> below. Signing in is optional — the app is
          fully usable without it.
        </p>
      </section>

      <section>
        <h2>Information You Provide</h2>
        <p>When you use Hubble, you may provide:</p>
        <ul>
          <li>
            <strong>Tab data</strong> — URLs and page titles you paste directly into Hubble, or that the
            optional Hubble browser extension sends over from your currently open tabs or browser history.
          </li>
          <li>
            <strong>Organizational content</strong> — workspace names, section/category names, notes you
            attach to a tab, and favorite/relationship markers you create while organizing your tabs.
          </li>
          <li>
            <strong>An optional workspace logo image</strong> you choose to upload, if you use that feature.
          </li>
          <li>
            <strong>Account details, only if you sign in.</strong> Signing in with Google gives Hubble the
            email address, name, and profile picture URL on your Google account, along with the account
            identifier Google issues for it. Hubble never sees or handles your Google password.
          </li>
        </ul>
        <p>
          None of this requires an account except the last item. Using Hubble without signing in does not
          ask for your name, email address, or any contact details.
        </p>
      </section>

      <section>
        <h2>Automatically Collected Information</h2>
        <p>Depending on how you use Hubble, the following may also be collected:</p>
        <ul>
          <li>
            <strong>Page titles fetched on your behalf.</strong> When you paste or import a URL, Hubble&apos;s
            server may fetch that page (or ask an oEmbed-style API, for supported sites like YouTube) to
            resolve a readable title, since not every pasted URL comes with one. Only the URL you provided is
            sent for this lookup, and requests to private, local, or internal network addresses are blocked
            before any fetch happens.
          </li>
          <li>
            <strong>IP address, transiently, for abuse prevention.</strong> The server uses your
            request&apos;s IP address to apply a simple rate limit per address on the sign-in, sync, and
            optional AI endpoints, so one caller cannot exhaust a shared quota or flood the service. This is
            held in server memory only, is never written to a file or database, and is cleared whenever the
            server process restarts.
          </li>
          <li>
            <strong>Standard hosting/network metadata.</strong> Whoever hosts this deployment (a hosting
            provider, CDN, or reverse proxy) may process ordinary connection metadata — such as IP address,
            timestamps, and request logs — as a normal part of operating that infrastructure. Hubble&apos;s
            own application code does not read, store, or forward this information.
          </li>
        </ul>
        <p>Hubble does not use analytics scripts, advertising trackers, or session-replay tools, and does not set any tracking cookies. See the <a href="/cookies">Cookie Policy</a> for details on local storage.</p>
      </section>

      <section>
        <h2>How We Use Information</h2>
        <p>Information is used only to provide the features you directly invoke:</p>
        <ul>
          <li>Tab data and organizational content are used to render and persist your workspace.</li>
          <li>Fetched page titles are used to replace a bare URL with a readable title in your tab list.</li>
          <li>IP-based rate limiting is used to protect the AI and sync endpoints from abuse.</li>
          <li>
            Account details are used to identify you when you sign in and to show which account you are
            using. Synced workspace data is used to give you the same workspaces in another browser.
          </li>
        </ul>
        <p>Hubble does not sell data, does not use your content to train models, and does not share it with advertisers — it does not have an advertising or data-sale mechanism of any kind.</p>
      </section>

      <section id="accounts-and-sync">
        <h2>Accounts and Sync</h2>
        <p>
          Signing in is optional, and nothing in this section applies until you do it.
        </p>
        <p>
          <strong>Your account.</strong> When you sign in with Google, Hubble stores an account record
          containing your email address, name, profile picture URL, and the identifier Google uses for your
          account, plus the dates the record was created and last changed. Your email is kept for display and
          support; the Google identifier is what actually identifies you, because an email address can change
          hands.
        </p>
        <p>
          <strong>Your session.</strong> Staying signed in is handled by a session record on the server and a
          matching cookie in your browser. Only a one-way hash of the session token is stored — the raw token
          the browser holds is never written down on our side.
        </p>
        <p>
          <strong>Your synced workspaces.</strong> While you are signed in, Hubble can copy your workspaces
          to a PostgreSQL database so another browser signed into the same account sees the same tabs. What
          is stored there is the workspace itself — its name and logo — and its contents:
        </p>
        <ul>
          <li>tabs, including the URL, page title, any notes you wrote, and whether you marked it a favorite or pinned it;</li>
          <li>how the tab was organized — its category, the section or group it sits in, whether you placed it there yourself, and the reason automatic organization gave for its placement;</li>
          <li>sections, groups, collections, and the relationships you create between tabs;</li>
          <li>
            when a tab came from the browser-extension History Dump, the visit-count and last-visited
            timestamp that came with it.
          </li>
        </ul>
        <p>
          Each record is stored against your account, and every sync request is checked so that it can only
          read or write workspaces belonging to the signed-in account.
        </p>
        <p>
          Deleting a workspace in Hubble while signed in is synced too: the server marks it deleted so your
          other devices remove it as well, and keeps a record that the deletion happened.
        </p>
      </section>

      <section>
        <h2>Cookies and Similar Technologies</h2>
        <p>
          Hubble sets cookies only for signing in. If you never sign in, no cookie is set. There are no
          analytics, advertising, or tracking cookies at any point.
        </p>
        <ul>
          <li>
            A <strong>session cookie</strong> that keeps you signed in. It is marked HttpOnly, so page
            scripts cannot read it, sent only over HTTPS in production, and lasts up to 30 days, extending as
            you keep using Hubble.
          </li>
          <li>
            A <strong>short-lived sign-in cookie</strong> used once during the sign-in exchange to confirm
            the request came from the page you started on. It expires within minutes.
          </li>
        </ul>
        <p>
          Everything else lives in your browser&apos;s <code>localStorage</code> and <code>IndexedDB</code>{" "}
          rather than in a cookie. The full <a href="/cookies">Cookie Policy</a> lists what is stored and why.
        </p>
      </section>

      <section>
        <h2>Third-Party Services</h2>
        <p>Hubble integrates with the following third parties, only when the corresponding feature is used:</p>
        <ul>
          <li>
            <strong>Sign in with Google (optional).</strong> If you choose to sign in, Google handles the
            sign-in itself and returns a signed proof of who you are, which Hubble checks against Google&apos;s
            published keys. Your interaction with Google at that moment is covered by Google&apos;s own privacy
            policy. If you never sign in, Hubble makes no request to Google for this.
          </li>
          <li>
            <strong>Google Gemini API (optional, operator-configured).</strong> The person or organization
            running a given Hubble deployment can optionally configure a Gemini API key to sharpen
            Auto-Organize&apos;s tab clustering with semantic similarity hints. When configured, tab titles,
            URLs, and short snippets of page text derived from your tabs are sent from Hubble&apos;s server to
            Google&apos;s Gemini API to generate embeddings or an organization suggestion. Embedding results are
            cached in server memory (keyed by a hash of the text, not by you or your workspace) for up to
            seven days to avoid repeat calls, and are discarded when the server restarts. If no key is
            configured, Hubble organizes tabs using only deterministic, local domain/keyword rules and never
            contacts Gemini at all.
          </li>
          <li>
            <strong>Sites you link to.</strong> Resolving a page title or the optional content-clustering hint
            means Hubble&apos;s server briefly fetches the URL you provided. That site sees a request from
            Hubble&apos;s server, not from your browser directly.
          </li>
          <li>
            <strong>Fonts.</strong> Hubble uses Google-designed fonts, but they are downloaded once at build
            time and served from this application&apos;s own domain — your browser never requests them from
            Google, so no font-related request is sent to Google when you use the app.
          </li>
        </ul>
        <p>Hubble does not integrate any advertising network, error-monitoring/crash-reporting SDK, chat widget, or payment provider.</p>
      </section>

      <section>
        <h2>The Browser Extension</h2>
        <p>
          The optional Hubble browser extension requests permission to read your open tabs and, for the
          History Dump feature, your browser history. It uses these permissions only to let you pick pages to
          bring into Hubble — tab and history data is read locally by the extension and handed directly to
          the Hubble web app running in your browser (via the same-origin messaging bridge described in the
          extension&apos;s source). It is never sent to any server operated by Hubble, and the extension
          itself has no network permissions to reach anywhere other than the Hubble page it is installed to
          work with.
        </p>
      </section>

      <section>
        <h2>Data Storage and Retention</h2>
        <ul>
          <li>
            <strong>Workspace data, notes, favorites, sections, dependencies, and appearance settings</strong>{" "}
            are stored in your browser&apos;s <code>localStorage</code> and remain there until you clear them
            (via your browser&apos;s own storage controls, or Hubble&apos;s own clear/delete-workspace
            actions) or until your browser removes them (e.g., clearing site data).
          </li>
          <li>
            <strong>AI-derived embeddings</strong>, used only for Auto-Organize&apos;s optional semantic
            clustering hints, are stored in your browser&apos;s <code>IndexedDB</code> and follow the same
            local retention as above.
          </li>
          <li>
            <strong>Server-side caches</strong> (fetched titles, Gemini embedding results) live only in
            server process memory, are not written to disk or a database, and are cleared on server restart
            or after their cache window (up to seven days) expires.
          </li>
          <li>
            <strong>Your account and any synced workspaces</strong> are stored in a PostgreSQL database and
            kept until they are deleted. Deleting a workspace in Hubble while signed in removes it from your
            other devices and leaves a record that it was deleted. Signing out deletes that session from the
            server, but leaves your account and any synced workspaces in place so they are still there next
            time you sign in.
          </li>
          <li>
            <strong>Expired sessions</strong> are deleted when they are next encountered.
          </li>
        </ul>
        <p>
          Hubble does not currently offer a self-service way to delete your whole account and everything
          synced with it. If you want that done, write to <ContactEmail /> and we will handle it manually. If
          you never sign in, there is nothing on the server to delete in the first place.
        </p>
      </section>

      <section>
        <h2>Data Security</h2>
        <p>
          Hubble takes reasonable, verifiable precautions appropriate to what it actually handles: the
          title/content-fetching endpoints block requests to local and internal network addresses (to prevent
          the server being used to probe internal infrastructure), and the sign-in, sync, and AI endpoints
          are rate-limited per IP address. For accounts specifically, session tokens are stored only as a
          one-way hash rather than in a form that could be read back and reused, the session cookie is marked
          HttpOnly so page scripts cannot read it and is sent only over HTTPS in production, and every sync
          request is checked against the signed-in account before it can read or write anything. No method of
          transmission or storage is completely secure, and we do not claim Hubble — or any software — is
          100% secure or guarantees against data loss.
        </p>
      </section>

      <section>
        <h2>Your Rights and Choices</h2>
        <p>Your workspace lives in your own browser, and on our server as well only if you sign in. Either way you stay in direct control of it:</p>
        <ul>
          <li>Delete a workspace, tab, or note at any time from within Hubble. While you are signed in, that deletion syncs to your other devices too.</li>
          <li>Export your workspace as a JSON file, or clear your browser&apos;s local storage/IndexedDB for this site to remove the local copy at once.</li>
          <li>Use Hubble without signing in, and nothing of yours is stored on the server at all.</li>
          <li>Sign out at any time — this deletes that session on the server, so the browser is no longer signed in.</li>
          <li>Uninstall the browser extension at any time to revoke its access to your tabs and history.</li>
          <li>Avoid the optional AI features entirely — Auto-Organize works from local clustering rules alone, and nothing is sent to Gemini unless that key is configured and the feature runs.</li>
          <li>Ask us at <ContactEmail /> for a copy of what your account holds, or for the account and its synced workspaces to be deleted.</li>
        </ul>
      </section>

      <section>
        <h2>Children&apos;s Privacy</h2>
        <p>
          Hubble is a general-purpose browser tab organizer and is not directed at children. It does not
          knowingly collect personal information from children, and it does not implement age verification.
        </p>
      </section>

      <section>
        <h2>Changes to This Privacy Policy</h2>
        <p>
          If Hubble&apos;s data handling changes — for example, a new integration is added — this page will
          be updated and the &quot;Last updated&quot; date above will change accordingly.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about this policy? Reach us at <ContactEmail />.
        </p>
      </section>
    </LegalPage>
  )
}
