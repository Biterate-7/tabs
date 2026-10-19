//! Hubble desktop shell.
//!
//! This crate deliberately contains no product logic. Hubble's workspaces,
//! spatial graph, search, History Dump and import/export all live in the
//! shared frontend (`src/`), exactly as they do on the web — the desktop
//! build ships that same code as a static export. What lives here is only
//! what a webview cannot do for itself: open a saved tab in the real
//! browser, write an export to a real file, keep the window from wandering
//! off the app, and take tabs straight from the Chrome extension
//! (src/import_bridge.rs).

mod commands;
mod import_bridge;

use std::sync::{Arc, Mutex};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// Origins the app window is allowed to *stay on*.
///
/// `tauri://localhost` is the packaged frontend (Windows serves the same
/// content from `http://tauri.localhost`). `localhost`/`127.0.0.1` covers
/// `npm run desktop:dev`, where the window loads the Next dev server so hot
/// reload works.
fn is_internal(url: &tauri::Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    matches!(
        url.host_str(),
        Some("tauri.localhost") | Some("localhost") | Some("127.0.0.1")
    )
}

/// A webpage that belongs in the user's browser rather than in this window.
/// Everything else that tries to leave the app (`mailto:`, `file:`, OS
/// handler schemes) goes nowhere, matching `open_external`'s safelist.
fn belongs_in_browser(url: &tauri::Url) -> bool {
    !is_internal(url) && matches!(url.scheme(), "http" | "https")
}

pub fn run() {
    tauri::Builder::default()
        // First, so a second launch exits before it builds anything. Opening
        // `hubble://import` (the Chrome extension starting Hubble) while Hubble
        // is already open lands here too: the running window comes forward and
        // no second window is ever made.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            import_bridge::focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        // Rust-side only (commands::open_external). By default the plugin also
        // injects a click handler that cancels every `<a target="_blank">`
        // and asks `plugin:opener|open_url` instead — a permission this app
        // deliberately never grants, so those links did nothing. Without it
        // they reach `on_new_window` below.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::open_external,
            commands::export_text_file,
            commands::export_file,
            import_bridge::desktop_import_take,
            import_bridge::desktop_import_finish
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Chrome → Hubble Desktop. The queue exists before the window
            // does, so a batch the extension sends while Hubble is still
            // starting waits here until the webview takes it.
            let bridge = Arc::new(Mutex::new(import_bridge::Bridge::default()));
            app.manage(import_bridge::ImportBridgeState(Arc::clone(&bridge)));
            import_bridge::start(app.handle().clone(), bridge);

            // The installer registers `hubble://`; a development build
            // registers itself so the extension can start it too. A
            // `hubble://` URL carries nothing but "come forward".
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            if let Err(err) = app.deep_link().register_all() {
                eprintln!("[hubble-import] protocol-registration-failed {err}");
            }
            let focus = app.handle().clone();
            app.deep_link().on_open_url(move |_| import_bridge::focus_main_window(&focus));
            let popup_handle = handle.clone();

            // Built here rather than declared in tauri.conf.json because
            // `on_navigation` can only be attached at build time, and that
            // guard is the thing standing between "a desktop app" and "a
            // second-rate browser".
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Hubble")
                .inner_size(1280.0, 840.0)
                // Below roughly this, the spatial graph's controls and the
                // sidebar start overlapping rather than reflowing.
                .min_inner_size(940.0, 600.0)
                .resizable(true)
                .visible(true)
                // Tauri's own drop handler swallows files dropped on the
                // window, so the page never saw them: without it, a file
                // dragged from Explorer onto a project uploads it (the page
                // handles every drop itself, and a drop it doesn't handle
                // would be a file: navigation, which on_navigation refuses).
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    if is_internal(&url) {
                        return true;
                    }

                    // Something asked to leave the app — a saved tab opened
                    // through a path that bypassed the platform layer, or an
                    // ordinary <a href> in the UI. Hand it to the real
                    // browser and refuse the navigation, so the Hubble
                    // window always still shows Hubble.
                    if belongs_in_browser(&url) {
                        let _ = commands::open_external(handle.clone(), url.to_string());
                    }
                    false
                })
                // `<a target="_blank">` and `window.open()` never reach
                // `on_navigation`: they ask for a new window instead, and
                // with no handler WebView2 silently refuses every one — so
                // each such link in the UI (store listing, provider docs,
                // "manage connectors on the web") did nothing at all. A
                // webpage goes to the default browser; no second app window
                // is ever created.
                .on_new_window(move |url, _features| {
                    if belongs_in_browser(&url) {
                        let _ = commands::open_external(popup_handle.clone(), url.to_string());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            // Restores the size/position from the previous run. Failure here
            // is not fatal: a first launch, or an unreadable state file,
            // should just mean the configured default size above.
            let _ = window.restore_state(StateFlags::all());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hubble");
}

#[cfg(test)]
mod tests {
    use super::{belongs_in_browser, is_internal};
    use tauri::Url;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn the_app_and_dev_server_stay_in_the_window() {
        for raw in ["tauri://localhost/", "http://tauri.localhost/privacy/", "http://localhost:3000/", "http://127.0.0.1:3000/"] {
            assert!(is_internal(&url(raw)), "{raw}");
            assert!(!belongs_in_browser(&url(raw)), "{raw}");
        }
    }

    #[test]
    fn webpages_go_to_the_browser_and_nothing_else_does() {
        assert!(belongs_in_browser(&url("https://hubble-hq.vercel.app/")));
        assert!(belongs_in_browser(&url("http://example.com/page")));
        for raw in ["mailto:someone@example.com", "file:///C:/Windows/win.ini", "ms-settings:privacy", "javascript:alert(1)"] {
            assert!(!belongs_in_browser(&url(raw)), "{raw}");
        }
    }
}
