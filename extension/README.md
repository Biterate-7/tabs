# TabDump browser extension

A thin Manifest V3 Chrome/Chromium extension: collects the current window's
tabs and hands them to the TabDump web app via its existing ingestion
pipeline. No build step — plain JavaScript, loaded unpacked.

## Load it locally

1. Make sure the TabDump web app is running (`npm run dev`, default `http://localhost:3000`).
2. Open `chrome://extensions`.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select this `extension/` directory.
5. Click the TabDump icon in the toolbar, then "Dump Tabs →".

## How it works

```
popup click → background.js collects + filters tabs
            → finds or opens the TabDump tab
            → content-script.js relays the payload into the page
            → src/hooks/use-extension-import.ts feeds the existing
              parse/categorize/dedupe pipeline
```

## Changing the TabDump origin

Edit `TABDUMP_ORIGIN` in `src/config.js`, and update the matching
`host_permissions` and `content_scripts.matches` entries in `manifest.json`
to the same origin (manifest match patterns are static and can't read from
`config.js`).

## Regenerating icons

`node scripts/generate-icons.mjs` — see that file for why icons are
generated rather than checked in as designed assets.
