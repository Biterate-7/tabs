import type { Metadata } from "next"
import { LegalPage, ContactEmail } from "@/components/legal/legal-page"

export const metadata: Metadata = {
  title: "Privacy Policy — TabDump",
  description: "How TabDump handles the tabs, notes, and workspace data you bring into it.",
}

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="September 6, 2026">
      <section>
        <h2>Introduction</h2>
        <p>
          TabDump is a tool for organizing your browser tabs into workspaces. This policy explains, as
          accurately as we can describe it from how the application is actually built, what information
          TabDump collects, where it is stored, and when — if ever — it leaves your device.
        </p>
        <p>
          The short version: TabDump has no user accounts and no server-side database. The tabs, notes,
          and workspaces you create live in your own browser&apos;s local storage. A couple of optional
          features send limited data to a server component to make the app work better, described below.
        </p>
      </section>

      <section>
        <h2>Information You Provide</h2>
        <p>When you use TabDump, you may provide:</p>
        <ul>
          <li>
            <strong>Tab data</strong> — URLs and page titles you paste directly into TabDump, or that the
            optional TabDump browser extension sends over from your currently open tabs or browser history.
          </li>
          <li>
            <strong>Organizational content</strong> — workspace names, section/category names, notes you
            attach to a tab, and favorite/relationship markers you create while organizing your tabs.
          </li>
          <li>
            <strong>An optional workspace logo image</strong> you choose to upload, if you use that feature.
          </li>
        </ul>
        <p>None of this requires you to create an account, and TabDump does not ask for your name, email address, or any contact details.</p>
      </section>

      <section>
        <h2>Automatically Collected Information</h2>
        <p>Depending on how you use TabDump, the following may also be collected:</p>
        <ul>
          <li>
            <strong>Page titles fetched on your behalf.</strong> When you paste or import a URL, TabDump&apos;s
            server may fetch that page (or ask an oEmbed-style API, for supported sites like YouTube) to
            resolve a readable title, since not every pasted URL comes with one. Only the URL you provided is
            sent for this lookup, and requests to private, local, or internal network addresses are blocked
            before any fetch happens.
          </li>
          <li>
            <strong>IP address, transiently, for abuse prevention.</strong> If the optional AI features
            (below) are enabled, the server uses your request&apos;s IP address to apply a simple rate limit
            per address, so one visitor cannot exhaust a shared API quota. This is held in server memory only,
            is never written to a file or database, and is cleared whenever the server process restarts.
          </li>
          <li>
            <strong>Standard hosting/network metadata.</strong> Whoever hosts this deployment (a hosting
            provider, CDN, or reverse proxy) may process ordinary connection metadata — such as IP address,
            timestamps, and request logs — as a normal part of operating that infrastructure. TabDump&apos;s
            own application code does not read, store, or forward this information.
          </li>
        </ul>
        <p>TabDump does not use analytics scripts, advertising trackers, or session-replay tools, and does not set any tracking cookies. See the <a href="/cookies">Cookie Policy</a> for details on local storage.</p>
      </section>

      <section>
        <h2>How We Use Information</h2>
        <p>Information is used only to provide the features you directly invoke:</p>
        <ul>
          <li>Tab data and organizational content are used to render and persist your workspace.</li>
          <li>Fetched page titles are used to replace a bare URL with a readable title in your tab list.</li>
          <li>IP-based rate limiting is used only to protect the optional AI endpoints from abuse.</li>
        </ul>
        <p>TabDump does not sell data, does not use your content to train models, and does not share it with advertisers — it does not have an advertising or data-sale mechanism of any kind.</p>
      </section>

      <section>
        <h2>Cookies and Similar Technologies</h2>
        <p>
          TabDump does not set cookies. It stores your workspace data and preferences in your browser&apos;s
          <code> localStorage</code> and <code>IndexedDB</code> — mechanisms that keep data on your device
          rather than sending it to a server. The full <a href="/cookies">Cookie Policy</a> lists what is
          stored there and why.
        </p>
      </section>

      <section>
        <h2>Third-Party Services</h2>
        <p>TabDump integrates with the following third parties, only when the corresponding feature is used:</p>
        <ul>
          <li>
            <strong>Google Gemini API (optional, operator-configured).</strong> The person or organization
            running a given TabDump deployment can optionally configure a Gemini API key to sharpen
            Auto-Organize&apos;s tab clustering with semantic similarity hints. When configured, tab titles,
            URLs, and short snippets of page text derived from your tabs are sent from TabDump&apos;s server to
            Google&apos;s Gemini API to generate embeddings or an organization suggestion. Embedding results are
            cached in server memory (keyed by a hash of the text, not by you or your workspace) for up to
            seven days to avoid repeat calls, and are discarded when the server restarts. If no key is
            configured, TabDump organizes tabs using only deterministic, local domain/keyword rules and never
            contacts Gemini at all.
          </li>
          <li>
            <strong>Sites you link to.</strong> Resolving a page title or the optional content-clustering hint
            means TabDump&apos;s server briefly fetches the URL you provided. That site sees a request from
            TabDump&apos;s server, not from your browser directly.
          </li>
          <li>
            <strong>Fonts.</strong> TabDump uses Google-designed fonts, but they are downloaded once at build
            time and served from this application&apos;s own domain — your browser never requests them from
            Google, so no font-related request is sent to Google when you use the app.
          </li>
        </ul>
        <p>TabDump does not integrate any advertising network, error-monitoring/crash-reporting SDK, chat widget, or payment provider.</p>
      </section>

      <section>
        <h2>The Browser Extension</h2>
        <p>
          The optional TabDump browser extension requests permission to read your open tabs and, for the
          History Dump feature, your browser history. It uses these permissions only to let you pick pages to
          bring into TabDump — tab and history data is read locally by the extension and handed directly to
          the TabDump web app running in your browser (via the same-origin messaging bridge described in the
          extension&apos;s source). It is never sent to any server operated by TabDump, and the extension
          itself has no network permissions to reach anywhere other than the TabDump page it is installed to
          work with.
        </p>
      </section>

      <section>
        <h2>Data Storage and Retention</h2>
        <ul>
          <li>
            <strong>Workspace data, notes, favorites, sections, dependencies, and appearance settings</strong>{" "}
            are stored in your browser&apos;s <code>localStorage</code> and remain there until you clear them
            (via your browser&apos;s own storage controls, or TabDump&apos;s own clear/delete-workspace
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
        </ul>
        <p>There is no server-side database, so TabDump itself has no copy of your workspace to retain, export, or delete on your behalf beyond what briefly passes through the requests above.</p>
      </section>

      <section>
        <h2>Data Security</h2>
        <p>
          TabDump takes reasonable, verifiable precautions appropriate to what it actually handles: the
          title/content-fetching endpoints block requests to local and internal network addresses (to prevent
          the server being used to probe internal infrastructure), and the optional AI endpoints are
          rate-limited per IP address. No method of transmission or storage is completely secure, and we do
          not claim TabDump — or any software — is 100% secure or guarantees against data loss.
        </p>
      </section>

      <section>
        <h2>Your Rights and Choices</h2>
        <p>Because your workspace lives in your own browser rather than in an account we control, you are already in direct control of it:</p>
        <ul>
          <li>Delete a workspace, tab, or note at any time from within TabDump.</li>
          <li>Export your workspace as a JSON file, or clear your browser&apos;s local storage/IndexedDB for this site to remove everything at once.</li>
          <li>Uninstall the browser extension at any time to revoke its access to your tabs and history.</li>
          <li>Avoid the optional AI features entirely — Auto-Organize works from local clustering rules alone, and nothing is sent to Gemini unless that key is configured and the feature runs.</li>
        </ul>
      </section>

      <section>
        <h2>Children&apos;s Privacy</h2>
        <p>
          TabDump is a general-purpose browser tab organizer and is not directed at children. It does not
          knowingly collect personal information from children, and it does not implement age verification.
        </p>
      </section>

      <section>
        <h2>Changes to This Privacy Policy</h2>
        <p>
          If TabDump&apos;s data handling changes — for example, a new integration is added — this page will
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
