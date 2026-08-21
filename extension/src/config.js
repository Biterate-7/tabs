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
