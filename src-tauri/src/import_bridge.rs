//! Chrome → Hubble Desktop: the import bridge.
//!
//! # Shape
//!
//! The Hubble Chrome extension hands tabs to the desktop app directly, with
//! no website and no server in between:
//!
//! ```text
//! extension ──GET  /v1/hello──────────────────────────▶ is Hubble Desktop here?
//!           ──POST /v1/sessions──────────────────────▶ { sessionId, token }   (unused: gone in 30 s)
//!           ──POST /v1/sessions/:id/import  Bearer──▶ validated, queued, window focused
//!                                                        │ "hubble-import:requested"
//!                                                        ▼
//!                                   webview ── desktop_import_take ──▶ the person picks a project
//!                                           ── desktop_import_finish ─▶ result stored here
//!           ──GET  /v1/sessions/:id         Bearer──▶ { status, result }  (then forgotten)
//! ```
//!
//! When Hubble isn't running there is nothing listening, so the extension
//! opens `hubble://import` — registered by the installer — to start it, and
//! asks again. That URL only wakes the app: no tab, title or id rides on it.
//!
//! # What this enforces rather than trusts
//!
//! * **Loopback only.** The listener binds `127.0.0.1`, never `0.0.0.0`, and
//!   refuses any `Host` that isn't loopback at the bound port — a DNS-rebound
//!   page that reaches the socket under its own name is turned away.
//! * **No web page can drive it.** Every POST must come from a
//!   `chrome-extension://` origin; a page cannot forge `Origin`. Responses
//!   carry CORS headers for extension origins only, so a page cannot read a
//!   result either.
//! * **Session tokens.** Importing and reading a result both need the random
//!   token issued with the session, compared in constant time. A session that
//!   is never used expires; a request nobody answers expires; a result nobody
//!   collects expires. Nothing outlives the app: all of it is in memory.
//! * **Four routes, one job.** There is no route that touches a file, runs a
//!   command or reaches a Tauri command. The bridge can only queue a batch of
//!   web addresses for the person to accept or decline in Hubble's own window.
//! * **The payload is validated here** — version, source, request id, tab
//!   count, address scheme and length, title length, favicon, body size — and
//!   again by the webview (src/lib/desktop/import-protocol.ts) before anything
//!   reaches the import pipeline. Bad addresses are dropped and counted, not
//!   fatal: the person sees "8 of 10 added".
//! * **The person decides.** Nothing is imported until they choose a project
//!   and press Add in the desktop window; Cancel imports nothing.
//!
//! Tab addresses are never logged — only request ids, counts and outcomes.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// The wire protocol version. Mirrors `DESKTOP_PROTOCOL_VERSION` in
/// extension/src/desktop.js and src/lib/desktop/import-protocol.ts.
pub const PROTOCOL_VERSION: u64 = 1;

/// Loopback ports tried in order; the first free one is used. A fixed list
/// because the extension has to find the bridge without being told: it asks
/// each one. Mirrors `DESKTOP_BRIDGE_PORTS` in extension/src/desktop.js and
/// the extension manifest's `host_permissions`.
pub const BRIDGE_PORTS: [u16; 3] = [41517, 41518, 41519];

/// One batch at most. Matches `MAX_INGEST_BATCH` (src/lib/resources/ingest.ts),
/// the most the import pipeline takes in one go.
pub const MAX_TABS: usize = 200;
pub const MAX_URL_CHARS: usize = 2048;
pub const MAX_TITLE_CHARS: usize = 500;
/// 200 tabs of maximum-length addresses, titles and favicons fit with room.
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_SESSIONS: usize = 8;
const MAX_CONNECTIONS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// A session nobody imports through is gone after this.
pub const SESSION_TTL: Duration = Duration::from_secs(30);
/// How long a request waits for the person to choose a project. The
/// extension waits slightly longer (DESKTOP_DECISION_TIMEOUT_MS).
pub const REQUEST_TTL: Duration = Duration::from_secs(180);
/// A finished result the extension never collected is dropped after this.
pub const RESULT_TTL: Duration = Duration::from_secs(60);

/// Emitted to the webview when a request is queued. The webview also pulls on
/// start-up (`desktop_import_take`), so a request that arrives before it is
/// listening — Hubble launched by the extension — is never lost.
pub const REQUESTED_EVENT: &str = "hubble-import:requested";

/* ------------------------------------------------------------------ *
 * Payload
 * ------------------------------------------------------------------ */

/// One tab as the import pipeline takes it — the fields of `ResourceInput`
/// (src/lib/resources/types.ts) and nothing Chrome-specific.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTab {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

/// A validated batch: what is shown to the person and handed to the pipeline.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedImport {
    pub request_id: String,
    pub tabs: Vec<ImportTab>,
    /// Tabs the extension sent, including any refused here.
    pub received: usize,
    /// Tabs refused here (not a web address, too long). Counted as failed.
    pub rejected: usize,
}

/// Why a request was refused. Each maps to one status code and one short,
/// stable reason the extension turns into words — never a stack trace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    BadRequest,
    UnsupportedVersion,
    TooManyTabs,
    NoTabs,
    TooLarge,
    Forbidden,
    Unauthorized,
    NotFound,
    Busy,
    Conflict,
    MethodNotAllowed,
}

impl Refusal {
    pub fn status(self) -> u16 {
        match self {
            Refusal::BadRequest | Refusal::UnsupportedVersion | Refusal::TooManyTabs | Refusal::NoTabs => 400,
            Refusal::TooLarge => 413,
            Refusal::Forbidden => 403,
            Refusal::Unauthorized => 401,
            Refusal::NotFound => 404,
            Refusal::Busy => 429,
            Refusal::Conflict => 409,
            Refusal::MethodNotAllowed => 405,
        }
    }

    pub fn reason(self) -> &'static str {
        match self {
            Refusal::BadRequest => "invalid-payload",
            Refusal::UnsupportedVersion => "unsupported-version",
            Refusal::TooManyTabs => "too-many-tabs",
            Refusal::NoTabs => "no-tabs",
            Refusal::TooLarge => "payload-too-large",
            Refusal::Forbidden => "forbidden",
            Refusal::Unauthorized => "unauthorized",
            Refusal::NotFound => "unknown-session",
            Refusal::Busy => "busy",
            Refusal::Conflict => "already-submitted",
            Refusal::MethodNotAllowed => "method-not-allowed",
        }
    }
}

fn is_request_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// An http(s) address with a host, at most MAX_URL_CHARS — or None.
fn web_address(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_URL_CHARS || trimmed.chars().any(char::is_control) {
        return None;
    }
    let parsed = tauri::Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().map_or(true, str::is_empty) {
        return None;
    }
    // The address as Chrome had it: the pipeline does its own normalizing.
    Some(trimmed.to_string())
}

fn clean_title(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).take(MAX_TITLE_CHARS).collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Checks a request body against the wire protocol (extension/src/desktop.js
/// `buildDesktopPayload`). Unknown fields are ignored, never carried forward.
pub fn validate_payload(body: &[u8]) -> Result<ValidatedImport, Refusal> {
    if body.len() > MAX_BODY_BYTES {
        return Err(Refusal::TooLarge);
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| Refusal::BadRequest)?;
    let object = value.as_object().ok_or(Refusal::BadRequest)?;

    match object.get("version").and_then(Value::as_u64) {
        Some(PROTOCOL_VERSION) => {}
        Some(_) => return Err(Refusal::UnsupportedVersion),
        None => return Err(Refusal::BadRequest),
    }
    if object.get("source").and_then(Value::as_str) != Some("chrome-extension") {
        return Err(Refusal::BadRequest);
    }
    let request_id = object.get("requestId").and_then(Value::as_str).filter(|id| is_request_id(id)).ok_or(Refusal::BadRequest)?;
    let raw_tabs = object.get("tabs").and_then(Value::as_array).ok_or(Refusal::BadRequest)?;
    if raw_tabs.is_empty() {
        return Err(Refusal::NoTabs);
    }
    if raw_tabs.len() > MAX_TABS {
        return Err(Refusal::TooManyTabs);
    }

    let mut tabs = Vec::with_capacity(raw_tabs.len());
    let mut rejected = 0;
    for raw in raw_tabs {
        let Some(url) = raw.get("url").and_then(Value::as_str).and_then(web_address) else {
            rejected += 1;
            continue;
        };
        let title = raw.get("title").and_then(Value::as_str).and_then(clean_title);
        // A favicon is a nicety: one that isn't a short web address is dropped, not the tab.
        let favicon = raw.get("favicon").and_then(Value::as_str).and_then(web_address).filter(|f| f.len() <= 1024);
        tabs.push(ImportTab { url, title, favicon });
    }

    Ok(ValidatedImport { request_id: request_id.to_string(), received: raw_tabs.len(), rejected, tabs })
}

/// What the webview reports once the person has answered.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// "done", "cancelled" or "failed".
    pub status: String,
    /// The project's name, shown back in Chrome ("Added 9 tabs to Research").
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub added: usize,
    #[serde(default)]
    pub duplicates: usize,
    #[serde(default)]
    pub failed: usize,
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

enum Stage {
    /// Issued; nothing submitted yet.
    Open,
    /// A batch is waiting for the person.
    Waiting(ValidatedImport),
    /// Answered (or expired); waiting for the extension to collect it.
    Finished(Value),
}

struct Session {
    token: String,
    stage: Stage,
    deadline: Instant,
}

/// Everything the bridge knows, in memory only. No Tauri types, so the whole
/// lifecycle is unit-tested below without a window or a socket.
#[derive(Default)]
pub struct Bridge {
    sessions: HashMap<String, Session>,
    /// Whether the webview has asked for requests at least once — reported by
    /// `/v1/hello` so the extension can say "Starting Hubble Desktop…".
    webview_ready: bool,
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // getrandom only fails when the OS has no entropy source at all; a session
    // with a predictable token must not be issued, so this is fatal to the call.
    getrandom::fill(&mut buf).expect("the operating system's random number generator is unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time comparison, so a token can't be guessed a byte at a time.
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn result_json(request: &ValidatedImport, status: &str, outcome: Option<&ImportOutcome>) -> Value {
    let (added, duplicates, failed, project) = match outcome {
        Some(o) => (o.added, o.duplicates, o.failed, o.project.clone()),
        None => (0, 0, 0, None),
    };
    json!({
        "status": status,
        "result": {
            "requestId": request.request_id,
            "success": status == "done" && added + duplicates > 0,
            "received": request.received,
            "added": added,
            "duplicates": duplicates,
            "failed": failed,
            "project": project,
        }
    })
}

impl Bridge {
    /// Drops what has lived past its deadline. A request nobody answered in
    /// time becomes an "expired" result the extension can still collect.
    pub fn sweep(&mut self, now: Instant) {
        let mut expired = Vec::new();
        self.sessions.retain(|id, session| {
            if now < session.deadline {
                return true;
            }
            match &session.stage {
                Stage::Waiting(request) => {
                    expired.push((id.clone(), result_json(request, "expired", None)));
                    true
                }
                _ => false,
            }
        });
        for (id, result) in expired {
            if let Some(session) = self.sessions.get_mut(&id) {
                log("request-expired", &[("requestId", result["result"]["requestId"].as_str().unwrap_or(""))]);
                session.stage = Stage::Finished(result);
                session.deadline = now + RESULT_TTL;
            }
        }
    }

    pub fn open_session(&mut self, now: Instant) -> Result<(String, String), Refusal> {
        self.sweep(now);
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(Refusal::Busy);
        }
        let id = random_hex(16);
        let token = random_hex(32);
        self.sessions.insert(id.clone(), Session { token: token.clone(), stage: Stage::Open, deadline: now + SESSION_TTL });
        Ok((id, token))
    }

    fn authorized(&mut self, id: &str, token: Option<&str>, now: Instant) -> Result<&mut Session, Refusal> {
        self.sweep(now);
        let session = self.sessions.get_mut(id).ok_or(Refusal::NotFound)?;
        match token {
            Some(token) if same_token(&session.token, token) => Ok(session),
            _ => Err(Refusal::Unauthorized),
        }
    }

    /// Queues a validated batch on its session. Returns the request id.
    pub fn submit(&mut self, id: &str, token: Option<&str>, body: &[u8], now: Instant) -> Result<ValidatedImport, Refusal> {
        let session = self.authorized(id, token, now)?;
        if !matches!(session.stage, Stage::Open) {
            return Err(Refusal::Conflict);
        }
        let request = validate_payload(body)?;
        session.stage = Stage::Waiting(request.clone());
        session.deadline = now + REQUEST_TTL;
        Ok(request)
    }

    /// The session's state for the extension. A finished result is handed over
    /// once and the session forgotten.
    pub fn status(&mut self, id: &str, token: Option<&str>, now: Instant) -> Result<Value, Refusal> {
        let session = self.authorized(id, token, now)?;
        let answer = match &session.stage {
            Stage::Open => json!({ "status": "open" }),
            Stage::Waiting(request) => json!({ "status": "waiting", "requestId": request.request_id }),
            Stage::Finished(result) => result.clone(),
        };
        if matches!(session.stage, Stage::Finished(_)) {
            self.sessions.remove(id);
        }
        Ok(answer)
    }

    /// Every request still waiting for the person. Includes ones already
    /// shown, so a webview that reloaded mid-choice shows them again; the
    /// webview de-duplicates by request id.
    pub fn take(&mut self, now: Instant) -> Vec<Value> {
        self.sweep(now);
        self.webview_ready = true;
        let mut waiting: Vec<(&Session, &ValidatedImport)> = self
            .sessions
            .values()
            .filter_map(|session| match &session.stage {
                Stage::Waiting(request) => Some((session, request)),
                _ => None,
            })
            .collect();
        // Oldest deadline first: the order the requests arrived in.
        waiting.sort_by_key(|(session, _)| session.deadline);
        waiting
            .into_iter()
            .map(|(session, request)| {
                let mut value = serde_json::to_value(request).unwrap_or(Value::Null);
                value["expiresInMs"] = json!(session.deadline.saturating_duration_since(now).as_millis() as u64);
                value
            })
            .collect()
    }

    /// Records the person's answer for one request.
    pub fn finish(&mut self, request_id: &str, outcome: ImportOutcome, now: Instant) -> Result<(), String> {
        self.sweep(now);
        if !matches!(outcome.status.as_str(), "done" | "cancelled" | "failed") {
            return Err("Unknown outcome.".into());
        }
        let session = self
            .sessions
            .values_mut()
            .find(|session| matches!(&session.stage, Stage::Waiting(request) if request.request_id == request_id))
            .ok_or_else(|| "This request has expired.".to_string())?;
        let Stage::Waiting(request) = &session.stage else { unreachable!() };
        if outcome.added + outcome.duplicates + outcome.failed > request.received {
            return Err("The counts don't add up.".into());
        }
        let outcome = ImportOutcome {
            project: outcome.project.map(|name| name.chars().filter(|c| !c.is_control()).take(120).collect()),
            ..outcome
        };
        let result = result_json(request, &outcome.status, Some(&outcome));
        session.stage = Stage::Finished(result);
        session.deadline = now + RESULT_TTL;
        Ok(())
    }

    pub fn webview_ready(&self) -> bool {
        self.webview_ready
    }
}

/* ------------------------------------------------------------------ *
 * HTTP (just enough of it)
 * ------------------------------------------------------------------ */

#[derive(Debug)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

/// Reads one HTTP/1.1 request with fixed limits on every part of it. `Err`
/// carries the status to answer with.
pub fn read_request(stream: &mut impl Read) -> Result<HttpRequest, u16> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(431);
        }
        let read = stream.read(&mut chunk).map_err(|_| 408u16)?;
        if read == 0 {
            return Err(400);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = std::str::from_utf8(&buffer[..header_end]).map_err(|_| 400u16)?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().ok_or(400u16)?.split(' ');
    let method = request_line.next().ok_or(400u16)?.to_string();
    let path = request_line.next().ok_or(400u16)?.to_string();
    if !request_line.next().is_some_and(|version| version.starts_with("HTTP/1.")) {
        return Err(400);
    }
    let mut headers = Vec::new();
    for line in lines {
        let (key, value) = line.split_once(':').ok_or(400u16)?;
        headers.push((key.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    if headers.iter().any(|(key, _)| key == "transfer-encoding") {
        return Err(411);
    }
    let length = match headers.iter().find(|(key, _)| key == "content-length") {
        Some((_, value)) => value.parse::<usize>().map_err(|_| 400u16)?,
        None => 0,
    };
    if length > MAX_BODY_BYTES {
        return Err(413);
    }

    let mut body = buffer[header_end + 4..].to_vec();
    if body.len() > length {
        return Err(400);
    }
    while body.len() < length {
        let want = (length - body.len()).min(chunk.len());
        let read = stream.read(&mut chunk[..want]).map_err(|_| 408u16)?;
        if read == 0 {
            return Err(400);
        }
        body.extend_from_slice(&chunk[..read]);
    }
    Ok(HttpRequest { method, path, headers, body })
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Value,
    /// Set only for a `chrome-extension://` origin.
    pub allow_origin: Option<String>,
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    }
}

pub fn write_response(stream: &mut impl Write, response: &HttpResponse) -> std::io::Result<()> {
    let body = if response.status == 204 { String::new() } else { response.body.to_string() };
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        response.status,
        status_text(response.status),
        body.len()
    );
    if let Some(origin) = &response.allow_origin {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: GET, POST\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Max-Age: 600\r\nVary: Origin\r\n"
        ));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// What the app shell does after a request was queued.
#[derive(Debug, PartialEq)]
pub enum Effect {
    Queued { request_id: String, tabs: usize },
}

fn refusal(refusal: Refusal, allow_origin: Option<String>) -> HttpResponse {
    HttpResponse { status: refusal.status(), body: json!({ "ok": false, "reason": refusal.reason() }), allow_origin }
}

fn bearer(request: &HttpRequest) -> Option<&str> {
    request.header("authorization")?.strip_prefix("Bearer ").map(str::trim)
}

/// Routes one request. Pure apart from the bridge it is handed: the socket
/// loop below does the reading, writing, focusing and emitting.
pub fn route(bridge: &Mutex<Bridge>, request: &HttpRequest, port: u16, now: Instant) -> (HttpResponse, Option<Effect>) {
    // DNS rebinding: a page that resolved its own name to 127.0.0.1 still says
    // its own name here.
    let host_ok = matches!(request.header("host"), Some(host) if host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"));
    if !host_ok {
        return (refusal(Refusal::Forbidden, None), None);
    }
    // Only the extension: a web page cannot set `Origin` to chrome-extension://.
    let origin = request.header("origin");
    let extension_origin = origin.filter(|o| o.starts_with("chrome-extension://") && o.len() <= 100).map(str::to_string);
    if origin.is_some() && extension_origin.is_none() {
        return (refusal(Refusal::Forbidden, None), None);
    }
    if request.method == "POST" && extension_origin.is_none() {
        return (refusal(Refusal::Forbidden, None), None);
    }
    let allow = extension_origin.clone();
    if request.method == "OPTIONS" {
        return (HttpResponse { status: 204, body: Value::Null, allow_origin: allow }, None);
    }

    let mut bridge = bridge.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let segments: Vec<&str> = request.path.split('?').next().unwrap_or("").trim_matches('/').split('/').collect();
    match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["v1", "hello"]) => (
            HttpResponse {
                status: 200,
                body: json!({ "app": "hubble-desktop", "protocol": PROTOCOL_VERSION, "ready": bridge.webview_ready(), "maxTabs": MAX_TABS }),
                allow_origin: allow,
            },
            None,
        ),
        ("POST", ["v1", "sessions"]) => match bridge.open_session(now) {
            Ok((id, token)) => {
                log("session-opened", &[]);
                (
                    HttpResponse {
                        status: 201,
                        body: json!({ "sessionId": id, "token": token, "expiresInMs": SESSION_TTL.as_millis() as u64 }),
                        allow_origin: allow,
                    },
                    None,
                )
            }
            Err(r) => (refusal(r, allow), None),
        },
        ("POST", ["v1", "sessions", id, "import"]) => match bridge.submit(id, bearer(request), &request.body, now) {
            Ok(queued) => {
                let tabs = queued.tabs.len();
                log(
                    "import-queued",
                    &[("requestId", &queued.request_id), ("tabs", &tabs.to_string()), ("rejected", &queued.rejected.to_string())],
                );
                (
                    HttpResponse {
                        status: 202,
                        body: json!({ "status": "waiting", "requestId": queued.request_id, "accepted": tabs, "rejected": queued.rejected }),
                        allow_origin: allow,
                    },
                    Some(Effect::Queued { request_id: queued.request_id, tabs }),
                )
            }
            Err(r) => {
                log("import-refused", &[("reason", r.reason())]);
                (refusal(r, allow), None)
            }
        },
        ("GET", ["v1", "sessions", id]) => match bridge.status(id, bearer(request), now) {
            Ok(body) => (HttpResponse { status: 200, body, allow_origin: allow }, None),
            Err(r) => (refusal(r, allow), None),
        },
        (_, ["v1", "hello"]) | (_, ["v1", "sessions"]) | (_, ["v1", "sessions", _]) | (_, ["v1", "sessions", _, "import"]) => {
            (refusal(Refusal::MethodNotAllowed, allow), None)
        }
        _ => (refusal(Refusal::NotFound, allow), None),
    }
}

/// Development diagnostics on stderr (a debug build keeps its console). Ids,
/// counts and reasons only — never an address, a title or a token.
fn log(stage: &str, fields: &[(&str, &str)]) {
    if cfg!(debug_assertions) {
        let rendered: Vec<String> = fields.iter().map(|(k, v)| format!("{k}={v}")).collect();
        eprintln!("[hubble-import] {stage} {}", rendered.join(" "));
    }
}

/* ------------------------------------------------------------------ *
 * The app's half
 * ------------------------------------------------------------------ */

/// Managed by Tauri; shared with the listener thread.
pub struct ImportBridgeState(pub Arc<Mutex<Bridge>>);

/// Brings Hubble's one window to the front — after an import arrives, a
/// `hubble://` link, or a second launch.
pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Starts listening on the first free port in BRIDGE_PORTS. If none is free
/// (another program holds all three) Hubble runs normally without the bridge
/// and the extension reports Hubble Desktop as not responding.
pub fn start(app: AppHandle, bridge: Arc<Mutex<Bridge>>) {
    let bound = BRIDGE_PORTS
        .iter()
        .find_map(|&port| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).ok().map(|listener| (listener, port)));
    let Some((listener, port)) = bound else {
        log("bridge-unavailable", &[("reason", "all ports in use")]);
        return;
    };
    log("bridge-listening", &[("port", &port.to_string())]);

    let active = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                active.fetch_sub(1, Ordering::SeqCst);
                let _ = stream.shutdown(Shutdown::Both);
                continue;
            }
            let (app, bridge, active) = (app.clone(), Arc::clone(&bridge), Arc::clone(&active));
            std::thread::spawn(move || {
                serve(stream, &app, &bridge, port);
                active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
}

fn serve(mut stream: TcpStream, app: &AppHandle, bridge: &Mutex<Bridge>, port: u16) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let (response, effect) = match read_request(&mut stream) {
        Ok(request) => route(bridge, &request, port, Instant::now()),
        Err(status) => (HttpResponse { status, body: json!({ "ok": false, "reason": "bad-request" }), allow_origin: None }, None),
    };
    let _ = write_response(&mut stream, &response);
    let _ = stream.shutdown(Shutdown::Both);

    if let Some(Effect::Queued { request_id, tabs }) = effect {
        let _ = app.emit(REQUESTED_EVENT, json!({ "requestId": request_id, "tabs": tabs }));
        focus_main_window(app);
    }
}

/* ------------------------------------------------------------------ *
 * Commands (the webview's half)
 * ------------------------------------------------------------------ */

/// Requests waiting for the person. Called when the webview is ready to show
/// them — on start-up and on each `hubble-import:requested`.
#[tauri::command]
pub fn desktop_import_take(state: tauri::State<'_, ImportBridgeState>) -> Vec<Value> {
    let mut bridge = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    bridge.take(Instant::now())
}

/// The person's answer to one request: added to a project, or cancelled.
#[tauri::command]
pub fn desktop_import_finish(
    state: tauri::State<'_, ImportBridgeState>,
    request_id: String,
    outcome: ImportOutcome,
) -> Result<(), String> {
    let mut bridge = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let status = outcome.status.clone();
    let counts = format!("{}/{}/{}", outcome.added, outcome.duplicates, outcome.failed);
    let result = bridge.finish(&request_id, outcome, Instant::now());
    log(
        "import-finished",
        &[("requestId", &request_id), ("status", &status), ("added/duplicates/failed", &counts), ("recorded", if result.is_ok() { "yes" } else { "no" })],
    );
    result
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 41517;
    const EXT: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

    fn payload(tabs: Value) -> Vec<u8> {
        json!({ "version": 1, "requestId": "req-12345678", "source": "chrome-extension", "tabs": tabs }).to_string().into_bytes()
    }

    fn tab(url: &str) -> Value {
        json!({ "url": url, "title": "A page" })
    }

    fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> HttpRequest {
        let mut all: Vec<(String, String)> = vec![("host".into(), format!("127.0.0.1:{PORT}")), ("origin".into(), EXT.into())];
        for (key, value) in headers {
            all.retain(|(k, _)| k != key);
            if !value.is_empty() {
                all.push((key.to_string(), value.to_string()));
            }
        }
        HttpRequest { method: method.into(), path: path.into(), headers: all, body: body.to_vec() }
    }

    fn open(bridge: &Mutex<Bridge>, now: Instant) -> (String, String) {
        let (response, _) = route(bridge, &request("POST", "/v1/sessions", &[], b""), PORT, now);
        assert_eq!(response.status, 201);
        (response.body["sessionId"].as_str().unwrap().into(), response.body["token"].as_str().unwrap().into())
    }

    fn submit(bridge: &Mutex<Bridge>, id: &str, token: &str, body: &[u8], now: Instant) -> (HttpResponse, Option<Effect>) {
        let auth = format!("Bearer {token}");
        route(bridge, &request("POST", &format!("/v1/sessions/{id}/import"), &[("authorization", &auth)], body), PORT, now)
    }

    fn poll(bridge: &Mutex<Bridge>, id: &str, token: &str, now: Instant) -> HttpResponse {
        let auth = format!("Bearer {token}");
        route(bridge, &request("GET", &format!("/v1/sessions/{id}"), &[("authorization", &auth)], b""), PORT, now).0
    }

    fn done(added: usize, duplicates: usize, failed: usize) -> ImportOutcome {
        ImportOutcome { status: "done".into(), project: Some("Research".into()), added, duplicates, failed }
    }

    #[test]
    fn a_valid_import_travels_from_session_to_result() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        let (response, effect) = submit(&bridge, &id, &token, &payload(json!([tab("https://example.com/a"), tab("https://example.org/b")])), now);
        assert_eq!(response.status, 202);
        assert_eq!(effect, Some(Effect::Queued { request_id: "req-12345678".into(), tabs: 2 }));
        assert_eq!(poll(&bridge, &id, &token, now).body["status"], "waiting");

        let pending = bridge.lock().unwrap().take(now);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["tabs"][1]["url"], "https://example.org/b");
        assert_eq!(pending[0]["received"], 2);

        bridge.lock().unwrap().finish("req-12345678", done(1, 1, 0), now).unwrap();
        let result = poll(&bridge, &id, &token, now);
        assert_eq!(result.body["status"], "done");
        assert_eq!(result.body["result"]["added"], 1);
        assert_eq!(result.body["result"]["duplicates"], 1);
        assert_eq!(result.body["result"]["project"], "Research");
        assert_eq!(result.body["result"]["success"], true);
        // Handed over once, then forgotten.
        assert_eq!(poll(&bridge, &id, &token, now).status, 404);
    }

    #[test]
    fn a_wrong_or_missing_token_is_refused() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        let wrong = "0".repeat(token.len());
        assert_eq!(submit(&bridge, &id, &wrong, &payload(json!([tab("https://example.com")])), now).0.status, 401);
        let no_auth = request("POST", &format!("/v1/sessions/{id}/import"), &[], &payload(json!([tab("https://example.com")])));
        assert_eq!(route(&bridge, &no_auth, PORT, now).0.status, 401);
        assert_eq!(poll(&bridge, &id, &wrong, now).status, 401);
        // Another session's token does not open this one.
        let (_, other_token) = open(&bridge, now);
        assert_eq!(submit(&bridge, &id, &other_token, &payload(json!([tab("https://example.com")])), now).0.status, 401);
    }

    #[test]
    fn an_unused_session_expires() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        let later = now + SESSION_TTL + Duration::from_secs(1);
        assert_eq!(submit(&bridge, &id, &token, &payload(json!([tab("https://example.com")])), later).0.status, 404);
    }

    #[test]
    fn a_request_nobody_answers_expires_into_a_result() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        submit(&bridge, &id, &token, &payload(json!([tab("https://example.com")])), now);
        let later = now + REQUEST_TTL + Duration::from_secs(1);
        assert!(bridge.lock().unwrap().take(later).is_empty());
        assert!(bridge.lock().unwrap().finish("req-12345678", done(1, 0, 0), later).is_err());
        assert_eq!(poll(&bridge, &id, &token, later).body["status"], "expired");
        // An uncollected result is dropped too.
        let (id2, token2) = open(&bridge, now);
        let body = json!({ "version": 1, "requestId": "req-87654321", "source": "chrome-extension", "tabs": [tab("https://example.com")] });
        submit(&bridge, &id2, &token2, body.to_string().as_bytes(), now);
        bridge.lock().unwrap().finish("req-87654321", done(1, 0, 0), now).unwrap();
        assert_eq!(poll(&bridge, &id2, &token2, now + RESULT_TTL + Duration::from_secs(1)).status, 404);
    }

    #[test]
    fn a_session_takes_one_batch() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        assert_eq!(submit(&bridge, &id, &token, &payload(json!([tab("https://example.com")])), now).0.status, 202);
        assert_eq!(submit(&bridge, &id, &token, &payload(json!([tab("https://example.com")])), now).0.status, 409);
    }

    #[test]
    fn malformed_payloads_are_refused_with_a_reason() {
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (b"not json".to_vec(), "invalid-payload"),
            (b"[]".to_vec(), "invalid-payload"),
            (json!({ "version": 2, "requestId": "req-12345678", "source": "chrome-extension", "tabs": [tab("https://a.example")] }).to_string().into_bytes(), "unsupported-version"),
            (json!({ "version": 1, "requestId": "req-12345678", "source": "a-web-page", "tabs": [tab("https://a.example")] }).to_string().into_bytes(), "invalid-payload"),
            (json!({ "version": 1, "requestId": "../../etc", "source": "chrome-extension", "tabs": [tab("https://a.example")] }).to_string().into_bytes(), "invalid-payload"),
            (json!({ "version": 1, "requestId": "req-12345678", "source": "chrome-extension", "tabs": "nope" }).to_string().into_bytes(), "invalid-payload"),
            (payload(json!([])), "no-tabs"),
        ];
        for (body, reason) in cases {
            let bridge = Mutex::new(Bridge::default());
            let now = Instant::now();
            let (id, token) = open(&bridge, now);
            let (response, effect) = submit(&bridge, &id, &token, &body, now);
            assert_eq!(response.status, 400, "{reason}");
            assert_eq!(response.body["reason"], reason);
            assert!(effect.is_none());
            // A refused batch leaves the session open, not wedged.
            assert_eq!(poll(&bridge, &id, &token, now).body["status"], "open");
        }
    }

    #[test]
    fn too_many_tabs_and_oversized_bodies_are_refused() {
        let tabs: Vec<Value> = (0..=MAX_TABS).map(|i| tab(&format!("https://example.com/{i}"))).collect();
        assert_eq!(validate_payload(&payload(json!(tabs))), Err(Refusal::TooManyTabs));
        let max: Vec<Value> = (0..MAX_TABS).map(|i| tab(&format!("https://example.com/{i}"))).collect();
        assert_eq!(validate_payload(&payload(json!(max))).unwrap().tabs.len(), MAX_TABS);
        assert_eq!(validate_payload(&vec![b' '; MAX_BODY_BYTES + 1]), Err(Refusal::TooLarge));
    }

    #[test]
    fn bad_addresses_are_dropped_and_counted_not_fatal() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_CHARS));
        let body = payload(json!([
            tab("https://example.com/ok"),
            tab("javascript:alert(1)"),
            tab("file:///C:/Windows/win.ini"),
            tab("chrome://settings"),
            tab("not a url"),
            tab(&long),
            json!({ "title": "no url" }),
            json!({ "url": "http://example.org/fine", "title": "x".repeat(MAX_TITLE_CHARS + 50), "favicon": "data:image/png;base64,AAAA" }),
        ]));
        let validated = validate_payload(&body).unwrap();
        assert_eq!(validated.received, 8);
        assert_eq!(validated.rejected, 6);
        assert_eq!(validated.tabs.len(), 2);
        assert_eq!(validated.tabs[1].title.as_ref().unwrap().chars().count(), MAX_TITLE_CHARS);
        assert_eq!(validated.tabs[1].favicon, None);
    }

    #[test]
    fn unknown_fields_are_not_carried_forward() {
        let body = payload(json!([{ "url": "https://example.com", "title": "T", "windowId": 4, "cookies": "secret", "favicon": "https://example.com/f.ico" }]));
        let validated = validate_payload(&body).unwrap();
        let value = serde_json::to_value(&validated.tabs[0]).unwrap();
        assert_eq!(value, json!({ "url": "https://example.com", "title": "T", "favicon": "https://example.com/f.ico" }));
    }

    #[test]
    fn web_pages_and_rebound_hosts_are_turned_away() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let page = request("POST", "/v1/sessions", &[("origin", "https://evil.example")], b"");
        assert_eq!(route(&bridge, &page, PORT, now).0.status, 403);
        let no_origin = request("POST", "/v1/sessions", &[("origin", "")], b"");
        assert_eq!(route(&bridge, &no_origin, PORT, now).0.status, 403);
        let rebound = request("GET", "/v1/hello", &[("host", "evil.example:41517")], b"");
        assert_eq!(route(&bridge, &rebound, PORT, now).0.status, 403);
        let page_hello = request("GET", "/v1/hello", &[("origin", "https://evil.example")], b"");
        assert_eq!(route(&bridge, &page_hello, PORT, now).0.status, 403);
        // Nothing was opened by any of them.
        assert_eq!(bridge.lock().unwrap().sessions.len(), 0);
    }

    #[test]
    fn only_the_four_routes_exist() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        for path in ["/", "/v1", "/v1/exec", "/v1/files", "/v2/hello", "/v1/sessions/x/y/z"] {
            assert_eq!(route(&bridge, &request("GET", path, &[], b""), PORT, now).0.status, 404, "{path}");
        }
        assert_eq!(route(&bridge, &request("DELETE", "/v1/hello", &[], b""), PORT, now).0.status, 405);
        let hello = route(&bridge, &request("GET", "/v1/hello", &[], b""), PORT, now).0;
        assert_eq!(hello.status, 200);
        assert_eq!(hello.body["app"], "hubble-desktop");
        assert_eq!(hello.body["ready"], false);
        bridge.lock().unwrap().take(now);
        assert_eq!(route(&bridge, &request("GET", "/v1/hello", &[], b""), PORT, now).0.body["ready"], true);
    }

    #[test]
    fn requests_queued_before_the_webview_is_ready_wait_for_it() {
        // Hubble launched by the extension: the batch lands before the webview
        // has loaded. It waits here until the webview takes it.
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        submit(&bridge, &id, &token, &payload(json!([tab("https://example.com")])), now);
        assert!(!bridge.lock().unwrap().webview_ready());
        let later = now + Duration::from_secs(3);
        let pending = bridge.lock().unwrap().take(later);
        assert_eq!(pending.len(), 1);
        assert!(pending[0]["expiresInMs"].as_u64().unwrap() < REQUEST_TTL.as_millis() as u64);
        // A reload before answering shows it again.
        assert_eq!(bridge.lock().unwrap().take(later).len(), 1);
    }

    #[test]
    fn sequential_imports_are_independent() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        for n in 0..5 {
            let (id, token) = open(&bridge, now);
            let request_id = format!("req-000000{n}");
            let body = json!({ "version": 1, "requestId": request_id, "source": "chrome-extension", "tabs": [tab("https://example.com")] });
            assert_eq!(submit(&bridge, &id, &token, body.to_string().as_bytes(), now).0.status, 202);
            bridge.lock().unwrap().finish(&request_id, done(1, 0, 0), now).unwrap();
            assert_eq!(poll(&bridge, &id, &token, now).body["result"]["requestId"], request_id);
        }
        assert_eq!(bridge.lock().unwrap().sessions.len(), 0);
    }

    #[test]
    fn cancelling_imports_nothing_and_says_so() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        submit(&bridge, &id, &token, &payload(json!([tab("https://example.com")])), now);
        let cancelled = ImportOutcome { status: "cancelled".into(), project: None, added: 0, duplicates: 0, failed: 0 };
        bridge.lock().unwrap().finish("req-12345678", cancelled, now).unwrap();
        let result = poll(&bridge, &id, &token, now).body;
        assert_eq!(result["status"], "cancelled");
        assert_eq!(result["result"]["success"], false);
    }

    #[test]
    fn the_webview_cannot_report_impossible_counts_or_outcomes() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (id, token) = open(&bridge, now);
        submit(&bridge, &id, &token, &payload(json!([tab("https://example.com")])), now);
        assert!(bridge.lock().unwrap().finish("req-12345678", done(5, 0, 0), now).is_err());
        let odd = ImportOutcome { status: "deleted-everything".into(), project: None, added: 0, duplicates: 0, failed: 0 };
        assert!(bridge.lock().unwrap().finish("req-12345678", odd, now).is_err());
        assert!(bridge.lock().unwrap().finish("req-unknown1", done(1, 0, 0), now).is_err());
    }

    #[test]
    fn sessions_are_capped() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        for _ in 0..MAX_SESSIONS {
            open(&bridge, now);
        }
        assert_eq!(route(&bridge, &request("POST", "/v1/sessions", &[], b""), PORT, now).0.status, 429);
        // Expired ones make room.
        let later = now + SESSION_TTL + Duration::from_secs(1);
        assert_eq!(route(&bridge, &request("POST", "/v1/sessions", &[], b""), PORT, later).0.status, 201);
    }

    #[test]
    fn tokens_are_random_and_compared_whole() {
        let mut bridge = Bridge::default();
        let now = Instant::now();
        let (a_id, a) = bridge.open_session(now).unwrap();
        let (b_id, b) = bridge.open_session(now).unwrap();
        assert_ne!(a, b);
        assert_ne!(a_id, b_id);
        assert_eq!(a.len(), 64);
        assert!(same_token(&a, &a.clone()));
        assert!(!same_token(&a, &a[..63]));
        assert!(!same_token(&a, &b));
    }

    #[test]
    fn http_requests_are_read_within_limits() {
        let raw = b"POST /v1/sessions/abc/import HTTP/1.1\r\nHost: 127.0.0.1:41517\r\nContent-Length: 5\r\nAuthorization: Bearer t\r\n\r\nhello";
        let parsed = read_request(&mut &raw[..]).unwrap();
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/v1/sessions/abc/import");
        assert_eq!(parsed.header("authorization"), Some("Bearer t"));
        assert_eq!(parsed.body, b"hello");

        let chunked = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(read_request(&mut &chunked[..]).unwrap_err(), 411);
        let huge = format!("POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
        assert_eq!(read_request(&mut huge.as_bytes()).unwrap_err(), 413);
        let endless = vec![b'a'; MAX_HEADER_BYTES * 2];
        assert_eq!(read_request(&mut &endless[..]).unwrap_err(), 431);
        let truncated = b"POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc";
        assert_eq!(read_request(&mut &truncated[..]).unwrap_err(), 400);
        let not_http = b"\x16\x03\x01 garbage\r\n\r\n";
        assert_eq!(read_request(&mut &not_http[..]).unwrap_err(), 400);
    }

    #[test]
    fn responses_only_name_extension_origins() {
        let bridge = Mutex::new(Bridge::default());
        let now = Instant::now();
        let (response, _) = route(&bridge, &request("GET", "/v1/hello", &[], b""), PORT, now);
        assert_eq!(response.allow_origin.as_deref(), Some(EXT));
        let (response, _) = route(&bridge, &request("GET", "/v1/hello", &[("origin", "")], b""), PORT, now);
        assert_eq!(response.allow_origin, None);
        let mut out = Vec::new();
        write_response(&mut out, &HttpResponse { status: 200, body: json!({ "a": 1 }), allow_origin: None }).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(!text.contains("Access-Control-Allow-Origin"));
        assert!(text.ends_with("{\"a\":1}"));
    }
}
