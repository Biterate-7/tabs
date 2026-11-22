//! Hubble for Chrome ⇄ Hubble Desktop: the paired link.
//!
//! The import bridge (import_bridge.rs) takes things *in*: each batch of tabs
//! or each conversation waits in Hubble's window until the person accepts it.
//! That is safe without any shared secret, because nothing leaves the app.
//! But Hubble for Chrome also needs to *ask* Hubble things — the person's
//! projects (to choose where a save goes), search results and the context
//! text to bring into an AI chat — and it needs to save into a project the
//! person already chose in Chrome, without a second confirmation in the app.
//! Anything that answers with the person's data, or writes without asking,
//! must not be reachable by whatever else runs on this computer.
//!
//! # Pairing
//!
//! ```text
//! extension ── POST /v1/pair { label } ─────────────▶ pending, code "482913"   (2 minutes)
//!                                                     │ "hubble-link:pair-requested"
//!                                                     ▼
//!       Hubble's window: "Connect Hubble for Chrome? Code 482 913"  → Connect / Don't connect
//! extension ── GET  /v1/pair/:id ───────────────────▶ { status: "approved", token }  (once)
//! ```
//!
//! The popup shows the same code, so the person can see the request they
//! made is the one they are approving. Only the extension whose origin made
//! the request can collect its answer, and the token is handed over exactly
//! once. Hubble keeps only a SHA-256 of each token (in `extension-links.json`
//! in the app's data folder, readable by this account only: see
//! `write_private`), with the extension's origin; Settings lists each link
//! and disconnects it.
//!
//! # Paired requests
//!
//! ```text
//! extension ── POST /v1/link/request  Bearer token ──▶ queued for the webview  ("hubble-link:request")
//!                                                       webview answers (desktop_link_answer)
//!           ◀── { ok, result | error } ─────────────── the same HTTP response, within LINK_ANSWER_TTL
//! ```
//!
//! Every paired request needs the token *and* the origin it was issued to.
//! The request is the extension's page-request protocol (kind + args) with a
//! closed list of kinds; the webview re-reads every argument with its own
//! schema (src/lib/memory/extension-protocol.ts) before acting, exactly as it
//! did when a content script carried the same requests into the website.
//!
//! # Commands from Hubble
//!
//! The other direction: Hubble Desktop asking Chrome — the tabs open now (save
//! a session, organize, add tabs), a history range (History Dump), opening a
//! saved session in a window, context detection's settings and activity. The
//! app cannot call an extension, so the paired extension collects them:
//!
//! ```text
//! webview ── desktop_link_command(action, args) ──▶ queued here (allowlisted action, object args)
//! extension ── POST /v1/link/commands  Bearer ────▶ { commands: [{ id, action, args }] }   (marks them taken by this link)
//! extension ── POST /v1/link/result    Bearer ────▶ { id, ok, result | error }  → the webview's await resolves
//! ```
//!
//! An asleep extension (Chrome stops idle service workers) is woken by opening
//! `http://127.0.0.1:<port>/v1/wake` in the default browser — the extension
//! notices that address, closes the tab and collects. The wake carries
//! nothing: commands only ever travel over the authenticated link, so a page
//! or another extension can neither read nor inject one. Only a command the
//! person just asked for wakes Chrome; background reads (context detection's
//! pull) wait for the extension to come by on its own, which it does after
//! each nudge (`POST /v1/link/nudge`, "something changed").
//!
//! Before this channel, the same questions went through a page on Hubble's
//! website (the "relay"), which made the app depend on the website and asked
//! the person to press Send there each time.
//!
//! # Hubble proves itself first
//!
//! Nothing stops another program from listening on Hubble's ports while Hubble
//! is closed (or from starting first) — on a shared computer, another person's
//! account can. So the extension never sends its token, or anything it read,
//! to a port before that port proves it holds the link:
//!
//! ```text
//! extension ── POST /v1/link/prove { challenge } ──▶ { proofs: [HMAC(token_hash_i, "hubble-link-proof:v1:<port>:<challenge>")] }
//! ```
//!
//! The extension computes the same HMAC from SHA-256 of its own token and only
//! talks to a port whose answer contains it. The proof is bound to the port and
//! a fresh challenge, so it can't be replayed from elsewhere, and it reveals
//! nothing about the token.
//!
//! Nothing here is ever logged except ids, kinds and outcomes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Emitted when an extension asks to pair; the webview shows the dialog.
pub const PAIR_REQUESTED_EVENT: &str = "hubble-link:pair-requested";
/// Emitted when a paired request is waiting for the webview's answer.
pub const LINK_REQUEST_EVENT: &str = "hubble-link:request";

/// How long a pairing request waits for the person.
pub const PAIR_TTL: Duration = Duration::from_secs(120);
/// How long an approved token waits for the extension to collect it.
pub const PAIR_COLLECT_TTL: Duration = Duration::from_secs(60);
/// How long a paired request waits for the webview to answer.
pub const LINK_ANSWER_TTL: Duration = Duration::from_secs(25);

const MAX_PENDING_PAIRS: usize = 2;
const MAX_LINKS: usize = 8;
const MAX_WAITING_REQUESTS: usize = 16;
const MAX_LABEL_CHARS: usize = 60;

/// The requests a paired extension may make — the page-request kinds of
/// src/lib/memory/extension-protocol.ts, plus `add-sources` (tabs into a
/// chosen project). Mirrors `LINK_REQUEST_KINDS` in extension/src/desktop-link.js.
pub const LINK_REQUEST_KINDS: [&str; 8] = ["projects", "capture", "saved", "search", "bundle", "reused", "save-session", "add-sources"];

/// Emitted when the paired extension says something it keeps changed (context detection's activity).
pub const LINK_NUDGE_EVENT: &str = "hubble-link:nudge";

/// What Hubble may ask the paired extension — the browser commands of
/// src/lib/browser/protocol.ts that Hubble Desktop uses, and nothing else.
/// Mirrors `DESKTOP_COMMAND_ACTIONS` in extension/src/browser-commands.js,
/// which validates every argument again before Chrome is touched.
pub const LINK_COMMAND_ACTIONS: [&str; 13] = [
    "list_browser_tabs",
    "list_browser_windows",
    "get_history",
    "open_url",
    "open_tabs",
    "open_session",
    "get_context_settings",
    "set_context_settings",
    "request_context_access",
    "get_context_activity",
    "forget_context_activity",
    "clear_context_activity",
    "capture_context_conversation",
];
/// The longest a command may wait for the extension (a History Dump scan, a permission prompt).
pub const MAX_COMMAND_TTL: Duration = Duration::from_secs(120);
/// The extension came by this recently: it is awake and will collect without a wake.
pub const AWAKE_WINDOW: Duration = Duration::from_secs(4);
const MAX_WAITING_COMMANDS: usize = 16;
/// Arguments are small (a history range, a list of addresses to open, a settings patch).
const MAX_COMMAND_ARGS_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedLink {
    pub id: String,
    /// `chrome-extension://<id>` — the only origin this link answers.
    pub origin: String,
    pub label: String,
    /// Hex SHA-256 of the token. The token itself is never stored.
    pub token_hash: String,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
}

enum PairStage {
    Waiting,
    Approved { token: String, link_id: String },
    Denied,
}

struct PendingPair {
    origin: String,
    label: String,
    code: String,
    stage: PairStage,
    deadline: Instant,
}

struct WaitingRequest {
    link_id: String,
    body: Value,
    answer: SyncSender<Value>,
    deadline: Instant,
    taken: bool,
}

/// A command from Hubble waiting for (or being run by) the paired extension.
struct WaitingCommand {
    action: &'static str,
    args: Value,
    answer: SyncSender<Value>,
    deadline: Instant,
    /// The link that collected it; only that link may answer.
    taken_by: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRefusal {
    Unauthorized,
    NotFound,
    Busy,
    Invalid,
}

impl LinkRefusal {
    pub fn status(self) -> u16 {
        match self {
            LinkRefusal::Unauthorized => 401,
            LinkRefusal::NotFound => 404,
            LinkRefusal::Busy => 429,
            LinkRefusal::Invalid => 400,
        }
    }
    pub fn reason(self) -> &'static str {
        match self {
            LinkRefusal::Unauthorized => "not-paired",
            LinkRefusal::NotFound => "not-found",
            LinkRefusal::Busy => "busy",
            LinkRefusal::Invalid => "invalid",
        }
    }
}

/// Everything the link knows. Links persist (as hashes) through `path`;
/// pairing attempts and waiting requests are in memory only.
#[derive(Default)]
pub struct Link {
    links: Vec<PairedLink>,
    pairs: HashMap<String, PendingPair>,
    waiting: HashMap<String, WaitingRequest>,
    commands: HashMap<String, WaitingCommand>,
    /// When a paired extension last collected commands.
    last_collect: Option<Instant>,
    path: Option<PathBuf>,
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source is available");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// HMAC-SHA-256 (RFC 2104), on the sha2 crate already used here.
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.iter().map(|b| b ^ 0x36).collect::<Vec<u8>>());
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.iter().map(|b| b ^ 0x5c).collect::<Vec<u8>>());
    outer.update(inner);
    outer.finalize().into()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Six digits, uniformly drawn (rejection sampling keeps every code equally likely).
fn pairing_code() -> String {
    loop {
        let mut buf = [0u8; 4];
        getrandom::fill(&mut buf).expect("the OS random source is available");
        let n = u32::from_le_bytes(buf);
        if n < 4_294_000_000 {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

fn clean_label(raw: Option<&str>) -> String {
    let cleaned: String = raw.unwrap_or("").chars().filter(|c| !c.is_control()).take(MAX_LABEL_CHARS).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { "Hubble for Chrome".to_string() } else { trimmed.to_string() }
}

fn is_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(unix)]
const PRIVATE_DIR_MODE: u32 = 0o700;
#[cfg(unix)]
const PRIVATE_FILE_MODE: u32 = 0o600;

/// Saves the link records so that only this account can read them.
///
/// They must stay private even though they hold no token: each stored hash is
/// also the key Hubble proves itself with (`proofs`), so whoever reads this
/// file can answer `/v1/link/prove` as Hubble from a port Hubble isn't on,
/// and the extension would then hand that program its token.
///
/// - macOS and Linux: a missing folder is created `0700` and the file is
///   written `0600`. The temp file has those bits from the moment it exists,
///   and is tightened again in case a temp left by an earlier version is
///   reused (`mode` only applies to a file being created). A folder that
///   already exists keeps its mode; the file's own mode keeps it private.
/// - Windows: the path is `app_data_dir()` (lib.rs), which Tauri resolves to
///   `FOLDERID_RoamingAppData\<identifier>`, i.e. `%APPDATA%\app.tabdump.desktop`.
///   That folder inherits the user profile's ACL (this account, SYSTEM and
///   Administrators), so other accounts can't read it and nothing extra is set.
///
/// Written beside, then renamed over: a crash mid-write never leaves half a file.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
        if let Some(parent) = path.parent() {
            std::fs::DirBuilder::new().recursive(true).mode(PRIVATE_DIR_MODE).create(parent)?;
        }
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(PRIVATE_FILE_MODE).open(&temp)?;
        file.set_permissions(std::fs::Permissions::from_mode(PRIVATE_FILE_MODE))?;
        file.write_all(bytes)?;
    }
    #[cfg(not(unix))]
    {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&temp, bytes)?;
    }
    std::fs::rename(&temp, path)
}

impl Link {
    /// Reads the saved links. A missing or unreadable file means no links —
    /// never an error that stops Hubble starting (the extension simply pairs again).
    pub fn load(path: PathBuf) -> Self {
        // A file written before records were kept private may still be readable
        // by other accounts; nothing rewrites it until the links change.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(PRIVATE_FILE_MODE));
        }
        let links = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<PairedLink>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|link| link.origin.starts_with("chrome-extension://") && link.token_hash.len() == 64)
            .take(MAX_LINKS)
            .collect();
        Link { links, path: Some(path), ..Default::default() }
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Ok(bytes) = serde_json::to_vec_pretty(&self.links) {
            let _ = write_private(path, &bytes);
        }
    }

    pub fn sweep(&mut self, now: Instant) {
        self.pairs.retain(|_, pair| pair.deadline > now);
        // A request whose time is up is answered "timed-out" so its HTTP handler returns.
        let expired: Vec<String> = self.waiting.iter().filter(|(_, w)| w.deadline <= now).map(|(id, _)| id.clone()).collect();
        for id in expired {
            if let Some(waiting) = self.waiting.remove(&id) {
                let _ = waiting.answer.try_send(json!({ "ok": false, "error": "timed-out" }));
            }
        }
        // A command nobody collected (Chrome closed, the default browser isn't Chrome) or nobody answered.
        let expired: Vec<String> = self.commands.iter().filter(|(_, c)| c.deadline <= now).map(|(id, _)| id.clone()).collect();
        for id in expired {
            if let Some(command) = self.commands.remove(&id) {
                let error = if command.taken_by.is_some() { "timed-out" } else { "extension-unreachable" };
                let _ = command.answer.try_send(json!({ "ok": false, "error": error }));
            }
        }
    }

    /* ---------------- pairing ---------------- */

    /// An extension asks to pair. Returns the pairing id and the code both sides show.
    pub fn begin_pairing(&mut self, origin: &str, label: Option<&str>, now: Instant) -> Result<(String, String), LinkRefusal> {
        self.sweep(now);
        if !origin.starts_with("chrome-extension://") {
            return Err(LinkRefusal::Unauthorized);
        }
        // One attempt per extension at a time: asking again replaces the earlier one.
        self.pairs.retain(|_, pair| pair.origin != origin || !matches!(pair.stage, PairStage::Waiting));
        // Only attempts still waiting for the person count: an answered one waiting to be collected never blocks a new one.
        if self.pairs.values().filter(|pair| matches!(pair.stage, PairStage::Waiting)).count() >= MAX_PENDING_PAIRS {
            return Err(LinkRefusal::Busy);
        }
        let id = random_hex(16);
        let code = pairing_code();
        self.pairs.insert(
            id.clone(),
            PendingPair { origin: origin.to_string(), label: clean_label(label), code: code.clone(), stage: PairStage::Waiting, deadline: now + PAIR_TTL },
        );
        Ok((id, code))
    }

    /// Pairing requests waiting for the person, for the webview's dialog.
    pub fn pending_pairings(&mut self, now: Instant) -> Vec<Value> {
        self.sweep(now);
        let mut pending: Vec<Value> = self
            .pairs
            .iter()
            .filter(|(_, pair)| matches!(pair.stage, PairStage::Waiting))
            .map(|(id, pair)| {
                json!({
                    "id": id,
                    "code": pair.code,
                    "label": pair.label,
                    "extensionId": pair.origin.trim_start_matches("chrome-extension://"),
                    "expiresInMs": pair.deadline.saturating_duration_since(now).as_millis() as u64,
                })
            })
            .collect();
        pending.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        pending
    }

    /// The person's answer in Hubble's window.
    pub fn answer_pairing(&mut self, id: &str, approve: bool, now: Instant) -> Result<(), String> {
        self.sweep(now);
        let Some(pair) = self.pairs.get_mut(id) else { return Err("This request has expired. Try connecting again from Chrome.".into()) };
        if !matches!(pair.stage, PairStage::Waiting) {
            return Err("This request was already answered.".into());
        }
        if !approve {
            pair.stage = PairStage::Denied;
            pair.deadline = now + PAIR_COLLECT_TTL;
            return Ok(());
        }
        let token = random_hex(32);
        let link_id = random_hex(8);
        // The same extension paired again: its earlier link is replaced, never duplicated.
        let origin = pair.origin.clone();
        self.links.retain(|link| link.origin != origin);
        if self.links.len() >= MAX_LINKS {
            self.links.sort_by_key(|link| link.last_used_at.unwrap_or(link.created_at));
            self.links.remove(0);
        }
        self.links.push(PairedLink {
            id: link_id.clone(),
            origin,
            label: pair.label.clone(),
            token_hash: hash_token(&token),
            created_at: now_ms(),
            last_used_at: None,
        });
        pair.stage = PairStage::Approved { token, link_id };
        pair.deadline = now + PAIR_COLLECT_TTL;
        self.save();
        Ok(())
    }

    /// The extension collects its answer. Only the origin that asked may, and an approval is handed over once.
    pub fn pairing_status(&mut self, id: &str, origin: &str, now: Instant) -> Result<Value, LinkRefusal> {
        self.sweep(now);
        let Some(pair) = self.pairs.get(id) else { return Err(LinkRefusal::NotFound) };
        if pair.origin != origin {
            return Err(LinkRefusal::NotFound);
        }
        match &pair.stage {
            PairStage::Waiting => Ok(json!({ "status": "waiting", "code": pair.code })),
            PairStage::Denied => {
                self.pairs.remove(id);
                Ok(json!({ "status": "denied" }))
            }
            PairStage::Approved { token, link_id } => {
                let body = json!({ "status": "approved", "token": token, "linkId": link_id });
                self.pairs.remove(id);
                Ok(body)
            }
        }
    }

    /* ---------------- links ---------------- */

    /// The link a request belongs to: the token's hash and the origin must both match.
    pub fn authenticate(&mut self, token: Option<&str>, origin: Option<&str>) -> Result<String, LinkRefusal> {
        let (Some(token), Some(origin)) = (token, origin) else { return Err(LinkRefusal::Unauthorized) };
        if token.len() != 64 {
            return Err(LinkRefusal::Unauthorized);
        }
        let hash = hash_token(token);
        let found = self.links.iter_mut().find(|link| same(&link.token_hash, &hash) && link.origin == origin);
        match found {
            Some(link) => {
                link.last_used_at = Some(now_ms());
                Ok(link.id.clone())
            }
            None => Err(LinkRefusal::Unauthorized),
        }
    }

    /// The extension disconnecting itself.
    pub fn forget(&mut self, link_id: &str) {
        let before = self.links.len();
        self.links.retain(|link| link.id != link_id);
        if self.links.len() != before {
            self.drop_commands_of(link_id);
            self.save();
        }
    }

    /// For Settings: every link, without its hash.
    pub fn list(&self) -> Vec<Value> {
        self.links
            .iter()
            .map(|link| json!({ "id": link.id, "label": link.label, "extensionId": link.origin.trim_start_matches("chrome-extension://"), "createdAt": link.created_at, "lastUsedAt": link.last_used_at }))
            .collect()
    }

    /// Settings → Disconnect. Waiting requests from that link are answered "not-paired".
    pub fn revoke(&mut self, link_id: &str) -> bool {
        let before = self.links.len();
        self.links.retain(|link| link.id != link_id);
        let removed = self.links.len() != before;
        if removed {
            let dropped: Vec<String> = self.waiting.iter().filter(|(_, w)| w.link_id == link_id).map(|(id, _)| id.clone()).collect();
            for id in dropped {
                if let Some(waiting) = self.waiting.remove(&id) {
                    let _ = waiting.answer.try_send(json!({ "ok": false, "error": "not-paired" }));
                }
            }
            self.drop_commands_of(link_id);
            self.save();
        }
        removed
    }

    fn drop_commands_of(&mut self, link_id: &str) {
        let dropped: Vec<String> = self.commands.iter().filter(|(_, c)| c.taken_by.as_deref() == Some(link_id)).map(|(id, _)| id.clone()).collect();
        for id in dropped {
            if let Some(command) = self.commands.remove(&id) {
                let _ = command.answer.try_send(json!({ "ok": false, "error": "not-paired" }));
            }
        }
    }

    /// This app's answer to an extension's challenge: one HMAC per paired link,
    /// keyed by that link's stored token hash and bound to the port it answers on.
    /// The asking extension recognises its own; nobody else can make one.
    pub fn proofs(&self, challenge: &str, port: u16) -> Result<Vec<String>, LinkRefusal> {
        if !(32..=128).contains(&challenge.len()) || !challenge.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(LinkRefusal::Invalid);
        }
        let message = format!("hubble-link-proof:v1:{port}:{challenge}");
        Ok(self.links.iter().map(|link| hex(&hmac_sha256(link.token_hash.as_bytes(), message.as_bytes()))).collect())
    }

    /// Whether any extension is paired at all.
    pub fn is_paired(&self) -> bool {
        !self.links.is_empty()
    }

    /* ---------------- commands from Hubble ---------------- */

    /// Queues one command for the paired extension. Refused when nothing is
    /// paired, for an action outside LINK_COMMAND_ACTIONS, for arguments that
    /// aren't a small object, and when too many are already waiting.
    pub fn queue_command(&mut self, action: &str, args: Value, ttl: Duration, now: Instant) -> Result<(String, Receiver<Value>), String> {
        self.sweep(now);
        if self.links.is_empty() {
            return Err("not-paired".into());
        }
        let action = LINK_COMMAND_ACTIONS.iter().copied().find(|known| *known == action).ok_or("unknown-action")?;
        let args = match args {
            Value::Null => json!({}),
            Value::Object(_) => args,
            _ => return Err("invalid".into()),
        };
        if args.to_string().len() > MAX_COMMAND_ARGS_BYTES {
            return Err("invalid".into());
        }
        if self.commands.len() >= MAX_WAITING_COMMANDS {
            return Err("busy".into());
        }
        let id = random_hex(12);
        let (sender, receiver) = sync_channel(1);
        let ttl = ttl.min(MAX_COMMAND_TTL);
        self.commands.insert(id.clone(), WaitingCommand { action, args, answer: sender, deadline: now + ttl, taken_by: None });
        Ok((id, receiver))
    }

    /// The paired extension collecting what waits for it. Each command is handed to one link, once.
    pub fn collect_commands(&mut self, link_id: &str, now: Instant) -> Vec<Value> {
        self.sweep(now);
        self.last_collect = Some(now);
        let mut collected = Vec::new();
        for (id, command) in self.commands.iter_mut() {
            if command.taken_by.is_none() {
                command.taken_by = Some(link_id.to_string());
                collected.push(json!({ "id": id, "action": command.action, "args": command.args }));
            }
        }
        collected.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        collected
    }

    /// The extension's answer to a command it collected: `{ id, ok: true, result }` or `{ id, ok: false, error }`.
    pub fn finish_command(&mut self, link_id: &str, body: &[u8]) -> Result<String, LinkRefusal> {
        let value: Value = serde_json::from_slice(body).map_err(|_| LinkRefusal::Invalid)?;
        let object = value.as_object().ok_or(LinkRefusal::Invalid)?;
        let id = object.get("id").and_then(Value::as_str).filter(|id| is_request_id(id)).ok_or(LinkRefusal::Invalid)?;
        let ok = object.get("ok").and_then(Value::as_bool).ok_or(LinkRefusal::Invalid)?;
        // Only the link that collected it answers; anything else is as if it didn't exist.
        if self.commands.get(id).and_then(|c| c.taken_by.as_deref()) != Some(link_id) {
            return Err(LinkRefusal::NotFound);
        }
        let command = self.commands.remove(id).ok_or(LinkRefusal::NotFound)?;
        let answer = if ok {
            json!({ "ok": true, "result": object.get("result").cloned().unwrap_or(Value::Null) })
        } else {
            let error: String = object.get("error").and_then(Value::as_str).unwrap_or("failed").chars().take(300).collect();
            json!({ "ok": false, "error": error })
        };
        let _ = command.answer.try_send(answer);
        Ok(id.to_string())
    }

    /// Whether a paired extension collected commands within AWAKE_WINDOW.
    pub fn extension_awake(&self, now: Instant) -> bool {
        self.last_collect.is_some_and(|at| now.saturating_duration_since(at) < AWAKE_WINDOW)
    }

    /// Whether a command has been collected (and so needs no wake).
    pub fn command_collected(&self, id: &str) -> bool {
        self.commands.get(id).is_some_and(|c| c.taken_by.is_some())
    }

    /// The app gave up waiting: forget the command (a late answer is refused).
    pub fn abandon_command(&mut self, id: &str) {
        self.commands.remove(id);
    }

    /* ---------------- paired requests ---------------- */

    /// Queues one paired request for the webview. The envelope is checked
    /// here (id, a known kind, an object of arguments); the arguments are
    /// re-read by the webview.
    pub fn submit(&mut self, link_id: &str, body: &[u8], now: Instant) -> Result<(String, Receiver<Value>), LinkRefusal> {
        self.sweep(now);
        let value: Value = serde_json::from_slice(body).map_err(|_| LinkRefusal::Invalid)?;
        let object = value.as_object().ok_or(LinkRefusal::Invalid)?;
        let request_id = object.get("requestId").and_then(Value::as_str).filter(|id| is_request_id(id)).ok_or(LinkRefusal::Invalid)?;
        let kind = object.get("kind").and_then(Value::as_str).filter(|kind| LINK_REQUEST_KINDS.contains(kind)).ok_or(LinkRefusal::Invalid)?;
        let args = match object.get("args") {
            None | Some(Value::Null) => json!({}),
            Some(Value::Object(map)) => Value::Object(map.clone()),
            Some(_) => return Err(LinkRefusal::Invalid),
        };
        if self.waiting.contains_key(request_id) {
            return Err(LinkRefusal::Busy);
        }
        if self.waiting.len() >= MAX_WAITING_REQUESTS {
            return Err(LinkRefusal::Busy);
        }
        let (sender, receiver) = sync_channel(1);
        self.waiting.insert(
            request_id.to_string(),
            WaitingRequest { link_id: link_id.to_string(), body: json!({ "requestId": request_id, "kind": kind, "args": args }), answer: sender, deadline: now + LINK_ANSWER_TTL, taken: false },
        );
        Ok((request_id.to_string(), receiver))
    }

    /// Requests the webview has not taken yet.
    pub fn take(&mut self, now: Instant) -> Vec<Value> {
        self.sweep(now);
        let mut taken = Vec::new();
        for waiting in self.waiting.values_mut() {
            if !waiting.taken {
                waiting.taken = true;
                taken.push(waiting.body.clone());
            }
        }
        taken
    }

    /// The webview's answer to one request: `{ ok: true, result }` or `{ ok: false, error }`.
    pub fn answer(&mut self, request_id: &str, answer: Value) -> Result<(), String> {
        let Some(waiting) = self.waiting.remove(request_id) else { return Err("unknown or expired request".into()) };
        let ok = answer.get("ok").and_then(Value::as_bool);
        let body = match ok {
            Some(true) => json!({ "ok": true, "result": answer.get("result").cloned().unwrap_or(Value::Null) }),
            Some(false) => {
                let error: String = answer.get("error").and_then(Value::as_str).unwrap_or("failed").chars().take(60).collect();
                json!({ "ok": false, "error": error })
            }
            None => json!({ "ok": false, "error": "failed" }),
        };
        let _ = waiting.answer.try_send(body);
        Ok(())
    }

    /// The handler gave up waiting (the extension disconnected or time ran out): forget the request.
    pub fn abandon(&mut self, request_id: &str) {
        self.waiting.remove(request_id);
    }

    #[cfg(test)]
    pub fn links(&self) -> &[PairedLink] {
        &self.links
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const OTHER: &str = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

    fn paired(link: &mut Link, now: Instant) -> (String, String) {
        let (id, _) = link.begin_pairing(EXT, Some("Chrome"), now).unwrap();
        link.answer_pairing(&id, true, now).unwrap();
        let answer = link.pairing_status(&id, EXT, now).unwrap();
        (answer["token"].as_str().unwrap().to_string(), answer["linkId"].as_str().unwrap().to_string())
    }

    #[test]
    fn pairing_needs_the_person_and_hands_the_token_over_once_to_the_asking_extension() {
        let mut link = Link::default();
        let now = Instant::now();
        let (id, code) = link.begin_pairing(EXT, Some("Chrome on Laptop"), now).unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(link.pairing_status(&id, EXT, now).unwrap()["status"], "waiting");
        // Another extension can't read it.
        assert_eq!(link.pairing_status(&id, OTHER, now), Err(LinkRefusal::NotFound));
        let pending = link.pending_pairings(now);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["code"], code.as_str());
        assert_eq!(pending[0]["label"], "Chrome on Laptop");
        link.answer_pairing(&id, true, now).unwrap();
        let answer = link.pairing_status(&id, EXT, now).unwrap();
        assert_eq!(answer["status"], "approved");
        let token = answer["token"].as_str().unwrap();
        assert_eq!(token.len(), 64);
        // Once.
        assert_eq!(link.pairing_status(&id, EXT, now), Err(LinkRefusal::NotFound));
        // Only the hash is kept.
        assert_eq!(link.links().len(), 1);
        assert_ne!(link.links()[0].token_hash, token);
        assert!(!serde_json::to_string(link.links()).unwrap().contains(token));
    }

    #[test]
    fn a_declined_or_expired_pairing_gives_no_token() {
        let mut link = Link::default();
        let now = Instant::now();
        let (id, _) = link.begin_pairing(EXT, None, now).unwrap();
        link.answer_pairing(&id, false, now).unwrap();
        assert_eq!(link.pairing_status(&id, EXT, now).unwrap(), json!({ "status": "denied" }));
        assert!(link.links().is_empty());
        let (late, _) = link.begin_pairing(EXT, None, now).unwrap();
        let after = now + PAIR_TTL + Duration::from_secs(1);
        assert!(link.answer_pairing(&late, true, after).is_err());
        assert_eq!(link.pairing_status(&late, EXT, after), Err(LinkRefusal::NotFound));
        assert!(link.links().is_empty());
    }

    #[test]
    fn answered_attempts_never_block_a_new_one() {
        let mut link = Link::default();
        let now = Instant::now();
        for _ in 0..3 {
            let (id, _) = link.begin_pairing(EXT, None, now).unwrap();
            link.answer_pairing(&id, false, now).unwrap();
            let (id, _) = link.begin_pairing(OTHER, None, now).unwrap();
            link.answer_pairing(&id, false, now).unwrap();
        }
        assert!(link.begin_pairing(EXT, None, now).is_ok());
    }

    #[test]
    fn only_extensions_can_ask_and_attempts_are_capped() {
        let mut link = Link::default();
        let now = Instant::now();
        assert_eq!(link.begin_pairing("https://evil.example", None, now), Err(LinkRefusal::Unauthorized));
        link.begin_pairing(EXT, None, now).unwrap();
        // The same extension asking again replaces its attempt.
        link.begin_pairing(EXT, None, now).unwrap();
        link.begin_pairing(OTHER, None, now).unwrap();
        assert_eq!(link.pending_pairings(now).len(), 2);
        assert_eq!(link.begin_pairing("chrome-extension://cccccccccccccccccccccccccccccccc", None, now), Err(LinkRefusal::Busy));
    }

    #[test]
    fn requests_need_the_token_and_the_origin_it_was_issued_to() {
        let mut link = Link::default();
        let now = Instant::now();
        let (token, link_id) = paired(&mut link, now);
        assert_eq!(link.authenticate(Some(&token), Some(EXT)), Ok(link_id.clone()));
        assert_eq!(link.authenticate(Some(&token), Some(OTHER)), Err(LinkRefusal::Unauthorized));
        assert_eq!(link.authenticate(Some(&"0".repeat(64)), Some(EXT)), Err(LinkRefusal::Unauthorized));
        assert_eq!(link.authenticate(None, Some(EXT)), Err(LinkRefusal::Unauthorized));
        assert_eq!(link.authenticate(Some(&token), None), Err(LinkRefusal::Unauthorized));
        assert!(link.revoke(&link_id));
        assert_eq!(link.authenticate(Some(&token), Some(EXT)), Err(LinkRefusal::Unauthorized));
    }

    #[test]
    fn pairing_again_replaces_the_extensions_earlier_link() {
        let mut link = Link::default();
        let now = Instant::now();
        let (first, _) = paired(&mut link, now);
        let (second, _) = paired(&mut link, now);
        assert_eq!(link.links().len(), 1);
        assert!(link.authenticate(Some(&first), Some(EXT)).is_err());
        assert!(link.authenticate(Some(&second), Some(EXT)).is_ok());
    }

    #[test]
    fn a_request_travels_to_the_webview_and_its_answer_back() {
        let mut link = Link::default();
        let now = Instant::now();
        let (_, link_id) = paired(&mut link, now);
        let body = json!({ "requestId": "r-1", "kind": "projects", "args": {} }).to_string();
        let (id, receiver) = link.submit(&link_id, body.as_bytes(), now).unwrap();
        assert_eq!(id, "r-1");
        let taken = link.take(now);
        assert_eq!(taken, vec![json!({ "requestId": "r-1", "kind": "projects", "args": {} })]);
        // Taken once.
        assert!(link.take(now).is_empty());
        link.answer("r-1", json!({ "ok": true, "result": { "projects": [] }, "extra": 1 })).unwrap();
        assert_eq!(receiver.recv().unwrap(), json!({ "ok": true, "result": { "projects": [] } }));
        assert!(link.answer("r-1", json!({ "ok": true })).is_err());
    }

    #[test]
    fn unknown_kinds_and_malformed_envelopes_are_refused() {
        let mut link = Link::default();
        let now = Instant::now();
        let (_, link_id) = paired(&mut link, now);
        for body in [
            json!({ "requestId": "r", "kind": "exec", "args": {} }),
            json!({ "requestId": "r/../x", "kind": "projects" }),
            json!({ "requestId": "", "kind": "projects" }),
            json!({ "requestId": "r", "kind": "projects", "args": [] }),
            json!(["projects"]),
        ] {
            assert_eq!(link.submit(&link_id, body.to_string().as_bytes(), now).err(), Some(LinkRefusal::Invalid), "{body}");
        }
        assert_eq!(link.submit(&link_id, b"not json", now).err(), Some(LinkRefusal::Invalid));
    }

    #[test]
    fn an_unanswered_request_times_out_and_a_revoked_link_drops_its_requests() {
        let mut link = Link::default();
        let now = Instant::now();
        let (_, link_id) = paired(&mut link, now);
        let (_, receiver) = link.submit(&link_id, json!({ "requestId": "a", "kind": "projects" }).to_string().as_bytes(), now).unwrap();
        link.sweep(now + LINK_ANSWER_TTL + Duration::from_secs(1));
        assert_eq!(receiver.recv().unwrap(), json!({ "ok": false, "error": "timed-out" }));
        let (_, receiver) = link.submit(&link_id, json!({ "requestId": "b", "kind": "search", "args": { "query": "x" } }).to_string().as_bytes(), now).unwrap();
        link.revoke(&link_id);
        assert_eq!(receiver.recv().unwrap(), json!({ "ok": false, "error": "not-paired" }));
    }

    #[test]
    fn links_survive_a_restart_as_hashes_and_a_bad_file_means_none() {
        let dir = std::env::temp_dir().join(format!("hubble-link-test-{}", random_hex(6)));
        let path = dir.join("extension-links.json");
        let now = Instant::now();
        let mut link = Link::load(path.clone());
        let (token, _) = paired(&mut link, now);
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains(&token));
        let mut reloaded = Link::load(path.clone());
        assert!(reloaded.authenticate(Some(&token), Some(EXT)).is_ok());
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(Link::load(path.clone()).list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn saved_links_are_readable_by_this_account_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let open_to_all = |path: &Path| std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let root = std::env::temp_dir().join(format!("hubble-link-test-{}", random_hex(6)));
        let dir = root.join("app-data");
        let path = dir.join("extension-links.json");
        let temp = path.with_extension("json.tmp");
        let now = Instant::now();

        // The first save creates the folder and the file, owner-only.
        let mut link = Link::load(path.clone());
        paired(&mut link, now);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&path), 0o600);
        assert!(!temp.exists());

        // A temp file an earlier version left readable is not renamed into place as it was.
        std::fs::write(&temp, b"[]").unwrap();
        open_to_all(&temp);
        paired(&mut link, now);
        assert_eq!(mode(&path), 0o600);

        // A file an earlier version saved readable is made private when Hubble starts.
        open_to_all(&path);
        let reloaded = Link::load(path.clone());
        assert_eq!(mode(&path), 0o600);
        assert_eq!(reloaded.list().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2.
        assert_eq!(hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Test case 6: a key longer than the block.
        assert_eq!(
            hex(&hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn the_proof_is_the_tokens_hmac_bound_to_port_and_challenge() {
        let mut link = Link::default();
        let now = Instant::now();
        let challenge = "c".repeat(32);
        assert_eq!(link.proofs(&challenge, 41517), Ok(vec![]));
        let (token, _) = paired(&mut link, now);
        let proofs = link.proofs(&challenge, 41517).unwrap();
        let expected = hex(&hmac_sha256(hash_token(&token).as_bytes(), format!("hubble-link-proof:v1:41517:{challenge}").as_bytes()));
        assert_eq!(proofs, vec![expected.clone()]);
        assert!(!link.proofs(&challenge, 41518).unwrap().contains(&expected));
        assert!(!link.proofs(&"d".repeat(32), 41517).unwrap().contains(&expected));
        for bad in ["", "short", &"z".repeat(32), &"a".repeat(129)] {
            assert_eq!(link.proofs(bad, 41517), Err(LinkRefusal::Invalid), "{bad}");
        }
    }

    #[test]
    fn a_command_needs_a_paired_extension_a_known_action_and_small_object_args() {
        let mut link = Link::default();
        let now = Instant::now();
        let ttl = Duration::from_secs(10);
        assert_eq!(link.queue_command("list_browser_tabs", json!({}), ttl, now).err().as_deref(), Some("not-paired"));
        paired(&mut link, now);
        assert!(link.queue_command("list_browser_tabs", Value::Null, ttl, now).is_ok());
        // The relay's delivery and the commands Hubble never sends are not commands.
        for action in ["deliver_to_desktop", "close_tabs", "pin_tab", "exec", ""] {
            assert_eq!(link.queue_command(action, json!({}), ttl, now).err().as_deref(), Some("unknown-action"), "{action}");
        }
        assert_eq!(link.queue_command("get_history", json!([1, 2]), ttl, now).err().as_deref(), Some("invalid"));
        assert_eq!(link.queue_command("open_tabs", json!({ "urls": ["x".repeat(MAX_COMMAND_ARGS_BYTES)] }), ttl, now).err().as_deref(), Some("invalid"));
        for _ in 1..MAX_WAITING_COMMANDS {
            link.queue_command("list_browser_windows", json!({}), ttl, now).unwrap();
        }
        assert_eq!(link.queue_command("list_browser_windows", json!({}), ttl, now).err().as_deref(), Some("busy"));
    }

    #[test]
    fn a_command_travels_to_the_extension_once_and_its_answer_back_to_the_app() {
        let mut link = Link::default();
        let now = Instant::now();
        let (_, link_id) = paired(&mut link, now);
        assert!(!link.extension_awake(now));
        let (id, receiver) = link.queue_command("get_history", json!({ "startTime": 1 }), Duration::from_secs(10), now).unwrap();
        assert!(!link.command_collected(&id));
        let collected = link.collect_commands(&link_id, now);
        assert_eq!(collected, vec![json!({ "id": id, "action": "get_history", "args": { "startTime": 1 } })]);
        assert!(link.command_collected(&id));
        assert!(link.extension_awake(now));
        assert!(!link.extension_awake(now + AWAKE_WINDOW));
        // Collected once.
        assert!(link.collect_commands(&link_id, now).is_empty());
        let answer = json!({ "id": id, "ok": true, "result": { "items": [] }, "extra": 1 }).to_string();
        assert_eq!(link.finish_command(&link_id, answer.as_bytes()), Ok(id.clone()));
        assert_eq!(receiver.recv().unwrap(), json!({ "ok": true, "result": { "items": [] } }));
        // Answered once.
        assert_eq!(link.finish_command(&link_id, answer.as_bytes()), Err(LinkRefusal::NotFound));
    }

    #[test]
    fn only_the_link_that_collected_a_command_answers_it() {
        let mut link = Link::default();
        let now = Instant::now();
        let (_, link_id) = paired(&mut link, now);
        let (id, receiver) = link.queue_command("open_url", json!({ "url": "https://example.com" }), Duration::from_secs(10), now).unwrap();
        let early = json!({ "id": id, "ok": true, "result": {} }).to_string();
        // Not collected yet: nobody can answer it.
        assert_eq!(link.finish_command(&link_id, early.as_bytes()), Err(LinkRefusal::NotFound));
        link.collect_commands(&link_id, now);
        assert_eq!(link.finish_command("another-link", early.as_bytes()), Err(LinkRefusal::NotFound));
        for body in [json!({ "ok": true }), json!({ "id": id }), json!({ "id": "../x", "ok": true }), json!([id])] {
            assert_eq!(link.finish_command(&link_id, body.to_string().as_bytes()), Err(LinkRefusal::Invalid), "{body}");
        }
        let failed = json!({ "id": id, "ok": false, "error": "e".repeat(500) }).to_string();
        link.finish_command(&link_id, failed.as_bytes()).unwrap();
        let answer = receiver.recv().unwrap();
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["error"].as_str().unwrap().len(), 300);
    }

    #[test]
    fn uncollected_commands_say_unreachable_unanswered_ones_time_out_and_disconnecting_drops_them() {
        let mut link = Link::default();
        let now = Instant::now();
        let (token, link_id) = paired(&mut link, now);
        let ttl = Duration::from_secs(5);
        let (_, never_collected) = link.queue_command("list_browser_tabs", json!({}), ttl, now).unwrap();
        link.sweep(now + ttl);
        assert_eq!(never_collected.recv().unwrap(), json!({ "ok": false, "error": "extension-unreachable" }));

        let (_, unanswered) = link.queue_command("list_browser_tabs", json!({}), ttl, now).unwrap();
        link.collect_commands(&link_id, now);
        link.sweep(now + ttl);
        assert_eq!(unanswered.recv().unwrap(), json!({ "ok": false, "error": "timed-out" }));

        // The TTL is capped.
        let (id, _) = link.queue_command("get_history", json!({}), Duration::from_secs(3600), now).unwrap();
        link.sweep(now + MAX_COMMAND_TTL);
        assert!(!link.commands.contains_key(&id));

        let (_, revoked) = link.queue_command("open_session", json!({}), ttl, now).unwrap();
        link.collect_commands(&link_id, now);
        link.revoke(&link_id);
        assert_eq!(revoked.recv().unwrap(), json!({ "ok": false, "error": "not-paired" }));
        assert!(link.authenticate(Some(&token), Some(EXT)).is_err());
        assert_eq!(link.queue_command("open_session", json!({}), ttl, now).err().as_deref(), Some("not-paired"));
    }
}
