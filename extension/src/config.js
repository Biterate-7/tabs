// Single place to change if TabDump is ever deployed somewhere other than
// local dev. Must match a `host_permissions` entry and a `content_scripts`
// match pattern in manifest.json (manifest patterns are static, so those
// need updating by hand too if this changes).
export const TABDUMP_ORIGIN = "http://localhost:3000";

// Message-passing constants shared across background/content/popup so a
// typo in one place can't silently desync from another.
export const MESSAGE_SOURCE = "tabdump-extension";
export const MSG_DUMP_TABS = "DUMP_TABS";
export const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";

// Round-trip query the popup uses to ask the (already-open) TabDump page
// which candidate tabs are already in its currently selected workspace, so
// it can show "31 new · 16 already imported" instead of a raw count. Only
// answerable when a TabDump tab is already open — see background.js's
// checkImported for the fallback when one isn't.
export const MSG_CHECK_IMPORTED = "TABDUMP_CHECK_IMPORTED";
export const MSG_CHECK_IMPORTED_RESULT = "TABDUMP_CHECK_IMPORTED_RESULT";
