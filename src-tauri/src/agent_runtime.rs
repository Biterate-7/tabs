//! The desktop app's bridge to its agent runtime (Phase J.1).
//!
//! # Shape
//!
//! TabDump's agent runtime — the Phase J `RuntimeHost`, its control service,
//! approval broker, adapters and launch allowlist — is TypeScript. On the web
//! it runs inside the Next server. The packaged app has no server, so it runs
//! the same code as a **sidecar**: the Node binary TabDump ships, running the
//! one bundled file `agent-runtime/runtime.mjs`. This module is the whole
//! bridge between the webview and that process:
//!
//! ```text
//! webview ──invoke("agent_runtime", request)──▶ Rust ──stdin line──▶ sidecar
//!         ◀─────────────── response ────────────────── ◀──stdout line──┘
//! ```
//!
//! No port is opened. The sidecar's only input is a pipe this process holds,
//! so nothing else on the machine — and nothing on the network — can drive it.
//!
//! # What Rust enforces rather than trusts
//!
//! * **Project folders come from the native picker.** The webview can name a
//!   project root only in `authorize_projects`, and Rust refuses that command
//!   unless every path in it is one the user picked in the native folder
//!   dialog (`agent_pick_project_folder`). The TypeScript validator still runs
//!   inside the sidecar; this is the boundary a compromised webview cannot
//!   talk its way past.
//! * **The sidecar is fixed.** A binary and a script at paths inside the
//!   installed app, with no argument taken from anywhere. The webview names
//!   *operations*; the closed runtime protocol has no field for a command line.
//! * **The environment is an allowlist**, the same list as
//!   `src/lib/agents/launch/env.ts`. No key, token or TabDump secret reaches
//!   the sidecar or, through it, an agent.
//! * **Nothing outlives the app.** The sidecar is placed in a Windows job
//!   object that kills its whole process tree — every agent it started — when
//!   TabDump's handle closes, including on a crash. On a normal exit the
//!   sidecar is asked to shut down first, which ends sessions cleanly.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// The largest request the webview may send. Matches `MAX_DESKTOP_LINE_BYTES`.
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

/// Folders the user may authorize, at most. Matches the runtime's own cap.
const MAX_PICKED_FOLDERS: usize = 100;

/// Mirrors `AGENT_ENV_ALLOWLIST` in src/lib/agents/launch/env.ts. The sidecar
/// is given these and nothing else; the launch layer narrows again per agent.
pub const SIDECAR_ENV_ALLOWLIST: &[&str] = &[
    "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
    "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
];

/// Filtered once, in one place, so nothing else can widen it.
pub fn sidecar_environment(source: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    source
        .filter(|(key, value)| !value.is_empty() && SIDECAR_ENV_ALLOWLIST.contains(&key.as_str()))
        .collect()
}

/* ------------------------------------------------------------------ *
 * Picked folders
 * ------------------------------------------------------------------ */

/// A folder's comparison form: separators unified, trailing separator
/// dropped and — on Windows, where the filesystem is case-insensitive —
/// lowercased. Used only to compare; the original spelling is what is shown.
pub fn folder_key(path: &str) -> String {
    let unified: String = path.trim().replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// The folders the user picked in the native dialog, persisted so a project
/// authorized last week still resolves after a restart.
#[derive(Default)]
pub struct FolderRegistry {
    keys: Vec<String>,
    file: Option<PathBuf>,
}

impl FolderRegistry {
    pub fn load(file: PathBuf) -> Self {
        let keys = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default()
            .into_iter()
            .take(MAX_PICKED_FOLDERS)
            .collect();
        FolderRegistry { keys, file: Some(file) }
    }

    pub fn contains(&self, path: &str) -> bool {
        self.keys.contains(&folder_key(path))
    }

    pub fn add(&mut self, path: &str) {
        let key = folder_key(path);
        self.keys.retain(|existing| existing != &key);
        self.keys.insert(0, key);
        self.keys.truncate(MAX_PICKED_FOLDERS);
        if let Some(file) = &self.file {
            if let Some(parent) = file.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(file, serde_json::to_string(&self.keys).unwrap_or_default());
        }
    }
}

/// Why a request was refused before it reached the sidecar.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    TooLarge,
    Malformed,
    /// `authorize_projects` named a folder the user never picked.
    UnpickedFolder,
}

/// Checks a webview request before it is forwarded, and says which command it
/// is (for the timeout).
///
/// Only one command can carry a filesystem path — `authorize_projects` — and
/// every path in it must have come from the native picker. Everything else is
/// forwarded as-is: the sidecar parses it against the closed protocol and
/// drops anything the union does not name.
pub fn screen_request(raw: &str, folders: &FolderRegistry) -> Result<String, Refusal> {
    if raw.len() > MAX_REQUEST_BYTES {
        return Err(Refusal::TooLarge);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| Refusal::Malformed)?;
    let name = value
        .get("command")
        .and_then(|command| command.get("name"))
        .and_then(Value::as_str)
        .ok_or(Refusal::Malformed)?
        .to_string();

    if name == "authorize_projects" {
        let projects = value["command"]["projects"].as_array().ok_or(Refusal::Malformed)?;
        for project in projects {
            let path = project.get("path").and_then(Value::as_str).ok_or(Refusal::Malformed)?;
            if !folders.contains(path) {
                return Err(Refusal::UnpickedFolder);
            }
            if let Some(extra) = project.get("additionalDirectories").and_then(Value::as_array) {
                for directory in extra {
                    let directory = directory.as_str().ok_or(Refusal::Malformed)?;
                    if !folders.contains(directory) {
                        return Err(Refusal::UnpickedFolder);
                    }
                }
            }
        }
    }
    Ok(name)
}

/// How long the webview waits for a command. Signing in waits on a person in a
/// browser; starting a session may wait on an agent's first handshake.
pub fn timeout_for(command: &str) -> Duration {
    match command {
        "authenticate_provider" => Duration::from_secs(11 * 60),
        "create_session" | "connect_provider" | "resume_session" | "disconnect_provider" => {
            Duration::from_secs(180)
        }
        _ => Duration::from_secs(120),
    }
}

/// A runtime failure in the protocol's own shape, so the webview's client
/// handles a bridge refusal exactly like a runtime one.
pub fn failure(code: &str, message: &str) -> String {
    json!({ "ok": false, "error": { "code": code, "message": message } }).to_string()
}

/* ------------------------------------------------------------------ *
 * The sidecar process
 * ------------------------------------------------------------------ */

type Pending = Arc<Mutex<HashMap<u64, Sender<String>>>>;

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    alive: Arc<Mutex<bool>>,
    #[cfg(windows)]
    _job: job::KillOnCloseJob,
}

#[derive(Default)]
pub struct AgentRuntimeState {
    sidecar: Mutex<Option<Sidecar>>,
    next_id: AtomicU64,
    folders: Mutex<FolderRegistry>,
}

impl AgentRuntimeState {
    pub fn new(folder_file: PathBuf) -> Self {
        AgentRuntimeState {
            sidecar: Mutex::new(None),
            next_id: AtomicU64::new(1),
            folders: Mutex::new(FolderRegistry::load(folder_file)),
        }
    }

    /// Asks the sidecar to end its sessions, then makes sure it is gone.
    pub fn shutdown(&self) {
        let Some(mut sidecar) = self.sidecar.lock().ok().and_then(|mut slot| slot.take()) else {
            return;
        };
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let _ = writeln!(sidecar.stdin, "{}", json!({ "id": id, "shutdown": true }));
        let _ = sidecar.stdin.flush();
        for _ in 0..30 {
            if matches!(sidecar.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = sidecar.child.kill();
        let _ = sidecar.child.wait();
        // The job object's handle closes when `sidecar` drops here, which
        // takes every remaining descendant with it.
    }
}

/// Turns a Windows verbatim path (`\\?\C:\…`) into its ordinary form.
///
/// Tauri's `resource_dir()` returns the verbatim form, and Node cannot load a
/// module from one — it fails with `EISDIR: lstat 'C:'` before running a line.
/// Only the drive-letter form is rewritten; a verbatim UNC path is left alone,
/// since dropping its prefix would change which machine it names.
pub fn ordinary_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest)
            if rest.len() >= 2
                && rest.as_bytes()[1] == b':'
                && rest.as_bytes()[0].is_ascii_alphabetic() =>
        {
            PathBuf::from(rest.to_string())
        }
        _ => path,
    }
}

/// Where the installed app keeps the sidecar: the Node binary beside
/// TabDump's own executable (Tauri's `externalBin`), the script in resources.
fn sidecar_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|_| "no executable path".to_string())?;
    let dir = ordinary_path(exe.parent().ok_or("no executable directory")?.to_path_buf());
    let node = dir.join(if cfg!(windows) { "tabdump-agent-node.exe" } else { "tabdump-agent-node" });
    let script = ordinary_path(
        app.path()
            .resource_dir()
            .map_err(|_| "no resource directory".to_string())?,
    )
    .join("agent-runtime")
    .join("runtime.mjs");
    if !node.is_file() || !script.is_file() {
        return Err("The agent runtime is not installed with this build of TabDump.".into());
    }
    Ok((node, script))
}

/// Where the sidecar's stderr goes: nowhere, unless a developer asked.
///
/// `TABDUMP_AGENT_RUNTIME_LOG` names a file to append it to — for diagnosing a
/// sidecar that will not start. Off by default: stderr is the agents' own
/// diagnostic channel and may echo anything, so nothing is kept unless someone
/// deliberately turned this on for their own machine.
fn diagnostic_stderr() -> Stdio {
    std::env::var_os("TABDUMP_AGENT_RUNTIME_LOG")
        .and_then(|path| std::fs::OpenOptions::new().create(true).append(true).open(path).ok())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null)
}

fn spawn_sidecar(node: &Path, script: &Path) -> Result<Sidecar, String> {
    let mut command = Command::new(node);
    command
        .arg(script)
        .env_clear()
        .envs(sidecar_environment(std::env::vars()))
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(diagnostic_stderr());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: Node is a console program, and TabDump is not.
        command.creation_flags(0x0800_0000);
    }

    let mut child = command.spawn().map_err(|_| "Could not start the agent runtime.".to_string())?;

    #[cfg(windows)]
    let job = {
        let job = job::KillOnCloseJob::new().map_err(|_| "Could not contain the agent runtime.".to_string())?;
        if job.assign(&child).is_err() {
            let _ = child.kill();
            return Err("Could not contain the agent runtime.".into());
        }
        job
    };

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(Mutex::new(true));

    {
        let pending = pending.clone();
        let alive = alive.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                let (Some(id), Some(response)) = (message.get("id").and_then(Value::as_u64), message.get("response")) else {
                    continue;
                };
                if let Some(waiter) = pending.lock().ok().and_then(|mut map| map.remove(&id)) {
                    let _ = waiter.send(response.to_string());
                }
            }
            // The sidecar is gone. Everyone still waiting is told so now,
            // rather than at their timeout.
            if let Ok(mut flag) = alive.lock() {
                *flag = false;
            }
            if let Ok(mut map) = pending.lock() {
                map.clear();
            }
        });
    }

    Ok(Sidecar {
        child,
        stdin,
        pending,
        alive,
        #[cfg(windows)]
        _job: job,
    })
}

/// Relays one runtime request from the webview to the sidecar.
///
/// Starts the sidecar on first use, and again if it has exited: a new process
/// has a new runtime id, and the webview's client re-handshakes on the
/// `runtime_disconnected` it gets meanwhile — the same path a restarted dev
/// server takes on the web.
#[tauri::command]
pub async fn agent_runtime(app: tauri::AppHandle, request: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || relay(&app, &request))
        .await
        .map_err(|_| "The agent runtime did not answer.".to_string())
}

fn relay(app: &tauri::AppHandle, request: &str) -> String {
    let state = app.state::<AgentRuntimeState>();

    let command = {
        let folders = match state.folders.lock() {
            Ok(folders) => folders,
            Err(_) => return failure("runtime_unavailable", "TabDump cannot run agents in this environment."),
        };
        match screen_request(request, &folders) {
            Ok(command) => command,
            Err(Refusal::UnpickedFolder) => {
                return failure("project_scope_violation", "This agent is not authorized for that project.")
            }
            Err(_) => return failure("invalid_request", "TabDump could not read that request."),
        }
    };

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = channel::<String>();

    {
        let mut slot = match state.sidecar.lock() {
            Ok(slot) => slot,
            Err(_) => return failure("runtime_unavailable", "TabDump cannot run agents in this environment."),
        };

        let dead = slot
            .as_ref()
            .map(|sidecar| !sidecar.alive.lock().map(|flag| *flag).unwrap_or(false))
            .unwrap_or(true);
        if dead {
            *slot = None;
            match sidecar_paths(app).and_then(|(node, script)| spawn_sidecar(&node, &script)) {
                Ok(sidecar) => *slot = Some(sidecar),
                Err(_) => return failure("runtime_unavailable", "TabDump cannot run agents in this environment."),
            }
        }

        let Some(sidecar) = slot.as_mut() else {
            return failure("runtime_unavailable", "TabDump cannot run agents in this environment.");
        };
        if let Ok(mut map) = sidecar.pending.lock() {
            map.insert(id, sender);
        }
        let line = json!({ "id": id, "request": serde_json::from_str::<Value>(request).unwrap_or(Value::Null) });
        if writeln!(sidecar.stdin, "{line}").and_then(|_| sidecar.stdin.flush()).is_err() {
            *slot = None;
            return failure("runtime_disconnected", "TabDump lost its connection to the local runtime.");
        }
    }

    match receiver.recv_timeout(timeout_for(&command)) {
        Ok(response) => response,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            failure("timeout", "The agent did not respond in time.")
        }
        // The sidecar exited while this request was outstanding. Said as what
        // it is, so the client re-handshakes rather than waiting on a timeout.
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            failure("runtime_disconnected", "TabDump lost its connection to the local runtime.")
        }
    }
}

/* ------------------------------------------------------------------ *
 * The native folder picker
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
pub struct PickedFolder {
    path: String,
    name: String,
}

/// Shows the native folder dialog and records the folder the user chose as
/// one a project may be rooted in. `None` when they cancel.
///
/// The one way a filesystem path enters the agent runtime on the desktop: the
/// user pointed at it, in a dialog the webview cannot fill in.
#[tauri::command]
pub async fn agent_pick_project_folder(app: tauri::AppHandle) -> Result<Option<PickedFolder>, String> {
    let chosen = app.dialog().file().set_title("Choose a project folder for your agent").blocking_pick_folder();
    let Some(chosen) = chosen else { return Ok(None) };
    let path = chosen.into_path().map_err(|_| "That folder cannot be used.".to_string())?;
    let display = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| display.clone());

    let state = app.state::<AgentRuntimeState>();
    state.folders.lock().map_err(|_| "unavailable".to_string())?.add(&display);
    Ok(Some(PickedFolder { path: display, name }))
}

/* ------------------------------------------------------------------ *
 * Process containment (Windows)
 * ------------------------------------------------------------------ */

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job whose every process is terminated when its last handle closes.
    ///
    /// The only handle is this struct's, held by TabDump. So the sidecar and
    /// every agent it started die with TabDump — on quit, on crash, on being
    /// killed from Task Manager — and nothing can be left running.
    pub struct KillOnCloseJob(HANDLE);

    // The handle is an opaque kernel object, used only through thread-safe APIs.
    unsafe impl Send for KillOnCloseJob {}

    impl KillOnCloseJob {
        pub fn new() -> Result<Self, ()> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return Err(());
                }
                Ok(KillOnCloseJob(handle))
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> Result<(), ()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                Err(())
            } else {
                Ok(())
            }
        }
    }

    impl Drop for KillOnCloseJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(paths: &[&str]) -> FolderRegistry {
        let mut folders = FolderRegistry::default();
        for path in paths {
            folders.add(path);
        }
        folders
    }

    fn authorize(path: &str, extra: &[&str]) -> String {
        json!({
            "runtimeId": "r1",
            "command": {
                "name": "authorize_projects",
                "projects": [{
                    "id": "p1", "name": "Research", "path": path, "providers": ["claude-code"],
                    "additionalDirectories": extra,
                    "permissions": { "scopes": ["read_project"], "projectId": "p1", "grantedAt": 1 }
                }]
            }
        })
        .to_string()
    }

    #[test]
    fn forwards_ordinary_commands_and_names_them() {
        let folders = FolderRegistry::default();
        let request = json!({ "command": { "name": "get_status" } }).to_string();
        assert_eq!(screen_request(&request, &folders), Ok("get_status".to_string()));
    }

    #[test]
    fn authorizes_only_folders_the_user_picked() {
        let folders = registry(&["C:\\work\\research"]);
        assert_eq!(
            screen_request(&authorize("C:\\work\\research", &[]), &folders),
            Ok("authorize_projects".to_string())
        );
        assert_eq!(
            screen_request(&authorize("C:\\Users\\alice", &[]), &folders),
            Err(Refusal::UnpickedFolder)
        );
        assert_eq!(
            screen_request(&authorize("C:\\work\\research", &["C:\\Windows"]), &folders),
            Err(Refusal::UnpickedFolder)
        );
    }

    #[test]
    fn compares_folders_by_form_not_spelling() {
        let folders = registry(&["C:\\work\\research\\"]);
        assert!(folders.contains("C:/work/research"));
        if cfg!(windows) {
            assert!(folders.contains("c:\\WORK\\Research"));
        }
        // A child of a picked folder is not the picked folder.
        assert!(!folders.contains("C:\\work\\research\\sub"));
        assert!(!folders.contains("C:\\work"));
    }

    #[test]
    fn refuses_oversized_and_malformed_requests() {
        let folders = FolderRegistry::default();
        assert_eq!(screen_request(&"x".repeat(MAX_REQUEST_BYTES + 1), &folders), Err(Refusal::TooLarge));
        assert_eq!(screen_request("not json", &folders), Err(Refusal::Malformed));
        assert_eq!(screen_request("{\"command\":{}}", &folders), Err(Refusal::Malformed));
        assert_eq!(
            screen_request("{\"command\":{\"name\":\"authorize_projects\",\"projects\":[{}]}}", &folders),
            Err(Refusal::Malformed)
        );
    }

    #[test]
    fn gives_the_sidecar_an_allowlisted_environment() {
        let env = sidecar_environment(
            vec![
                ("PATH".to_string(), "C:\\Tools".to_string()),
                ("USERPROFILE".to_string(), "C:\\Users\\alice".to_string()),
                ("ANTHROPIC_API_KEY".to_string(), "sk-secret".to_string()),
                ("OPENAI_API_KEY".to_string(), "sk-secret".to_string()),
                ("TABDUMP_CREDENTIAL_KEY".to_string(), "k".to_string()),
                ("POSTGRES_URL".to_string(), "postgres://x".to_string()),
                ("NODE_OPTIONS".to_string(), "--require evil.js".to_string()),
            ]
            .into_iter(),
        );
        let keys: Vec<&str> = env.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, vec!["PATH", "USERPROFILE"]);
    }

    #[test]
    fn hands_node_an_ordinary_path_not_a_verbatim_one() {
        // What Tauri's resource_dir() returns on Windows, and what Node needs.
        assert_eq!(
            ordinary_path(PathBuf::from(r"\\?\C:\Users\alice\AppData\Local\Programs\TabDump")),
            PathBuf::from(r"C:\Users\alice\AppData\Local\Programs\TabDump")
        );
        assert_eq!(ordinary_path(PathBuf::from(r"C:\already\plain")), PathBuf::from(r"C:\already\plain"));
        // A verbatim UNC path names another machine; its prefix is not ours to drop.
        let unc = PathBuf::from(r"\\?\UNC\server\share\TabDump");
        assert_eq!(ordinary_path(unc.clone()), unc);
    }

    #[test]
    fn waits_longest_for_a_person_signing_in_v1() {
        assert!(timeout_for("authenticate_provider") > timeout_for("create_session"));
        assert!(timeout_for("create_session") > timeout_for("get_events"));
    }

    #[test]
    fn persists_picked_folders_across_restarts() {
        let file = std::env::temp_dir().join(format!("tabdump-folders-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&file);
        FolderRegistry::load(file.clone()).add("C:\\work\\research");
        assert!(FolderRegistry::load(file.clone()).contains("C:\\work\\research"));
        let _ = std::fs::remove_file(&file);
    }

    #[cfg(windows)]
    #[test]
    fn a_job_kills_its_processes_when_closed() {
        // A plain long-running program, started directly — no shell here either.
        let mut child = Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn");
        let job = job::KillOnCloseJob::new().expect("job");
        job.assign(&child).expect("assign");
        drop(job);
        let mut exited = false;
        for _ in 0..50 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(exited, "closing the job must terminate the process");
    }
}

#[cfg(test)]
mod installed_probe {
    use super::*;

    /// Diagnostic: drives the installed sidecar through the real spawn path.
    /// Run with `cargo test installed_sidecar -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn installed_sidecar_answers() {
        let dir = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("Programs").join("TabDump");
        let mut sidecar = spawn_sidecar(&dir.join("tabdump-agent-node.exe"), &dir.join("agent-runtime").join("runtime.mjs")).expect("spawn");
        let (sender, receiver) = channel::<String>();
        sidecar.pending.lock().unwrap().insert(1, sender);
        writeln!(sidecar.stdin, "{}", json!({"id": 1, "request": {"command": {"name": "get_status"}}})).unwrap();
        sidecar.stdin.flush().unwrap();
        let reply = receiver.recv_timeout(Duration::from_secs(20));
        println!("reply: {:?}", reply.as_ref().map(|r| &r[..r.len().min(200)]));
        println!("exit: {:?}", sidecar.child.try_wait());
        assert!(reply.is_ok());
    }
}
