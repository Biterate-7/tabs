export type ResolverContext = {
  url: string;
  hostname: string;
  pathname: string;
};

export type ResolverFailureReason =
  | "invalid-url"
  | "not-found"
  | "blocked"
  | "auth-required"
  | "timeout"
  | "network-error"
  | "no-title";

export type ResolverResult =
  | { ok: true; title: string; source: string }
  | { ok: false; reason: ResolverFailureReason; permanent: boolean };

export interface TitleResolver {
  id: string;
  canHandle(ctx: ResolverContext): boolean;
  resolve(ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult>;
}

export function toResolverContext(url: string): ResolverContext {
  const parsed = new URL(url);
  return {
    url,
    hostname: parsed.hostname.toLowerCase(),
    pathname: parsed.pathname,
  };
}

export type TitleApiResult =
  | { url: string; ok: true; title: string; source: string }
  | { url: string; ok: false; reason: ResolverFailureReason; permanent: boolean };
