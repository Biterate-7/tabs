import "server-only";
import type { ResolverResult, TitleResolver } from "@/lib/titles/types";
import { toResolverContext } from "@/lib/titles/types";
import { googleDocsResolver } from "./resolvers/google-docs";
import { youtubeOEmbedResolver } from "./resolvers/youtube-oembed";
import { genericResolver } from "./resolvers/generic";

/**
 * Order matters: the first resolver whose `canHandle` matches owns the URL.
 * There is no fallthrough to the next resolver on failure — if, say, the
 * Google Docs resolver detects an auth wall, falling through to the generic
 * scraper would mislabel the tab with the login page's title, which is worse
 * than no title at all. `genericResolver.canHandle` always returns true, so
 * it's guaranteed to be last and to catch everything nothing else claimed.
 *
 * Adding a new site-specific resolver later is: write the file, add it here
 * above `genericResolver`. Nothing else in the pipeline needs to change.
 */
export const RESOLVERS: TitleResolver[] = [googleDocsResolver, youtubeOEmbedResolver, genericResolver];

const RESOLVER_TIMEOUT_MS = 6000;

export async function resolveTitle(url: string, signal?: AbortSignal): Promise<ResolverResult> {
  let ctx;
  try {
    ctx = toResolverContext(url);
  } catch {
    return { ok: false, reason: "invalid-url", permanent: true };
  }

  const resolver = RESOLVERS.find((r) => r.canHandle(ctx));
  if (!resolver) {
    return { ok: false, reason: "no-title", permanent: true };
  }

  const timeoutSignal = AbortSignal.timeout(RESOLVER_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    return await resolver.resolve(ctx, combined);
  } catch {
    return { ok: false, reason: "network-error", permanent: false };
  }
}
