//! Hubble desktop shell.
//!
//! This crate deliberately contains no product logic. Hubble's workspaces,
//! spatial graph, search, History Dump and import/export all live in the
//! shared frontend (`src/`), exactly as they do on the web — the desktop
//! build ships that same code as a static export. What lives here is only
//! what a webview cannot do for itself: open a saved tab in the real
//! browser, write an export to a real file, and keep the window from
//! wandering off the app.

mod agent_runtime;
mod commands;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // The last two are the agent runtime bridge (Phase J.1); see
        // src/agent_runtime.rs for what each enforces.
        .invoke_handler(tauri::generate_handler![
            commands::open_external,
            commands::export_text_file,
            agent_runtime::agent_runtime,
            agent_runtime::agent_pick_project_folder
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // The folders the user has picked for agent projects, kept in the
            // app's own data directory. The sidecar itself starts lazily, on
            // the first agent request, so an app that never opens the
            // command centre never starts a Node process.
            let folders = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("agent-project-folders.json"))
                .unwrap_or_else(|_| std::env::temp_dir().join("tabdump-agent-project-folders.json"));
            app.manage(agent_runtime::AgentRuntimeState::new(folders));

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
                .on_navigation(move |url| {
                    if is_internal(&url) {
                        return true;
                    }

                    // Something asked to leave the app — a saved tab opened
                    // through a path that bypassed the platform layer, or an
                    // ordinary <a href> in the UI. Hand it to the real
                    // browser and refuse the navigation, so the Hubble
                    // window always still shows Hubble.
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = commands::open_external(handle.clone(), url.to_string());
                    }
                    false
                })
                .build()?;

            // Restores the size/position from the previous run. Failure here
            // is not fatal: a first launch, or an unreadable state file,
            // should just mean the configured default size above.
            let _ = window.restore_state(StateFlags::all());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hubble")
        .run(|app, event| {
            // Agent processes end with the app. Asked first, so sessions end
            // cleanly; the job object in agent_runtime.rs is what guarantees it
            // even when this never runs (a crash, or a kill from Task Manager).
            if let RunEvent::Exit = event {
                app.state::<agent_runtime::AgentRuntimeState>().shutdown();
            }
        });
}
