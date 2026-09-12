import type { NextConfig } from "next";

/**
 * One config, two targets.
 *
 * The default branch is empty — byte for byte the web configuration this
 * project has always had, so `npm run dev`, `npm run build` and the Vercel
 * deployment are completely untouched by the desktop work. Everything
 * desktop-specific is gated behind an env var that only the `desktop:*`
 * scripts set, which is also what keeps web development free of any
 * Rust/Tauri toolchain requirement.
 */
const isDesktopBuild = process.env.TABDUMP_BUILD_TARGET === "desktop";

/**
 * The desktop build is a plain static export loaded from `tauri://localhost`
 * (`http://tauri.localhost` on Windows), which is possible here only because
 * the app genuinely is a client-side SPA: four static routes, no dynamic
 * segments, no `useRouter`/`useSearchParams`, no `next/image`, and no server
 * actions. TabDump is local-first — workspaces, collections, dependencies and
 * graph layout live in localStorage (see src/lib/storage/namespace.ts) — so
 * the exported bundle is the whole product, not a shell around a server.
 *
 * `pageExtensions: ["tsx"]` is what excludes the API layer. Every route
 * handler under src/app/api is a `route.ts`, and every page/layout is a
 * `.tsx`, so restricting the resolver to `.tsx` drops all seven handlers from
 * the desktop route tree without moving, renaming or `#ifdef`-ing a single
 * file. Those handlers read `Request` and `cookies()`, which a static export
 * cannot represent, so they must not be in the tree — and they stay exactly
 * where they are for the web build that does serve them.
 */
const nextConfig: NextConfig = isDesktopBuild
  ? {
      output: "export",
      // Emits `/privacy/index.html` rather than `/privacy.html`, which is
      // what a file-backed asset protocol can resolve without a server's
      // extensionless-path rewriting.
      trailingSlash: true,
      pageExtensions: ["tsx"],
    }
  : {};

export default nextConfig;
