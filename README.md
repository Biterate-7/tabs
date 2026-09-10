This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Automatic organization setup

TabDump automatically organizes tabs into workspaces (and groups) right after you import them, using deterministic domain/keyword clustering. Setting a Gemini key is optional and only sharpens that clustering with semantic similarity hints — nothing else in TabDump needs it, and there's no AI chat or assistant to interact with.

1. Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY`.
3. Restart `next dev` if it was already running.

The key is only ever read server-side (in Route Handlers under `src/app/api/ai/`) — it's never sent to the browser. The index itself (embeddings for your saved tabs) lives in your browser's IndexedDB, the same place the rest of TabDump keeps its data; nothing is uploaded to a database.

For a Vercel deployment, set `GEMINI_API_KEY` (and the optional `GEMINI_EMBEDDING_MODEL` override from `.env.example`) under Project Settings → Environment Variables.

## Accounts (Sign in with Google)

Optional, and off until you configure it: with no Google client ID set, TabDump makes no auth requests and shows no sign-in UI — exactly as it behaved before accounts existed.

TabDump owns the whole account system. Google only proves who someone is; the user records, sessions and authorization all live here, and there's no third-party auth platform involved. See [docs/auth-architecture.md](docs/auth-architecture.md) for the full design, including how the browser extension should authenticate later.

To turn it on:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth 2.0 Client ID** of type *Web application*. Under **Authorized JavaScript origins**, add `http://localhost:3000` and your production origin. You do **not** need an authorized redirect URI — this flow never leaves your site — and you do **not** need the client secret; nothing in this codebase reads one.
2. Set `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in `.env.local` (and in Vercel's Project Settings → Environment Variables for production).
3. For production, add a Postgres connection string as `POSTGRES_URL` (Vercel Postgres injects this for you) and apply the schema once:

```bash
npm run migrate:auth
```

Sessions are server-side rows, so production needs that database — a serverless deployment has nowhere else to keep them. Local development without one falls back to an in-memory store, so you can sign in and out immediately; those sessions just don't survive a dev-server restart.

Signing in doesn't upload anything. TabDump stays local-first — an account partitions this browser's storage so two people sharing a browser don't see each other's workspaces, and your signed-out workspaces stay exactly where they are.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
