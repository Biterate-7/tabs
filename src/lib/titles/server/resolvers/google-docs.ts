import "server-only";
import type { ResolverContext, ResolverResult, TitleResolver } from "@/lib/titles/types";
import { isGoogleDocsHostname, stripGoogleDocsSuffix } from "@/lib/titles/google-docs-host";
import { extractTitleFromHtml, fetchHtmlCapped } from "./generic";

/**
 * Public docs only: this resolver never authenticates. A private/auth-walled
 * document redirects to a Google accounts login page, which this detects and
 * reports as `auth-required` rather than mislabeling the tab with the login
 * page's own title. Full OAuth-based Drive access is a separate, larger
 * effort and is intentionally out of scope here.
 */
export const googleDocsResolver: TitleResolver = {
  id: "google-docs",
  canHandle(ctx: ResolverContext): boolean {
    return isGoogleDocsHostname(ctx.hostname);
  },
  async resolve(ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    const fetched = await fetchHtmlCapped(ctx.url, signal);
    if (!fetched.ok) {
      return { ok: false, reason: fetched.reason, permanent: false };
    }

    let finalHostname: string;
    try {
      finalHostname = new URL(fetched.finalUrl).hostname;
    } catch {
      finalHostname = ctx.hostname;
    }

    if (
      finalHostname === "accounts.google.com" ||
      fetched.status === 401 ||
      fetched.status === 403
    ) {
      return { ok: false, reason: "auth-required", permanent: false };
    }

    if (fetched.status === 404) {
      return { ok: false, reason: "not-found", permanent: true };
    }

    if (fetched.status < 200 || fetched.status >= 300) {
      return { ok: false, reason: "blocked", permanent: false };
    }

    const rawTitle = await extractTitleFromHtml(fetched.html);
    if (!rawTitle) {
      return { ok: false, reason: "no-title", permanent: true };
    }

    const title = stripGoogleDocsSuffix(rawTitle);
    if (!title) {
      return { ok: false, reason: "no-title", permanent: true };
    }

    return { ok: true, title, source: "google-docs" };
  },
};
