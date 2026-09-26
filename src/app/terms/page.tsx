import type { Metadata } from "next"
import { LegalPage, ContactEmail } from "@/components/legal/legal-page"

export const metadata: Metadata = {
  title: "Terms & Conditions — Hubble",
  description: "The terms that apply to using Hubble to organize your browser tabs.",
}

export default function TermsPage() {
  return (
    <LegalPage title="Terms & Conditions" lastUpdated="September 14, 2026">
      <section>
        <h2>Acceptance of Terms</h2>
        <p>
          By using Hubble — the web application, and the optional companion browser extension — you agree to
          these Terms & Conditions. If you do not agree, please do not use Hubble.
        </p>
      </section>

      <section>
        <h2>Description of the Service</h2>
        <p>Hubble lets you:</p>
        <ul>
          <li>Paste or import browser tabs (and, optionally, browser history) into an organized workspace.</li>
          <li>Group tabs into categories, sections, and collections, add notes, and mark favorites.</li>
          <li>Optionally use an AI-assisted Auto-Organize feature to cluster tabs, when the deployment you are using has that configured.</li>
          <li>Export and re-import your workspace as a JSON file.</li>
          <li>Optionally sign in with Google, which creates an account and lets your workspaces sync between browsers.</li>
        </ul>
        <p>
          Hubble stores your workspace locally in your browser. If you sign in, it can also be stored on our
          server so it is available in another browser — see the <a href="/privacy">Privacy Policy</a> for
          exactly what that means.
        </p>
      </section>

      <section>
        <h2>Accounts</h2>
        <p>
          You do not need an account to use Hubble. If you choose to create one by signing in with Google:
        </p>
        <ul>
          <li>You are responsible for the security of the Google account you sign in with, since anyone who can use it can reach your Hubble workspaces.</li>
          <li>You may sign out at any time, which ends that session.</li>
          <li>Keep your own exports or local copies of anything you would not want to lose. Synced data is a convenience, not a backup service, and we do not guarantee it against loss.</li>
          <li>We may suspend or remove an account that is being used to abuse the service in the ways described below.</li>
        </ul>
      </section>

      <section>
        <h2>User Responsibilities and Acceptable Use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use Hubble&apos;s title-resolution or AI endpoints to send an automated or abusive volume of requests, or to attempt to probe, scan, or reach internal/private network addresses through them.</li>
          <li>Attempt to circumvent rate limits or other abuse-prevention measures.</li>
          <li>Use Hubble to store, process, or organize content that is unlawful, or that infringes someone else&apos;s rights.</li>
          <li>Interfere with the operation of the service, or attempt to access another user&apos;s account or workspaces.</li>
        </ul>
        <p>You remain responsible for complying with the terms of any third-party site whose URL you paste into or fetch through Hubble.</p>
      </section>

      <section>
        <h2>Intellectual Property</h2>
        <p>
          Hubble&apos;s application code, design, and branding belong to whoever develops and operates this
          deployment. Using Hubble does not grant you any ownership interest in it beyond the ability to use
          it as intended.
        </p>
      </section>

      <section>
        <h2>User-Submitted Content</h2>
        <p>
          The tab URLs, titles, notes, workspace names, and any logo image you add to Hubble are yours, and
          they stay yours. You give us permission to store and transmit that content only as far as is needed
          to run the features you use — which, if you are signed in and syncing, includes keeping a copy on
          our server so your other browsers can load it.
        </p>
        <p>
          We do not review or moderate what you save, and we do not use it for advertising or to train
          models. The <a href="/privacy">Privacy Policy</a> describes exactly what is stored and where.
        </p>
      </section>

      <section>
        <h2>Third-Party Services</h2>
        <p>
          Hubble may, depending on configuration and the features you use, send requests to third-party
          sites (to resolve a page title), to Google&apos;s Gemini API (for optional AI-assisted
          organization), or to Google (to sign you in, if you choose to). Your use of Sign in with Google is
          also subject to Google&apos;s own terms and privacy policy. Hubble is not responsible for the
          availability, content, or practices of those third parties. See the <a href="/privacy">Privacy Policy</a> for what each integration actually
          does.
        </p>
      </section>

      <section>
        <h2>Availability of the Service</h2>
        <p>
          Hubble is provided on a best-effort basis. We do not guarantee any particular level of uptime,
          availability, or performance, and features that depend on a third-party API (such as Gemini) may be
          degraded or unavailable if that third party is unreachable — in that case, Hubble&apos;s
          organization features fall back to local, deterministic rules rather than failing outright.
        </p>
      </section>

      <section>
        <h2>Disclaimers</h2>
        <p>
          Hubble is provided &quot;as is&quot; and &quot;as available,&quot; without warranties of any kind,
          whether express or implied, including — to the extent permitted by law — any implied warranties of
          merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that
          Hubble will be error-free, uninterrupted, or completely secure.
        </p>
      </section>

      <section>
        <h2>Limitation of Liability</h2>
        <p>
          To the extent permitted by applicable law, Hubble&apos;s operator will not be liable for any
          indirect, incidental, special, consequential, or punitive damages, or for any loss of data, arising
          from your use of — or inability to use — Hubble. You are responsible for your own backups (for
          example, using Hubble&apos;s export feature) if that data matters to you. This holds whether or not
          you sign in: syncing keeps a copy on our server for your convenience, but it is not a backup service
          and we do not guarantee it against loss.
        </p>
      </section>

      <section>
        <h2>Changes to These Terms</h2>
        <p>
          These terms may be updated from time to time. Continued use of Hubble after an update constitutes
          acceptance of the revised terms. The &quot;Last updated&quot; date above reflects the most recent
          change.
        </p>
      </section>

      <section>
        <h2>Termination</h2>
        <p>
          You may stop using Hubble at any time, uninstall the browser extension, and clear your browser&apos;s
          local storage to remove your workspace data from that browser. If you signed in and synced, write to{" "}
          <ContactEmail /> to have your account and the workspaces stored with it removed, since there is not
          yet a self-service way to do that. We may restrict or rate-limit access to the server-side endpoints
          (sign-in, sync, title resolution, AI features) for anyone found to be abusing them.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about these terms? Reach us at <ContactEmail />.
        </p>
      </section>
    </LegalPage>
  )
}
