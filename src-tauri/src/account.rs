//! Hubble account sign-in for the desktop app.
//!
//! The website's session is an HttpOnly cookie that page JavaScript can never
//! read. This keeps the same property for Hubble Desktop: the device token
//! (src/lib/auth/device.ts on the server) lives in the OS credential store and
//! in this process, never in the webview. The webview asks for account data
//! through `account_request`, which attaches the token here, and only for
//! Hubble's own account APIs.
//!
//! Sign-in is the pairing flow in docs/auth-architecture.md, with PKCE:
//!
//! 1. `account_sign_in_begin` makes a verifier (kept here) and opens
//!    `/desktop/connect?challenge=S256(verifier)&state=…` in the default
//!    browser, where the person is — or becomes — signed in to Hubble.
//! 2. That page mints a single-use code and sends the browser to
//!    `hubble://auth/callback?code=…&state=…` (`handle_deep_link`), or shows
//!    the code to paste (`account_sign_in_complete`).
//! 3. The code and the verifier are exchanged for the device token. A code
//!    intercepted on the way back is useless without the verifier.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

/// The deployed Hubble this app signs in to.
pub const DEFAULT_ACCOUNT_ORIGIN: &str = "https://hubble-hq.vercel.app";
/// Told to the webview whenever the signed-in state may have changed.
pub const ACCOUNT_CHANGED_EVENT: &str = "hubble-account:changed";

const KEYRING_USER: &str = "hubble-account";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// A pending sign-in is abandoned after this long; the server's code lives 5 minutes.
const PENDING_TTL: Duration = Duration::from_secs(15 * 60);

/// Where account requests go. A QA build may point at a local server
/// (`HUBBLE_ACCOUNT_ORIGIN=http://localhost:3000` at compile time); anything
/// that isn't https or loopback http is ignored. Release builds set nothing.
pub fn account_origin() -> &'static str {
    match option_env!("HUBBLE_ACCOUNT_ORIGIN") {
        Some(origin) if is_allowed_origin(origin) => origin,
        _ => DEFAULT_ACCOUNT_ORIGIN,
    }
}

/// Opens a Hubble page in the default browser. A debug build compiled with
/// `HUBBLE_QA_ECHO_URLS` set also prints the address to stderr, so a QA rig
/// can open the same page in a browser it drives; release builds never do.
pub fn open_in_browser(app: &AppHandle, url: &tauri::Url) -> Result<(), String> {
    if cfg!(debug_assertions) && option_env!("HUBBLE_QA_ECHO_URLS").is_some() {
        eprintln!("[hubble-qa] open {url}");
    }
    app.opener().open_url(url.to_string(), None::<&str>).map_err(|e| e.to_string())
}

fn is_allowed_origin(origin: &str) -> bool {
    // Paths are appended to it as-is, so no trailing slash.
    if origin.ends_with('/') {
        return false;
    }
    let Ok(url) = tauri::Url::parse(origin) else { return false };
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}

/// The account APIs the webview may reach with the token: who am I, sync,
/// and AI connectors (including their older /api/mcp/tokens). Nothing else — this is not a general-purpose proxy.
pub fn is_allowed_api_path(path_and_query: &str) -> bool {
    let path = path_and_query.split('?').next().unwrap_or("");
    if !path.starts_with('/') || path.contains("..") || path.contains("//") || path.contains('\\') || path.contains('%') {
        return false;
    }
    if !path.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.')) {
        return false;
    }
    path == "/api/auth/me"
        || path.starts_with("/api/sync/")
        || path == "/api/integrations"
        || path.starts_with("/api/integrations/")
        // Revoking a connector made before AI connectors had their own grants.
        || path == "/api/mcp/tokens"
}

struct Pending {
    verifier: String,
    state: String,
    started: std::time::Instant,
}

#[derive(Default)]
pub struct AccountState {
    pending: Mutex<Option<Pending>>,
    client: Mutex<Option<reqwest::Client>>,
}

fn client(app: &AppHandle) -> Result<reqwest::Client, String> {
    let state = app.state::<AccountState>();
    let mut slot = state.client.lock().map_err(|_| "busy".to_string())?;
    if let Some(client) = slot.as_ref() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(format!("HubbleDesktop/{}", app.package_info().version))
        .build()
        .map_err(|e| e.to_string())?;
    *slot = Some(client.clone());
    Ok(client)
}

// ------------------------------------------------------------------ secrets

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(base64url(&bytes))
}

/// RFC 4648 §5, no padding.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// PKCE S256.
pub fn challenge_for(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// The stored credential: the token and the last user it resolved to, so a
/// signed-in app that starts offline still opens that account's projects.
fn keyring_entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, KEYRING_USER).map_err(|e| e.to_string())
}

fn read_credential(app: &AppHandle) -> Option<(String, Value)> {
    let raw = keyring_entry(app).ok()?.get_password().ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let token = value.get("token")?.as_str()?.to_string();
    if !token.starts_with("hbd_") {
        return None;
    }
    Some((token, value.get("user").cloned().unwrap_or(Value::Null)))
}

fn write_credential(app: &AppHandle, token: &str, user: &Value) -> Result<(), String> {
    keyring_entry(app)?
        .set_password(&json!({ "token": token, "user": user }).to_string())
        .map_err(|e| format!("Couldn't save your sign-in on this computer: {e}"))
}

fn forget_credential(app: &AppHandle) {
    if let Ok(entry) = keyring_entry(app) {
        let _ = entry.delete_credential();
    }
}

// ------------------------------------------------------------------ status

/// What the webview is told about the account. Never the token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    /// "signed-out" | "signed-in" | "offline" (signed in, server unreachable) | "expired" (token refused; it was removed)
    state: &'static str,
    user: Value,
    origin: &'static str,
}

fn status(state: &'static str, user: Value) -> AccountStatus {
    AccountStatus { state, user, origin: account_origin() }
}

fn notify(app: &AppHandle) {
    let _ = app.emit(ACCOUNT_CHANGED_EVENT, ());
}

#[tauri::command]
pub async fn account_status(app: AppHandle) -> Result<AccountStatus, String> {
    let Some((token, cached)) = read_credential(&app) else {
        return Ok(status("signed-out", Value::Null));
    };
    let response = client(&app)?
        .get(format!("{}/api/auth/me", account_origin()))
        .bearer_auth(&token)
        .send()
        .await;
    let Ok(response) = response else {
        return Ok(status("offline", cached));
    };
    if !response.status().is_success() {
        return Ok(status("offline", cached));
    }
    let body: Value = response.json_value().await.unwrap_or(Value::Null);
    if body.get("authenticated") == Some(&Value::Bool(true)) {
        let user = body.get("user").cloned().unwrap_or(Value::Null);
        if user != cached {
            let _ = write_credential(&app, &token, &user);
        }
        return Ok(status("signed-in", user));
    }
    // The server answered and doesn't know this token: revoked from the
    // web, expired, or the account is gone. It is no use to keep.
    forget_credential(&app);
    Ok(status("expired", Value::Null))
}

// ------------------------------------------------------------------ sign in

/// Starts a sign-in: opens Hubble in the default browser to approve this app.
#[tauri::command]
pub fn account_sign_in_begin(app: AppHandle) -> Result<(), String> {
    let verifier = random_secret()?;
    let state = random_secret()?;
    let label = format!("Hubble Desktop on {}", computer_name());
    let mut url = tauri::Url::parse(account_origin()).map_err(|e| e.to_string())?;
    url.set_path("/desktop/connect");
    url.query_pairs_mut()
        .append_pair("challenge", &challenge_for(&verifier))
        .append_pair("state", &state)
        .append_pair("label", &label);
    *app.state::<AccountState>().pending.lock().map_err(|_| "busy".to_string())? = Some(Pending {
        verifier,
        state,
        started: std::time::Instant::now(),
    });
    open_in_browser(&app, &url)
}

/// What the person will recognise this computer by in their list of
/// connected desktops. Some environments set the variable to a placeholder.
fn computer_name() -> String {
    pick_computer_name(["COMPUTERNAME", "HOSTNAME"].iter().filter_map(|name| std::env::var(name).ok()))
}

fn pick_computer_name(candidates: impl Iterator<Item = String>) -> String {
    candidates
        .map(|value| value.trim().chars().filter(|c| !c.is_control()).take(40).collect::<String>())
        .find(|value| !value.is_empty() && !value.eq_ignore_ascii_case("null") && !value.eq_ignore_ascii_case("localhost"))
        .unwrap_or_else(|| "this computer".into())
}

fn take_pending(app: &AppHandle, state: Option<&str>) -> Result<String, String> {
    let account = app.state::<AccountState>();
    let mut pending = account.pending.lock().map_err(|_| "busy".to_string())?;
    let Some(current) = pending.as_ref() else {
        return Err("Start signing in from Hubble Desktop first.".into());
    };
    if current.started.elapsed() > PENDING_TTL {
        *pending = None;
        return Err("That sign-in took too long. Start again.".into());
    }
    if let Some(state) = state {
        // A callback for some other attempt (an old link, someone else's) is ignored.
        if state != current.state {
            return Err("That sign-in link isn't for this attempt.".into());
        }
    }
    Ok(pending.take().map(|p| p.verifier).unwrap_or_default())
}

async fn exchange(app: &AppHandle, code: &str, verifier: &str) -> Result<Value, String> {
    let response = client(app)?
        .post(format!("{}/api/auth/desktop/token", account_origin()))
        .header("content-type", "application/json")
        .body(json!({ "code": code, "verifier": verifier }).to_string())
        .send()
        .await
        .map_err(|_| "Couldn't reach Hubble. Check your connection and try again.".to_string())?;
    let ok = response.status().is_success();
    let body: Value = response.json_value().await.unwrap_or(Value::Null);
    if !ok {
        return Err(body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Sign-in didn't complete. Try again.")
            .to_string());
    }
    let token = body.get("token").and_then(Value::as_str).filter(|t| t.starts_with("hbd_")).ok_or("Hubble sent an unexpected answer.")?;
    let user = body.get("user").cloned().unwrap_or(Value::Null);
    write_credential(app, token, &user)?;
    Ok(user)
}

/// Finishes a sign-in with a code the person pasted from the browser.
#[tauri::command]
pub async fn account_sign_in_complete(app: AppHandle, code: String) -> Result<AccountStatus, String> {
    let code = code.trim().to_string();
    if !code.starts_with("hbc_") || code.len() > 64 {
        return Err("That isn't a Hubble sign-in code.".into());
    }
    let verifier = take_pending(&app, None)?;
    let user = exchange(&app, &code, &verifier).await?;
    notify(&app);
    Ok(status("signed-in", user))
}

/// `hubble://auth/callback?code=…&state=…` from the connect page. Anything
/// else under `hubble://` only brings the window forward (see lib.rs).
pub fn handle_deep_link(app: &AppHandle, url: &tauri::Url) {
    if url.scheme() != "hubble" || url.host_str() != Some("auth") {
        return;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let (Some(code), Some(state)) = (param("code"), param("state")) else { return };
    if !code.starts_with("hbc_") || code.len() > 64 {
        return;
    }
    let Ok(verifier) = take_pending(app, Some(&state)) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = exchange(&app, &code, &verifier).await;
        let _ = app.emit("hubble-account:sign-in", json!({ "ok": result.is_ok(), "error": result.err() }));
        notify(&app);
    });
}

// ------------------------------------------------------------------ sign out

#[tauri::command]
pub async fn account_sign_out(app: AppHandle) -> Result<(), String> {
    let Some((token, _)) = read_credential(&app) else {
        notify(&app);
        return Ok(());
    };
    // The server row goes first, so a token that leaked is dead too. If the
    // server can't be reached, nothing changes here: the person is told, and
    // can also disconnect this computer from Settings → Account on the web.
    let response = client(&app)?
        .post(format!("{}/api/auth/desktop/logout", account_origin()))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|_| "Couldn't reach Hubble to sign you out. Check your connection and try again.".to_string())?;
    if !(response.status().is_success() || response.status() == reqwest::StatusCode::UNAUTHORIZED) {
        return Err(format!("Hubble couldn't sign you out ({}). Try again.", response.status().as_u16()));
    }
    forget_credential(&app);
    notify(&app);
    Ok(())
}

// ------------------------------------------------------------------ requests

#[derive(Serialize)]
pub struct ApiResponse {
    status: u16,
    body: String,
}

/// An account API call on the webview's behalf, with the device token. The
/// webview chooses the method, an allowlisted path and a JSON body — never
/// the host, and never a header.
#[tauri::command]
pub async fn account_request(app: AppHandle, method: String, path: String, body: Option<String>) -> Result<ApiResponse, String> {
    if !is_allowed_api_path(&path) {
        return Err("Hubble Desktop doesn't make that request.".into());
    }
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Unsupported method.".into()),
    };
    let Some((token, _)) = read_credential(&app) else {
        return Ok(ApiResponse { status: 401, body: json!({ "error": "Sign in to continue." }).to_string() });
    };
    let mut request = client(&app)?.request(method, format!("{}{}", account_origin(), path)).bearer_auth(&token);
    if let Some(body) = body {
        request = request.header("content-type", "application/json").body(body);
    }
    // A transport failure is a rejected promise in the webview, the same as
    // fetch going offline, so every caller's offline path applies.
    let response = request.send().await.map_err(|_| "offline".to_string())?;
    let status = response.status().as_u16();
    let bytes = response.bytes().await.map_err(|_| "offline".to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The response was too large.".into());
    }
    if status == 401 {
        // Revoked or expired while the app was open: drop it, and let the
        // webview re-check (it will land signed out, with local data intact).
        forget_credential(&app);
        notify(&app);
    }
    Ok(ApiResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

trait JsonValue {
    async fn json_value(self) -> Result<Value, String>;
}

impl JsonValue for reqwest::Response {
    async fn json_value(self) -> Result<Value, String> {
        let bytes = self.bytes().await.map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_rfc4648() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn challenge_is_rfc7636_s256() {
        // RFC 7636 appendix B.
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn only_account_apis_are_reachable() {
        for ok in ["/api/auth/me", "/api/sync/pull?workspaceId=abc&cursor=3", "/api/sync/workspaces", "/api/integrations", "/api/integrations/connections", "/api/mcp/tokens"] {
            assert!(is_allowed_api_path(ok), "{ok}");
        }
        for bad in [
            "/api/auth/google",
            "/api/auth/desktop/token",
            "/api/oauth/authorize",
            "/api/sync/../auth/google",
            "/api/sync//x",
            "/api/sync/%2e%2e/x",
            "api/sync/pull",
            "https://evil.example/api/sync/pull",
            "/api/sync\\x",
            "/api/integrationsevil",
        ] {
            assert!(!is_allowed_api_path(bad), "{bad}");
        }
    }

    #[test]
    fn a_placeholder_computer_name_reads_as_this_computer() {
        let pick = |values: &[&str]| pick_computer_name(values.iter().map(|v| v.to_string()));
        assert_eq!(pick(&["LAPTOP-7"]), "LAPTOP-7");
        assert_eq!(pick(&["NULL", "Null"]), "this computer");
        assert_eq!(pick(&["", "  ", "studio-pc"]), "studio-pc");
        assert_eq!(pick(&[]), "this computer");
        assert_eq!(pick(&["x".repeat(100).as_str()]).len(), 40);
    }

    #[test]
    fn origin_override_is_https_or_loopback_only() {
        assert!(is_allowed_origin("https://hubble-hq.vercel.app"));
        assert!(is_allowed_origin("http://localhost:3000"));
        assert!(is_allowed_origin("http://127.0.0.1:3000"));
        for bad in ["http://evil.example", "ftp://x", "https://x/path", "https://user@x", "not a url"] {
            assert!(!is_allowed_origin(bad), "{bad}");
        }
        assert_eq!(account_origin(), option_env!("HUBBLE_ACCOUNT_ORIGIN").filter(|o| is_allowed_origin(o)).unwrap_or(DEFAULT_ACCOUNT_ORIGIN));
    }
}
