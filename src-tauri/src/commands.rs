//! The complete native surface TabDump's frontend can reach.
//!
//! There are exactly two commands, and both are deliberately shaped so the
//! frontend cannot express a dangerous request in the first place:
//!
//! * `open_external` takes a URL and refuses anything that isn't http(s), so
//!   `file:`, `javascript:` and OS-handler schemes (`ms-settings:`, `mailto:`)
//!   are unreachable. The JS `opener` plugin is intentionally NOT enabled —
//!   if it were, the frontend could open arbitrary URLs without this check.
//! * `export_text_file` takes a *suggested filename* and the text, never a
//!   path. The path comes from the native save dialog the user just
//!   interacted with, so the only file this app can write is one the user
//!   picked by hand. The `fs` plugin is likewise not enabled, so there is no
//!   general filesystem access to scope or leak.

use tauri::Url;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Opens `url` in the user's default browser.
///
/// This is what keeps the TabDump window from becoming a general-purpose
/// browser: a saved tab is somebody else's webpage, and it belongs in the
/// browser the user actually chose, not inside this app's webview. See
/// `src/lib/platform/desktop.ts` for the caller, and `lib.rs`'s navigation
/// guard for the backstop that catches anything routed around it.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Not a valid URL.".to_string())?;

    // Safelist, not a blocklist — mirrors isSafeOpenUrl() in
    // src/lib/browser/protocol.ts and the extension's own copy.
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Refusing to open a {other}: URL.")),
    }

    app.opener()
        .open_url(parsed.to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Shows a native "Save as…" dialog seeded with `suggested_name`, then writes
/// `contents` to whatever the user chose.
///
/// `Ok(false)` means the user cancelled — a normal outcome, not an error, so
/// the UI can stay silent rather than reporting a failed export.
#[tauri::command]
pub async fn export_text_file(
    app: tauri::AppHandle,
    suggested_name: String,
    contents: String,
) -> Result<bool, String> {
    // `blocking_save_file` is safe here: Tauri runs async commands off the
    // main thread, which is the deadlock this API warns about.
    let chosen = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .blocking_save_file();

    let Some(chosen) = chosen else {
        return Ok(false);
    };

    let path = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(true)
}
