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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
