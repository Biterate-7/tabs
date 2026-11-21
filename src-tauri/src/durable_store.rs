//! A durable copy of the webview's localStorage.
//!
//! Hubble keeps projects, sessions, settings and context in localStorage.
//! WebView2 (Chromium) writes localStorage to disk lazily — seconds later, and
//! longer when a page writes often — and flushes the rest only on a normal
//! close. A crash, a force-quit or a power cut therefore lost the newest edits
//! (measured: a project and its saved conversation, made under a minute before
//! a kill, were gone; a normal close kept them).
//!
//! So every change is also written here, within ~100 ms (the webview coalesces;
//! src/lib/platform/durable-storage.ts): one file per key in the app's data
//! folder, written to a temporary file, synced and renamed over the old one, so
//! a file is always either the previous value or the new one. At start-up the
//! webview restores these values before the app reads anything.
//!
//! The copy is authoritative only while it is complete: `.complete` is written
//! once the webview has seeded every key, and removed the moment any write
//! fails. Without it, the webview trusts its own localStorage (and seeds again).
//!
//! Files are named by the SHA-256 of the key (keys can be long; Windows paths
//! can't), and hold `{ "k": key, "v": value }`. Nothing here is logged.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// localStorage holds a few MB at most; one value well past that is a bug, not data.
pub const MAX_VALUE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_KEY_CHARS: usize = 1024;
pub const MAX_CHANGES: usize = 2000;
const COMPLETE: &str = ".complete";

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Change {
    pub key: String,
    /// `None` removes the key.
    pub value: Option<String>,
}

/// The folder, once the app knows its data directory.
pub struct DurableStoreState(pub Option<PathBuf>);

fn file_for(dir: &Path, key: &str) -> PathBuf {
    let hash: String = Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{hash}.v"))
}

/// Every stored value, and whether the copy is complete.
pub fn read(dir: &Path) -> (bool, HashMap<String, String>) {
    let complete = dir.join(COMPLETE).is_file();
    let mut entries = HashMap::new();
    if let Ok(listing) = fs::read_dir(dir) {
        for entry in listing.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("v") {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(parsed) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if let (Some(key), Some(value)) = (parsed.get("k").and_then(Value::as_str), parsed.get("v").and_then(Value::as_str)) {
                // A file whose name doesn't match its key was not written by us: ignored.
                if file_for(dir, key) == path {
                    entries.insert(key.to_string(), value.to_string());
                }
            }
        }
    }
    (complete, entries)
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temp, path)
}

fn validate(changes: &[Change]) -> Result<(), String> {
    if changes.len() > MAX_CHANGES {
        return Err("too many changes".into());
    }
    for change in changes {
        if change.key.is_empty() || change.key.chars().count() > MAX_KEY_CHARS {
            return Err("invalid key".into());
        }
        if change.value.as_ref().is_some_and(|v| v.len() > MAX_VALUE_BYTES) {
            return Err("value too large".into());
        }
    }
    Ok(())
}

/// Applies changes in order. `clear` first removes every stored key
/// (localStorage.clear()); `seed` marks the copy complete once they are all
/// written. Any failure leaves the copy marked incomplete.
pub fn apply(dir: &Path, changes: &[Change], clear: bool, seed: bool) -> Result<(), String> {
    let result = (|| -> Result<(), String> {
        validate(changes)?;
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        if clear {
            for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("v") {
                    fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
            }
        }
        for change in changes {
            let path = file_for(dir, &change.key);
            match &change.value {
                Some(value) => {
                    let bytes = serde_json::to_vec(&json!({ "k": change.key, "v": value })).map_err(|e| e.to_string())?;
                    write_atomically(&path, &bytes).map_err(|e| e.to_string())?;
                }
                None => match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                },
            }
        }
        if seed {
            write_atomically(&dir.join(COMPLETE), b"1").map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(dir.join(COMPLETE));
    }
    result
}

/* ---------------- commands ---------------- */

/// `{ complete, entries: { key: value } }`; an app with no data folder answers `{ complete: false, entries: {} }`.
#[tauri::command]
pub async fn durable_store_read(state: tauri::State<'_, DurableStoreState>) -> Result<Value, String> {
    let Some(dir) = state.0.clone() else { return Ok(json!({ "complete": false, "entries": {} })) };
    let (complete, entries) = tauri::async_runtime::spawn_blocking(move || read(&dir)).await.map_err(|e| e.to_string())?;
    Ok(json!({ "complete": complete, "entries": entries }))
}

/// Writes off the main thread, so a large project store never stalls the window.
#[tauri::command]
pub async fn durable_store_write(state: tauri::State<'_, DurableStoreState>, changes: Vec<Change>, clear: bool, seed: bool) -> Result<(), String> {
    let Some(dir) = state.0.clone() else { return Err("no data folder".into()) };
    tauri::async_runtime::spawn_blocking(move || apply(&dir, &changes, clear, seed)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let mut buf = [0u8; 6];
        getrandom::fill(&mut buf).unwrap();
        let dir = std::env::temp_dir().join(format!("hubble-durable-{}", buf.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn set(key: &str, value: &str) -> Change {
        Change { key: key.into(), value: Some(value.into()) }
    }

    #[test]
    fn values_round_trip_and_the_copy_is_complete_only_once_seeded() {
        let dir = temp_dir();
        assert_eq!(read(&dir), (false, HashMap::new()));
        apply(&dir, &[set("tabdump:workspaces:v1", "{\"a\":1}"), set("ünïcode ✓", "€")], false, false).unwrap();
        let (complete, entries) = read(&dir);
        assert!(!complete);
        assert_eq!(entries.get("tabdump:workspaces:v1").map(String::as_str), Some("{\"a\":1}"));
        assert_eq!(entries.get("ünïcode ✓").map(String::as_str), Some("€"));
        apply(&dir, &[], false, true).unwrap();
        assert!(read(&dir).0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn later_writes_replace_removals_delete_and_clear_empties() {
        let dir = temp_dir();
        apply(&dir, &[set("a", "1"), set("b", "2"), set("a", "3")], false, true).unwrap();
        assert_eq!(read(&dir).1, HashMap::from([("a".to_string(), "3".to_string()), ("b".to_string(), "2".to_string())]));
        apply(&dir, &[Change { key: "b".into(), value: None }, Change { key: "never-there".into(), value: None }], false, false).unwrap();
        assert_eq!(read(&dir).1, HashMap::from([("a".to_string(), "3".to_string())]));
        apply(&dir, &[set("c", "4")], true, false).unwrap();
        assert_eq!(read(&dir).1, HashMap::from([("c".to_string(), "4".to_string())]));
        // Still complete: clearing is a change like any other.
        assert!(read(&dir).0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_long_key_gets_a_short_file_name() {
        let dir = temp_dir();
        let key = format!("tabdump:workspaces:v1::{}", "u".repeat(900));
        apply(&dir, &[set(&key, "x")], false, false).unwrap();
        assert_eq!(read(&dir).1.get(&key).map(String::as_str), Some("x"));
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| e.file_name().len() <= 70));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_or_refused_write_marks_the_copy_incomplete() {
        let dir = temp_dir();
        apply(&dir, &[set("a", "1")], false, true).unwrap();
        assert!(read(&dir).0);
        assert!(apply(&dir, &[set("", "x")], false, false).is_err());
        assert!(!read(&dir).0, "a refused batch must not leave a copy that claims to be complete");
        apply(&dir, &[], false, true).unwrap();
        assert!(apply(&dir, &[set(&"k".repeat(MAX_KEY_CHARS + 1), "x")], false, false).is_err());
        assert!(!read(&dir).0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn files_that_are_not_ours_are_ignored() {
        let dir = temp_dir();
        apply(&dir, &[set("a", "1")], false, true).unwrap();
        fs::write(dir.join("0000.v"), b"{\"k\":\"b\",\"v\":\"planted\"}").unwrap();
        fs::write(dir.join("junk.v"), b"not json").unwrap();
        fs::write(dir.join("notes.txt"), b"hello").unwrap();
        assert_eq!(read(&dir).1, HashMap::from([("a".to_string(), "1".to_string())]));
        let _ = fs::remove_dir_all(dir);
    }
}
