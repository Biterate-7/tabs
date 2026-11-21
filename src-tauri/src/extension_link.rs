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
//! in the app's data folder), with the extension's origin; Settings lists
//! each link and disconnects it.
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
//! Nothing here is ever logged except ids, kinds and outcomes.

use std::collections::HashMap;
use std::path::PathBuf;
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

impl Link {
    /// Reads the saved links. A missing or unreadable file means no links —
    /// never an error that stops Hubble starting (the extension simply pairs again).
    pub fn load(path: PathBuf) -> Self {
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
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Written beside, then renamed over: a crash mid-write never leaves half a file.
        let temp = path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(&self.links) {
            if std::fs::write(&temp, bytes).is_ok() {
                let _ = std::fs::rename(&temp, path);
            }
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
            self.save();
        }
        removed
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
}
