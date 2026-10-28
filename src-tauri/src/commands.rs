//! The complete native surface Hubble's frontend can reach.
//!
//! There are four commands, all deliberately shaped so the frontend cannot
//! express a dangerous request in the first place:
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
//! * `export_file` is the same for bytes — an uploaded file's original,
//!   saved back out — with the name in a header and the bytes as the raw
//!   request body.
//! * `app_info` takes nothing and reads nothing from the machine beyond
//!   constants compiled into this binary: its version, OS and architecture,
//!   for Settings → Desktop app.

use tauri::Url;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Opens `url` in the user's default browser.
///
/// This is what keeps the Hubble window from becoming a general-purpose
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

/// What Settings → Desktop app shows about this install.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// `version` in tauri.conf.json, compiled in: the version actually installed.
    version: String,
    tauri_version: &'static str,
    os: &'static str,
    arch: &'static str,
    debug: bool,
}

/// The running binary's version, OS and build type. Compile-time constants
/// only — no file, registry or network read.
#[tauri::command]
pub fn app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        debug: cfg!(debug_assertions),
    }
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

/// Largest file `export_file` writes: an uploaded file's original is at most
/// 25 MB (src/lib/files/formats.ts), so anything bigger is not one.
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// A header value `encodeURIComponent` produced, decoded. Invalid escapes are
/// kept as typed; the result only ever seeds the Save dialog's name field.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The last path component of a suggested name, without characters Windows
/// refuses in a file name. Never a path: the user picks where it goes.
fn safe_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.chars().take(200).collect()
    }
}

/// Shows a native "Save as…" dialog and writes the raw bytes of the request
/// body — an uploaded file's original, given back to the person who added it.
///
/// Same shape as `export_text_file`: the frontend sends a *suggested name*
/// (in the `x-file-name` header, URI-encoded) and the bytes, never a path.
/// The body is the IPC's raw binary payload, so a 25 MB PDF is not inflated
/// into a JSON array of numbers on the way.
#[tauri::command]
pub async fn export_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let tauri::ipc::InvokeBody::Raw(contents) = request.body() else {
        return Err("Expected the file's bytes.".to_string());
    };
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("That file is too large to save.".to_string());
    }
    let suggested_name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .map(percent_decode)
        .map(|name| safe_file_name(&name))
        .unwrap_or_else(|| "file".to_string());

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

#[cfg(test)]
mod tests {
    use super::{percent_decode, safe_file_name};

    #[test]
    fn suggested_names_decode_and_never_carry_a_path() {
        assert_eq!(percent_decode("lecture%204.pdf"), "lecture 4.pdf");
        assert_eq!(percent_decode("caf%C3%A9.docx"), "café.docx");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(safe_file_name("..\\..\\Windows\\win.ini"), "win.ini");
        assert_eq!(safe_file_name("a/b/c:d?.pdf"), "cd.pdf");
        assert_eq!(safe_file_name("..."), "file");
        assert_eq!(safe_file_name(""), "file");
    }
}
