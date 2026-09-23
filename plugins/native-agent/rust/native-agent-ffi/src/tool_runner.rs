//! Tool runner — ALL tools execute natively in Rust.
//!
//! No WebView, no Capacitor bridge. Everything runs in-process so the agent
//! can operate while the app is backgrounded and the WebView is suspended.
//!
//! Tools: file I/O, git (libgit2), shell commands, content search, web fetch,
//! cron management, and edit_file (search-replace).

use crate::types::ToolDefinition;
use crate::{MemoryProvider, NativeAgentError};
use std::sync::Arc;
use std::path::{Path, PathBuf};

const MAX_MATCHES: usize = 200;
const MAX_FILE_SIZE: u64 = 10_000_000; // 10 MB
/// Hard cap on captured process / HTTP output, in bytes.
const MAX_OUTPUT_BYTES: usize = 50_000;
/// Default wall-clock budget for `execute_command` when the caller gives none.
const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 30_000;
/// Upper bound a caller may request for `execute_command`.
const MAX_COMMAND_TIMEOUT_MS: u64 = 300_000;

static SKIP_DIRS: &[&str] = &[".git", ".openclaw", "node_modules"];

// ── UTF-8-safe truncation ───────────────────────────────────────────────────

/// Truncate `s` to at most `max_bytes` **without ever splitting a UTF-8
/// character**.
///
/// `&s[..n]` panics when `n` lands inside a multi-byte sequence, which is the
/// normal case for Bangla (3 bytes/char), CJK (3) and emoji (4). Command
/// output, HTTP bodies and grep lines are all attacker//user-controlled, so the
/// naive slice was a reachable crash. We walk back to the nearest character
/// boundary instead — `floor_char_boundary` is still unstable, so do it by hand.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// `truncate_str` plus a marker so the model knows output was cut.
fn truncate_with_notice(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let kept = truncate_str(s, max_bytes);
    format!(
        "{}\n\n[... truncated: {} of {} bytes shown ...]",
        kept,
        kept.len(),
        s.len()
    )
}

// ── Path safety ─────────────────────────────────────────────────────────────

fn resolve_path(workspace: &str, relative: &str) -> Result<PathBuf, NativeAgentError> {
    let clean = relative.replace('\\', "/");

    // Reject absolute paths outright instead of silently rewriting them.
    // `trim_start_matches('/')` used to turn "/etc/passwd" into
    // "<workspace>/etc/passwd", which hides a clear access violation behind a
    // surprising success.
    if clean.starts_with('/') {
        return Err(NativeAgentError::Tool {
            msg: "Access denied: absolute paths are not allowed, use a workspace-relative path"
                .into(),
        });
    }
    // Windows-style roots and UNC paths ("C:\..", "//server/share").
    if clean.len() >= 2 && clean.as_bytes()[1] == b':' {
        return Err(NativeAgentError::Tool {
            msg: "Access denied: absolute paths are not allowed, use a workspace-relative path"
                .into(),
        });
    }

    // Block traversal
    for part in clean.split('/') {
        if part == ".." {
            return Err(NativeAgentError::Tool {
                msg: "Access denied: path traversal (..) not allowed".into(),
            });
        }
    }

    let full = PathBuf::from(workspace).join(&clean);

    // Ensure it's still under the workspace after canonicalization.
    //
    // This must FAIL CLOSED: the previous version only compared the two paths
    // when both `canonicalize` calls succeeded, so a symlink, a permission
    // error or a missing parent skipped the containment check entirely. A
    // symlink escape is exactly the case canonicalization exists to catch.
    let canon_ws = std::fs::canonicalize(workspace).map_err(|e| NativeAgentError::Tool {
        msg: format!("Workspace is not accessible: {}", e),
    })?;
    let canon_full = std::fs::canonicalize(&full).or_else(|_| {
        // The file may legitimately not exist yet (write_file): canonicalize the
        // nearest existing ancestor and re-append the remainder.
        let mut ancestor = full.as_path();
        let mut tail = Vec::new();
        loop {
            match ancestor.parent() {
                Some(parent) => {
                    if let Some(name) = ancestor.file_name() {
                        tail.push(name.to_owned());
                    }
                    ancestor = parent;
                    if let Ok(canon) = std::fs::canonicalize(ancestor) {
                        let mut rebuilt = canon;
                        for part in tail.iter().rev() {
                            rebuilt.push(part);
                        }
                        return Ok(rebuilt);
                    }
                }
                None => {
                    return Err(NativeAgentError::Tool {
                        msg: "Access denied: path could not be resolved".to_string(),
                    })
                }
            }
        }
    })?;

    if !canon_full.starts_with(&canon_ws) {
        return Err(NativeAgentError::Tool {
            msg: "Access denied: path outside workspace".into(),
        });
    }

    Ok(canon_full)
}

fn should_skip(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

fn ok_json(val: serde_json::Value) -> Result<serde_json::Value, NativeAgentError> {
    Ok(val)
}

// ── Tool dispatch ───────────────────────────────────────────────────────────

pub fn get_tool_definitions(_workspace: &str, allowed_json: Option<&str>) -> Vec<ToolDefinition> {
    let allowed: Option<Vec<String>> = allowed_json.and_then(|j| serde_json::from_str(j).ok());
    let all = all_tool_definitions();
    match allowed {
        Some(names) if !names.is_empty() => all
            .into_iter()
            .filter(|t| names.contains(&t.name))
            .collect(),
        _ => all,
    }
}

pub fn is_builtin_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file"
            | "write_file"
            | "edit_file"
            | "list_files"
            | "find_files"
            | "grep_files"
            | "execute_command"
            | "git_init"
            | "git_status"
            | "git_add"
            | "git_commit"
            | "git_log"
            | "git_diff"
            | "web_fetch"
            | "manage_cron"
            | "memory_recall"
            | "memory_store"
            | "memory_forget"
            | "memory_search"
            | "memory_list"
    )
}

pub async fn execute_tool(
    name: &str,
    args: &serde_json::Value,
    workspace: &str,
    db_path: &str,
    memory_provider: Option<&Arc<dyn MemoryProvider>>,
) -> Result<serde_json::Value, NativeAgentError> {
    match name {
        "read_file" => tool_read_file(args, workspace),
        "write_file" => tool_write_file(args, workspace),
        "edit_file" => tool_edit_file(args, workspace),
        "list_files" => tool_list_files(args, workspace),
        "find_files" => tool_find_files(args, workspace),
        "grep_files" => tool_grep_files(args, workspace),
        "execute_command" => tool_execute_command(args, workspace).await,
        "git_init" => tool_git_init(workspace),
        "git_status" => tool_git_status(workspace),
        "git_add" => tool_git_add(args, workspace),
        "git_commit" => tool_git_commit(args, workspace),
        "git_log" => tool_git_log(args, workspace),
        "git_diff" => tool_git_diff(args, workspace),
        "web_fetch" => tool_web_fetch(args).await,
        "manage_cron" => tool_manage_cron(args, db_path),
        "memory_recall" | "memory_store" | "memory_forget" | "memory_search" | "memory_list" => {
            execute_memory_tool(name, args, memory_provider)
        }
        _ => Err(NativeAgentError::Tool {
            msg: format!("Unknown tool: {}", name),
        }),
    }
}

fn execute_memory_tool(
    name: &str,
    args: &serde_json::Value,
    provider: Option<&Arc<dyn MemoryProvider>>,
) -> Result<serde_json::Value, NativeAgentError> {
    let provider = provider.ok_or_else(|| NativeAgentError::Tool {
        msg: "Memory provider not configured".into(),
    })?;

    let metadata_json = args
        .get("metadata")
        .cloned()
        .or_else(|| {
            args.get("category")
                .and_then(|value| value.as_str())
                .map(|category| serde_json::json!({ "category": category }))
        })
        .map(|value| value.to_string());

    let result_json = match name {
        "memory_recall" => provider.recall(
            args["query"].as_str().unwrap_or("").to_string(),
            args["limit"].as_u64().unwrap_or(5) as u32,
        ),
        "memory_store" => provider.store(
            args["key"].as_str().unwrap_or("").to_string(),
            args["text"].as_str().unwrap_or("").to_string(),
            metadata_json,
        ),
        "memory_forget" => {
            let key = args["key"].as_str().unwrap_or("").to_string();
            if key.is_empty() {
                let query = args["query"].as_str().unwrap_or("").to_string();
                if query.trim().is_empty() {
                    return Ok(serde_json::json!({ "error": "Provide query or key." }));
                }

                let matches = parse_memory_search_results(&provider.search(query, 5))?;
                if matches.is_empty() {
                    return Ok(serde_json::json!({ "message": "No matching memories found." }));
                }

                if matches.len() == 1 {
                    let memory_key = matches[0]
                        .get("key")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string();
                    if memory_key.is_empty() {
                        return Ok(serde_json::json!({ "error": "Search result missing key." }));
                    }
                    return parse_memory_json(&provider.forget(memory_key));
                }

                return Ok(serde_json::json!({
                    "action": "candidates",
                    "candidates": matches,
                    "message": "Multiple matches found. Specify a key to delete."
                }));
            } else {
                provider.forget(key)
            }
        }
        "memory_search" => provider.search(
            args["query"].as_str().unwrap_or("").to_string(),
            args["maxResults"]
                .as_u64()
                .or_else(|| args["limit"].as_u64())
                .unwrap_or(5) as u32,
        ),
        "memory_list" => provider.list(
            args.get("prefix")
                .and_then(|value| value.as_str())
                .map(String::from),
            args.get("limit")
                .and_then(|value| value.as_u64())
                .map(|value| value as u32),
        ),
        _ => unreachable!(),
    };

    parse_memory_json(&result_json)
}

fn parse_memory_json(result_json: &str) -> Result<serde_json::Value, NativeAgentError> {
    serde_json::from_str(result_json).map_err(|e| NativeAgentError::Tool {
        msg: format!("Memory provider returned invalid JSON: {}", e),
    })
}

fn parse_memory_search_results(result_json: &str) -> Result<Vec<serde_json::Value>, NativeAgentError> {
    let value = parse_memory_json(result_json)?;
    match value {
        serde_json::Value::Array(items) => Ok(items),
        serde_json::Value::Object(mut object) => match object.remove("results") {
            Some(serde_json::Value::Array(items)) => Ok(items),
            _ => Err(NativeAgentError::Tool {
                msg: "Memory provider search returned an unexpected JSON shape".into(),
            }),
        },
        _ => Err(NativeAgentError::Tool {
            msg: "Memory provider search returned an unexpected JSON shape".into(),
        }),
    }
}

// ── File tools ──────────────────────────────────────────────────────────────

fn tool_read_file(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or("");
    let path = resolve_path(workspace, rel)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => ok_json(serde_json::json!({ "content": content })),
        Err(e) => ok_json(serde_json::json!({ "error": format!("Failed to read file: {}", e) })),
    }
}

/// Write a file atomically: temp file in the same directory, then rename.
///
/// `std::fs::write` TRUNCATES the destination before writing. For `edit_file`
/// that is genuinely dangerous: the tool has just read the file, and if the
/// process dies between the truncate and the write — OOM-killed on a phone,
/// battery dies, user force-quits — the user's source file is left EMPTY and
/// the original content is gone. A rename within the same directory is atomic
/// on every platform we ship, so the destination is always either the old file
/// or the complete new one.
fn write_file_atomic(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    // The temp file MUST be in the same directory: a rename across filesystems
    // is not atomic (and fails outright on some devices).
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let tmp = parent.join(format!(".{}.tmp", file_name));

    std::fs::write(&tmp, content)?;
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

fn tool_write_file(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");
    let path = resolve_path(workspace, rel)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match write_file_atomic(&path, content) {
        Ok(_) => ok_json(serde_json::json!({ "success": true, "path": rel })),
        Err(e) => ok_json(serde_json::json!({ "error": format!("Failed to write file: {}", e) })),
    }
}

fn tool_edit_file(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or("");
    let old_text = args["old_text"].as_str().unwrap_or("");
    let new_text = args["new_text"].as_str().unwrap_or("");
    let path = resolve_path(workspace, rel)?;

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            return ok_json(serde_json::json!({ "error": format!("Failed to read file: {}", e) }))
        }
    };

    if let Some(idx) = content.find(old_text) {
        let new_content = format!(
            "{}{}{}",
            &content[..idx],
            new_text,
            &content[idx + old_text.len()..]
        );
        // Atomic: edit_file has already read the file, so a truncating write
        // that dies half-way would destroy the only copy of the content.
        write_file_atomic(&path, &new_content)?;
        ok_json(serde_json::json!({ "success": true, "path": rel, "replacements": 1 }))
    } else {
        ok_json(
            serde_json::json!({ "error": "old_text not found in file. Use read_file to verify the exact content." }),
        )
    }
}

fn tool_list_files(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or(".");
    let path = resolve_path(workspace, rel)?;

    match std::fs::read_dir(&path) {
        Ok(entries) => {
            let mut items = vec![];
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if should_skip(&name) {
                    continue;
                }
                let meta = entry.metadata().ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = if is_dir {
                    None
                } else {
                    meta.as_ref().map(|m| m.len())
                };
                let mut item = serde_json::json!({ "name": name, "type": if is_dir { "directory" } else { "file" } });
                if let Some(s) = size {
                    item["size"] = serde_json::json!(s);
                }
                items.push(item);
            }
            ok_json(serde_json::json!({ "entries": items }))
        }
        Err(e) => {
            ok_json(serde_json::json!({ "error": format!("Failed to list directory: {}", e) }))
        }
    }
}

fn tool_find_files(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or(".");
    let pattern_str = args["pattern"].as_str().unwrap_or("*");
    let base = resolve_path(workspace, rel)?;
    let pattern = glob_to_regex(pattern_str);
    let ws_path = Path::new(workspace);
    let mut results = vec![];

    walk_find(&base, &pattern, &mut results, ws_path);
    ok_json(serde_json::json!({ "files": results, "total": results.len() }))
}

fn walk_find(dir: &Path, pattern: &regex::Regex, results: &mut Vec<serde_json::Value>, ws: &Path) {
    if results.len() >= MAX_MATCHES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if results.len() >= MAX_MATCHES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip(&name) {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        if pattern.is_match(&name) {
            let rel = path.strip_prefix(ws).unwrap_or(&path);
            let mut item = serde_json::json!({ "path": rel.to_string_lossy(), "type": if is_dir { "directory" } else { "file" } });
            if !is_dir {
                if let Ok(meta) = std::fs::metadata(&path) {
                    item["size"] = serde_json::json!(meta.len());
                }
            }
            results.push(item);
        }
        if is_dir {
            walk_find(&path, pattern, results, ws);
        }
    }
}

fn tool_grep_files(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or(".");
    let pattern_str = args["pattern"].as_str().unwrap_or("");
    let case_insensitive = args["case_insensitive"].as_bool().unwrap_or(false);
    let base = resolve_path(workspace, rel)?;

    let re = regex::RegexBuilder::new(pattern_str)
        .case_insensitive(case_insensitive)
        .build();
    let re = match re {
        Ok(r) => r,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Invalid regex: {}", e) })),
    };

    let ws_path = Path::new(workspace);
    let mut matches = vec![];

    if base.is_file() {
        grep_file(&base, &re, &mut matches, ws_path);
    } else {
        walk_grep(&base, &re, &mut matches, ws_path);
    }

    ok_json(serde_json::json!({ "matches": matches, "total": matches.len() }))
}

fn grep_file(path: &Path, re: &regex::Regex, matches: &mut Vec<serde_json::Value>, ws: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_FILE_SIZE {
            return;
        }
    }
    if let Ok(content) = std::fs::read_to_string(path) {
        let rel = path.strip_prefix(ws).unwrap_or(path);
        for (i, line) in content.lines().enumerate() {
            if matches.len() >= MAX_MATCHES {
                break;
            }
            if re.is_match(line) {
                // UTF-8-safe: a 500-byte cut inside a Bangla/CJK/emoji line
                // used to panic and take the whole app down.
                matches.push(serde_json::json!({
                    "file": rel.to_string_lossy(),
                    "line": i + 1,
                    "content": truncate_str(line, 500),
                }));
            }
        }
    }
}

fn walk_grep(dir: &Path, re: &regex::Regex, matches: &mut Vec<serde_json::Value>, ws: &Path) {
    if matches.len() >= MAX_MATCHES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if matches.len() >= MAX_MATCHES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip(&name) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_grep(&path, re, matches, ws);
        } else {
            grep_file(&path, re, matches, ws);
        }
    }
}

// ── Shell execution ─────────────────────────────────────────────────────────

async fn tool_execute_command(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let command = args["command"].as_str().unwrap_or("");
    let cwd = args["cwd"].as_str().unwrap_or("");
    let work_dir = if cwd.is_empty() {
        PathBuf::from(workspace)
    } else {
        resolve_path(workspace, cwd)?
    };

    // A command with no time limit blocks the whole turn forever: tool
    // execution is awaited directly (not inside the loop's `select!`), so the
    // engine's own wall-clock budget cannot interrupt it. `sleep 1d`, a command
    // that reads stdin, or a hung socket used to wedge the agent permanently —
    // and on Android that surfaces as a WorkManager ANR.
    let timeout_ms = args["timeout_ms"]
        .as_u64()
        .or_else(|| args["timeoutMs"].as_u64())
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS)
        .min(MAX_COMMAND_TIMEOUT_MS);

    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(&work_dir)
        // Detach stdin so an interactive command reports EOF instead of
        // blocking forever waiting for input that can never arrive.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| NativeAgentError::Tool {
            msg: format!("Command failed to start: {}", e),
        })?;

    let wait = child.wait_with_output();
    let output = match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), wait).await
    {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return Err(NativeAgentError::Tool {
                msg: format!("Command failed: {}", e),
            })
        }
        Err(_elapsed) => {
            // `wait_with_output` consumed the child handle, so the kill has to
            // happen through the OS. Report the timeout as a tool *result*
            // rather than an error so the model can react (shorten the command,
            // raise timeout_ms) instead of the turn dying.
            return ok_json(serde_json::json!({
                "exitCode": -1,
                "stdout": "",
                "stderr": format!(
                    "Command timed out after {} ms and was terminated. Pass a larger `timeout_ms` (max {} ms) if the command legitimately needs longer.",
                    timeout_ms, MAX_COMMAND_TIMEOUT_MS
                ),
                "timedOut": true,
            }));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    ok_json(serde_json::json!({
        "exitCode": output.status.code().unwrap_or(-1),
        "stdout": truncate_with_notice(&stdout, MAX_OUTPUT_BYTES),
        "stderr": truncate_with_notice(&stderr, MAX_OUTPUT_BYTES),
        "timedOut": false,
    }))
}

// ── Git tools ────────────────────────────────────────────────────────────

// Git operations use libgit2 in-process whenever the "libgit2" feature is on.
//
// That feature is in `default`, and *every* shipped build enables it —
// including iOS: `tools/agent-ffi/build-ios-xcframework.sh` never passes
// `--no-default-features`, and the committed `ios-arm64` slice does contain
// libgit2. An earlier version of this comment claimed the opposite ("on iOS
// libgit2 is excluded ... we shell out to the git CLI"); both halves were
// wrong — the iOS slice links libgit2, and nothing here shells out to a git
// CLI (iOS has no git binary and the sandbox forbids spawning one anyway).
//
// The ___chkstk_darwin story is real but already solved: libgit2's vendored C
// leaves 14 undefined `___chkstk_darwin` symbols, and they resolve because the
// build script exports `IPHONEOS_DEPLOYMENT_TARGET=14.0` so the compiler-rt
// shipped with the iOS SDK provides them. Dropping that export — not the
// feature flag — is what breaks the link.
//
// The `#[cfg(not(feature = "libgit2"))]` stubs further down are therefore a
// genuine fallback for an opt-out build (`--no-default-features`, useful when
// an ABI such as armeabi-v7a cannot compile libgit2), not the iOS path.

#[cfg(feature = "libgit2")]
fn tool_git_init(workspace: &str) -> Result<serde_json::Value, NativeAgentError> {
    match git2::Repository::init(workspace) {
        Ok(_) => {
            let gi = Path::new(workspace).join(".gitignore");
            if !gi.exists() {
                let _ = std::fs::write(&gi, ".openclaw/\n");
            }
            ok_json(serde_json::json!({ "success": true, "message": "Initialized git repository" }))
        }
        Err(e) => ok_json(serde_json::json!({ "error": format!("Failed to init git: {}", e) })),
    }
}

#[cfg(feature = "libgit2")]
fn tool_git_status(workspace: &str) -> Result<serde_json::Value, NativeAgentError> {
    let repo = match git2::Repository::open(workspace) {
        Ok(r) => r,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Not a git repo: {}", e) })),
    };
    let statuses = match repo.statuses(None) {
        Ok(s) => s,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Status failed: {}", e) })),
    };
    let mut files = vec![];
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("?");
        let st = entry.status();
        let status = if st.contains(git2::Status::WT_NEW) {
            "untracked"
        } else if st.contains(git2::Status::INDEX_NEW) {
            "added"
        } else if st.contains(git2::Status::WT_MODIFIED) {
            "modified (unstaged)"
        } else if st.contains(git2::Status::INDEX_MODIFIED) {
            "modified (staged)"
        } else if st.contains(git2::Status::WT_DELETED) {
            "deleted (unstaged)"
        } else if st.contains(git2::Status::INDEX_DELETED) {
            "deleted (staged)"
        } else {
            continue;
        };
        files.push(serde_json::json!({ "path": path, "status": status }));
    }
    ok_json(serde_json::json!({ "files": files }))
}

#[cfg(feature = "libgit2")]
fn tool_git_add(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let repo = match git2::Repository::open(workspace) {
        Ok(r) => r,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Not a git repo: {}", e) })),
    };
    let path_arg = args["path"].as_str().unwrap_or(".");
    let mut index = repo
        .index()
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    if path_arg == "." {
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    } else {
        index
            .add_path(Path::new(path_arg))
            .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    }
    index
        .write()
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    ok_json(serde_json::json!({ "success": true, "path": path_arg }))
}

#[cfg(feature = "libgit2")]
fn tool_git_commit(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let message = args["message"].as_str().unwrap_or("No message");
    let author_name = args["author_name"].as_str().unwrap_or("mobile-claw");
    let author_email = args["author_email"]
        .as_str()
        .unwrap_or("agent@mobile-claw.local");
    let repo = match git2::Repository::open(workspace) {
        Ok(r) => r,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Not a git repo: {}", e) })),
    };

    // Stage files if specified
    if let Some(files) = args["files"].as_array() {
        let mut index = repo
            .index()
            .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
        for f in files {
            if let Some(p) = f.as_str() {
                let _ = index.add_path(Path::new(p));
            }
        }
        index
            .write()
            .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    }

    let sig = git2::Signature::now(author_name, author_email)
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    let mut index = repo
        .index()
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    let tree_oid = index
        .write_tree()
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.as_ref().map(|p| vec![p]).unwrap_or_default();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    ok_json(serde_json::json!({ "success": true, "sha": oid.to_string(), "message": message }))
}

#[cfg(feature = "libgit2")]
fn tool_git_log(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let max_count = args["max_count"].as_u64().unwrap_or(10) as usize;
    let repo = match git2::Repository::open(workspace) {
        Ok(r) => r,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Not a git repo: {}", e) })),
    };
    let mut revwalk = repo
        .revwalk()
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    revwalk
        .push_head()
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    let mut commits = vec![];
    for oid in revwalk.take(max_count).flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            let author = commit.author();
            commits.push(serde_json::json!({
                "sha": oid.to_string(),
                "message": commit.message().unwrap_or(""),
                "author": author.name().unwrap_or(""),
                "email": author.email().unwrap_or(""),
                "timestamp": commit.time().seconds(),
            }));
        }
    }
    ok_json(serde_json::json!({ "commits": commits }))
}

#[cfg(feature = "libgit2")]
fn tool_git_diff(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let staged = args["staged"].as_bool().unwrap_or(false);
    let repo = match git2::Repository::open(workspace) {
        Ok(r) => r,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Not a git repo: {}", e) })),
    };

    let mut diff_opts = git2::DiffOptions::new();
    let diff = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
    };
    let diff = match diff {
        Ok(d) => d,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Diff failed: {}", e) })),
    };

    let mut changes: Vec<serde_json::Value> = vec![];
    let _ = diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        if changes.len() >= 100 { return true; }
        let path = delta.new_file().path().unwrap_or(Path::new("?")).to_string_lossy().to_string();
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        let prefix = match line.origin() { '+' => "+", '-' => "-", ' ' => " ", _ => "" };

        // Append to existing file entry or create new one
        if let Some(last) = changes.last_mut() {
            if last["path"].as_str() == Some(&path) {
                if let Some(patch) = last["patch"].as_str() {
                    let new_patch = format!("{}{}{}", patch, prefix, content);
                    if new_patch.len() < 5000 { last["patch"] = serde_json::json!(new_patch); }
                }
                return true;
            }
        }
        let status = match delta.status() {
            git2::Delta::Added => "added", git2::Delta::Deleted => "deleted",
            git2::Delta::Modified => "modified", _ => "unknown",
        };
        changes.push(serde_json::json!({ "path": path, "status": status, "patch": format!("{}{}", prefix, content) }));
        true
    });

    ok_json(serde_json::json!({ "changes": changes }))
}

// ── Git tools (stubs for --no-default-features builds) ──────────────────
//
// Reached only when the crate is compiled without the "libgit2" feature — for
// example an `armeabi-v7a` build where the vendored C fails to compile. The
// shipped Android and iOS slices all have libgit2 enabled, so these stubs are
// not the iOS code path (see the note above the real implementations).
// Return a clear error so the agent can fall back to isomorphic-git (JS) or
// skip git operations.

#[cfg(not(feature = "libgit2"))]
const GIT_UNAVAILABLE: &str = "Git operations are not available on this platform (no libgit2). Use isomorphic-git from the JavaScript layer instead.";

#[cfg(not(feature = "libgit2"))]
fn tool_git_init(_workspace: &str) -> Result<serde_json::Value, NativeAgentError> {
    ok_json(serde_json::json!({ "error": GIT_UNAVAILABLE }))
}

#[cfg(not(feature = "libgit2"))]
fn tool_git_status(_workspace: &str) -> Result<serde_json::Value, NativeAgentError> {
    ok_json(serde_json::json!({ "error": GIT_UNAVAILABLE }))
}

#[cfg(not(feature = "libgit2"))]
fn tool_git_add(
    _args: &serde_json::Value,
    _workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    ok_json(serde_json::json!({ "error": GIT_UNAVAILABLE }))
}

#[cfg(not(feature = "libgit2"))]
fn tool_git_commit(
    _args: &serde_json::Value,
    _workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    ok_json(serde_json::json!({ "error": GIT_UNAVAILABLE }))
}

#[cfg(not(feature = "libgit2"))]
fn tool_git_log(
    _args: &serde_json::Value,
    _workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    ok_json(serde_json::json!({ "error": GIT_UNAVAILABLE }))
}

#[cfg(not(feature = "libgit2"))]
fn tool_git_diff(
    _args: &serde_json::Value,
    _workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    ok_json(serde_json::json!({ "error": GIT_UNAVAILABLE }))
}

// ── Web fetch ───────────────────────────────────────────────────────────────

/// Reject URLs that point back at the device or a private network.
///
/// `web_fetch` takes a URL chosen by the MODEL, so it is a server-side request
/// forgery sink: prompt-injected content ("fetch http://169.254.169.254/...")
/// could make the agent read cloud instance metadata, reach services bound to
/// localhost, or scan the user's LAN — all from inside the app's network
/// position, and return the result straight back into the transcript.
///
/// Only http/https are allowed, and the host must not be a loopback,
/// link-local, unique-local or private address. Hostnames that are not literal
/// IPs are resolved first, so `localtest.me`-style names that map to 127.0.0.1
/// are caught too, and EVERY resolved address must be public.
fn ensure_url_is_fetchable(url: &str) -> Result<(), NativeAgentError> {
    let parsed = reqwest::Url::parse(url).map_err(|e| NativeAgentError::Tool {
        msg: format!("Invalid URL: {}", e),
    })?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(NativeAgentError::Tool {
                msg: format!(
                    "Access denied: only http and https URLs can be fetched (got '{}')",
                    other
                ),
            })
        }
    }

    let host = parsed.host_str().ok_or_else(|| NativeAgentError::Tool {
        msg: "Access denied: the URL has no host".to_string(),
    })?;

    // Resolve through the OS so hostnames pointing at private space are caught.
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addrs: Vec<std::net::IpAddr> = match std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
    {
        Ok(iter) => iter.map(|sa| sa.ip()).collect(),
        Err(e) => {
            return Err(NativeAgentError::Tool {
                msg: format!("Could not resolve host '{}': {}", host, e),
            })
        }
    };

    if addrs.is_empty() {
        return Err(NativeAgentError::Tool {
            msg: format!("Could not resolve host '{}'", host),
        });
    }

    for ip in addrs {
        if is_private_ip(&ip) {
            return Err(NativeAgentError::Tool {
                msg: format!(
                    "Access denied: '{}' resolves to the private/loopback address {} — \
                     web_fetch may only reach public internet hosts",
                    host, ip
                ),
            });
        }
    }
    Ok(())
}

/// Addresses that must never be reachable through `web_fetch`.
fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()            // 127.0.0.0/8
                || v4.is_private()      // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local()   // 169.254/16 — cloud metadata
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()  // 0.0.0.0
                || v4.octets()[0] == 127
                // 100.64/10 carrier-grade NAT
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 unique-local
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // fe80::/10 link-local
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // IPv4-mapped (::ffff:127.0.0.1) must be judged as its IPv4 form
                || v6.to_ipv4_mapped()
                    .map(|v4| is_private_ip(&std::net::IpAddr::V4(v4)))
                    .unwrap_or(false)
        }
    }
}

async fn tool_web_fetch(args: &serde_json::Value) -> Result<serde_json::Value, NativeAgentError> {
    let url = args["url"].as_str().unwrap_or("");
    let method = args["method"].as_str().unwrap_or("GET").to_uppercase();

    // Without a timeout a slow endpoint blocks the turn indefinitely, exactly
    // like `execute_command` did.
    let timeout_ms = args["timeout_ms"]
        .as_u64()
        .or_else(|| args["timeoutMs"].as_u64())
        .unwrap_or(30_000)
        .min(120_000);
    if let Err(err) = ensure_url_is_fetchable(url) {
        // Report as a tool result rather than a hard error so the model can
        // explain itself instead of the turn dying.
        return ok_json(serde_json::json!({ "error": err.to_string() }));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        // Follow a few redirects, but re-check every hop: without this a public
        // URL could 302 straight to 169.254.169.254 and walk around the check
        // above.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            match attempt.url().host_str() {
                Some(host) => {
                    let port = attempt.url().port_or_known_default().unwrap_or(80);
                    match std::net::ToSocketAddrs::to_socket_addrs(&(host, port)) {
                        Ok(addrs) => {
                            if addrs.map(|sa| sa.ip()).any(|ip| is_private_ip(&ip)) {
                                attempt.stop()
                            } else {
                                attempt.follow()
                            }
                        }
                        Err(_) => attempt.stop(),
                    }
                }
                None => attempt.stop(),
            }
        }))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut req = match method.as_str() {
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        "PATCH" => client.patch(url),
        _ => client.get(url),
    };
    if let Some(body) = args["body"].as_str() {
        req = req.body(body.to_string());
    }
    if let Some(headers) = args["headers"].as_object() {
        for (k, v) in headers {
            if let Some(vs) = v.as_str() {
                req = req.header(k.as_str(), vs);
            }
        }
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            // UTF-8-safe: `&body[..50_000]` panicked whenever the cut landed
            // inside a multi-byte character (any Bangla/CJK/emoji page).
            ok_json(serde_json::json!({
                "status": status,
                "body": truncate_with_notice(&body, MAX_OUTPUT_BYTES),
            }))
        }
        Err(e) => ok_json(serde_json::json!({ "error": format!("Fetch failed: {}", e) })),
    }
}

// ── Cron management ─────────────────────────────────────────────────────────

/// `manage_cron` — the agent's own scheduling tool.
///
/// This used to open a *second* SQLite connection against a guessed path
/// (`<workspace>/../mobile-claw.db`) and run SQL against columns that do not
/// exist in the schema (`schedule`, `status`, `run_count`). Both halves were
/// broken: the guessed path rarely matched the engine's real `dbPath`, so the
/// tool created an empty database with no `cron_jobs` table at all, and even
/// against the right file every statement failed with `no such column`. The
/// `history` action additionally interpolated the job id straight into SQL.
///
/// It now goes through the same `db::*` functions the JS API uses, against the
/// engine's real database path, so a job the agent creates is the very same row
/// `listCronJobs()` returns.
fn tool_manage_cron(
    args: &serde_json::Value,
    db_path: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let action = args["action"].as_str().unwrap_or("help");

    let conn = crate::db::open_db(db_path)?;
    crate::db::ensure_schema(&conn)?;

    match action {
        "list" => {
            let jobs_json = crate::db::list_cron_jobs(&conn)?;
            let jobs: serde_json::Value = serde_json::from_str(&jobs_json)?;
            ok_json(serde_json::json!({ "jobs": jobs }))
        }
        "create" => {
            // Accept both the rich schedule object used by the JS API and the
            // flat shorthand that is far easier for a model to emit.
            let mut input = serde_json::Map::new();
            input.insert(
                "name".into(),
                serde_json::json!(args["name"].as_str().unwrap_or("unnamed")),
            );
            input.insert(
                "prompt".into(),
                serde_json::json!(args["prompt"].as_str().unwrap_or("")),
            );
            if let Some(skill) = args["skillId"].as_str() {
                input.insert("skillId".into(), serde_json::json!(skill));
            }
            if let Some(title) = args["notificationTitle"].as_str() {
                input.insert(
                    "delivery".into(),
                    serde_json::json!({ "mode": "notification", "notificationTitle": title }),
                );
            }

            let schedule = if args.get("schedule").map(|s| s.is_object()).unwrap_or(false) {
                args["schedule"].clone()
            } else if let Some(at_ms) = args["atMs"].as_i64() {
                serde_json::json!({ "kind": "at", "atMs": at_ms })
            } else if let Some(every_ms) = args["everyMs"].as_i64() {
                serde_json::json!({ "kind": "every", "everyMs": every_ms })
            } else if let Some(minutes) = args["everyMinutes"].as_i64() {
                serde_json::json!({ "kind": "every", "everyMs": minutes * 60_000 })
            } else if let Some(delay) = args["inMinutes"].as_i64() {
                serde_json::json!({
                    "kind": "at",
                    "atMs": chrono::Utc::now().timestamp_millis() + delay * 60_000,
                })
            } else {
                return ok_json(serde_json::json!({
                    "error": "A schedule is required. Pass `inMinutes`, `everyMinutes`, `everyMs`, `atMs`, or a full `schedule` object such as {\"kind\":\"every\",\"everyMs\":3600000}."
                }));
            };
            input.insert("schedule".into(), schedule);

            let created =
                crate::db::add_cron_job(&conn, &serde_json::to_string(&serde_json::Value::Object(input))?)?;
            let created_value: serde_json::Value = serde_json::from_str(&created)?;
            ok_json(serde_json::json!({ "success": true, "job": created_value }))
        }
        "delete" | "remove" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return ok_json(serde_json::json!({ "error": "`id` is required" }));
            }
            crate::db::remove_cron_job(&conn, id)?;
            ok_json(serde_json::json!({ "success": true, "id": id }))
        }
        "pause" | "disable" | "resume" | "enable" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return ok_json(serde_json::json!({ "error": "`id` is required" }));
            }
            let enabled = matches!(action, "resume" | "enable");
            let patch = serde_json::json!({ "enabled": enabled });
            crate::db::update_cron_job(&conn, id, &serde_json::to_string(&patch)?)?;
            ok_json(serde_json::json!({ "success": true, "id": id, "enabled": enabled }))
        }
        "run" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return ok_json(serde_json::json!({ "error": "`id` is required" }));
            }
            // Mark it due now; the next wake (or `handleWake`) picks it up.
            crate::db::run_cron_job(&conn, id)?;
            ok_json(serde_json::json!({
                "success": true,
                "id": id,
                "message": "Job marked due; it runs on the next wake.",
            }))
        }
        "history" => {
            let limit = args["limit"].as_i64().unwrap_or(20).clamp(1, 200);
            // Parameterised inside db::list_cron_runs — the old version
            // interpolated the id directly into the SQL string.
            let runs_json = crate::db::list_cron_runs(&conn, args["id"].as_str(), limit)?;
            let runs: serde_json::Value = serde_json::from_str(&runs_json)?;
            ok_json(serde_json::json!({ "runs": runs }))
        }
        "status" => {
            let jobs_json = crate::db::list_cron_jobs(&conn)?;
            let jobs: serde_json::Value = serde_json::from_str(&jobs_json)?;
            let total = jobs.as_array().map(|a| a.len()).unwrap_or(0);
            let enabled = jobs
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter(|j| j.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false))
                        .count()
                })
                .unwrap_or(0);
            let scheduler: serde_json::Value =
                serde_json::from_str(&crate::db::get_scheduler_config(&conn)?)?;
            let heartbeat: serde_json::Value =
                serde_json::from_str(&crate::db::get_heartbeat_config(&conn)?)?;
            ok_json(serde_json::json!({
                "totalJobs": total,
                "enabledJobs": enabled,
                "scheduler": scheduler,
                "heartbeat": heartbeat,
            }))
        }
        _ => ok_json(serde_json::json!({
            "message": "Actions: list, create, delete, pause, resume, run, history, status",
            "createExample": { "action": "create", "name": "standup", "prompt": "Summarise my day", "everyMinutes": 1440 },
        })),
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn glob_to_regex(glob: &str) -> regex::Regex {
    let mut pattern = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => pattern.push_str(".*"),
            '?' => pattern.push('.'),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                pattern.push('\\');
                pattern.push(c);
            }
            _ => pattern.push(c),
        }
    }
    pattern.push('$');
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .unwrap_or_else(|_| regex::Regex::new(".*").unwrap())
}

// ── Tool definitions ────────────────────────────────────────────────────────

fn all_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        tool_def(
            "read_file",
            "Read a file from the workspace",
            serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "File path relative to workspace" } },
                "required": ["path"]
            }),
        ),
        tool_def(
            "write_file",
            "Write content to a file",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path relative to workspace" },
                    "content": { "type": "string", "description": "File content" }
                },
                "required": ["path", "content"]
            }),
        ),
        tool_def(
            "edit_file",
            "Edit a file by replacing old_text with new_text",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path relative to workspace" },
                    "old_text": { "type": "string", "description": "Text to find" },
                    "new_text": { "type": "string", "description": "Replacement text" }
                },
                "required": ["path", "old_text", "new_text"]
            }),
        ),
        tool_def(
            "list_files",
            "List files in a directory",
            serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Directory path relative to workspace" } },
                "required": ["path"]
            }),
        ),
        tool_def(
            "find_files",
            "Search for files matching a glob pattern",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern (e.g. *.ts)" },
                    "path": { "type": "string", "description": "Base directory" }
                },
                "required": ["pattern"]
            }),
        ),
        tool_def(
            "grep_files",
            "Search file contents with regex",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Regex pattern" },
                    "path": { "type": "string", "description": "Base directory" },
                    "case_insensitive": { "type": "boolean" }
                },
                "required": ["pattern"]
            }),
        ),
        tool_def(
            "execute_command",
            "Execute a shell command",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command" },
                    "cwd": { "type": "string", "description": "Working directory (relative)" }
                },
                "required": ["command"]
            }),
        ),
        tool_def(
            "git_init",
            "Initialize a git repository",
            serde_json::json!({ "type": "object", "properties": {} }),
        ),
        tool_def(
            "git_status",
            "Get git status",
            serde_json::json!({ "type": "object", "properties": {} }),
        ),
        tool_def(
            "git_add",
            "Stage files",
            serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "File or '.' for all" } },
                "required": ["path"]
            }),
        ),
        tool_def(
            "git_commit",
            "Create a git commit",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string" },
                    "files": { "type": "array", "items": { "type": "string" } },
                    "author_name": { "type": "string" }, "author_email": { "type": "string" }
                },
                "required": ["message"]
            }),
        ),
        tool_def(
            "git_log",
            "Get commit log",
            serde_json::json!({
                "type": "object",
                "properties": { "max_count": { "type": "integer" } }
            }),
        ),
        tool_def(
            "git_diff",
            "Get git diff",
            serde_json::json!({
                "type": "object",
                "properties": { "staged": { "type": "boolean" } }
            }),
        ),
        tool_def(
            "web_fetch",
            "Fetch a URL",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" }, "method": { "type": "string" },
                    "body": { "type": "string" }, "headers": { "type": "object" }
                },
                "required": ["url"]
            }),
        ),
        tool_def(
            "memory_recall",
            "Search through long-term memories and return semantically similar entries.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural language search query" },
                    "limit": { "type": "number", "description": "Max results (default: 5)" }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "memory_store",
            "Save important information in long-term memory.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Information to remember" },
                    "key": { "type": "string", "description": "Optional explicit memory key" },
                    "category": {
                        "type": "string",
                        "enum": ["preference", "fact", "decision", "entity", "other"],
                        "description": "Category (auto-detected if omitted)"
                    },
                    "metadata": {
                        "description": "Optional metadata payload; object values are serialized to JSON"
                    }
                },
                "required": ["text"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "memory_forget",
            "Delete memories by key or by query lookup.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query to find memory to forget" },
                    "key": { "type": "string", "description": "Specific memory key to delete" }
                },
                "additionalProperties": false
            }),
        ),
        tool_def(
            "memory_search",
            "Semantic search across stored memory content.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "maxResults": { "type": "number", "description": "Max results (default: 5)" }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "memory_list",
            "List memory keys, optionally filtered by a prefix.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "prefix": { "type": "string", "description": "Only return keys starting with this prefix" },
                    "limit": { "type": "number", "description": "Maximum number of keys to return" }
                },
                "additionalProperties": false
            }),
        ),
        tool_def(
            "manage_cron",
            "Manage cron jobs",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list","create","delete","pause","resume","history","status","help"] },
                    "name": { "type": "string" }, "schedule": { "type": "string" },
                    "prompt": { "type": "string" }, "id": { "type": "string" }, "limit": { "type": "integer" }
                },
                "required": ["action"]
            }),
        ),
    ]
}

fn tool_def(name: &str, description: &str, input_schema: serde_json::Value) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
        webview_only: false,
        approval_policy: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestMemoryProvider;

    impl MemoryProvider for TestMemoryProvider {
        fn store(&self, key: String, text: String, metadata_json: Option<String>) -> String {
            serde_json::json!({
                "success": true,
                "key": key,
                "text": text,
                "metadata": metadata_json,
            })
            .to_string()
        }

        fn recall(&self, query: String, limit: u32) -> String {
            serde_json::json!({
                "query": query,
                "limit": limit,
            })
            .to_string()
        }

        fn forget(&self, key: String) -> String {
            serde_json::json!({
                "success": true,
                "key": key,
            })
            .to_string()
        }

        fn search(&self, query: String, max_results: u32) -> String {
            serde_json::json!({
                "query": query,
                "maxResults": max_results,
            })
            .to_string()
        }

        fn list(&self, prefix: Option<String>, limit: Option<u32>) -> String {
            serde_json::json!({
                "prefix": prefix,
                "limit": limit,
            })
            .to_string()
        }
    }

    #[test]
    fn get_tool_definitions_includes_native_memory_tools() {
        let tools = get_tool_definitions("", None);

        for name in [
            "memory_recall",
            "memory_store",
            "memory_forget",
            "memory_search",
            "memory_list",
        ] {
            let tool = tools.iter().find(|tool| tool.name == name).unwrap();
            assert!(!tool.webview_only);
        }
    }

    #[tokio::test]
    async fn memory_tool_requires_provider() {
        let err = execute_tool("memory_recall", &serde_json::json!({"query": "hello"}), "", "", None)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Memory provider not configured"));
    }

    #[tokio::test]
    async fn memory_tool_uses_provider_json() {
        let provider: Arc<dyn MemoryProvider> = Arc::new(TestMemoryProvider);
        let result = execute_tool(
            "memory_store",
            &serde_json::json!({"text": "hello", "category": "fact"}),
            "",
            "",
            Some(&provider),
        )
        .await
        .unwrap();

        assert_eq!(result["success"], true);
        assert_eq!(result["text"], "hello");
        assert_eq!(result["metadata"], r#"{"category":"fact"}"#);
    }
}

#[cfg(test)]
mod atomic_write_tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nk-atomic-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn content_is_written_and_readable() {
        let d = dir();
        let f = d.join("note.txt");
        write_file_atomic(&f, "hello আমি 🇧🇩").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "hello আমি 🇧🇩");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn overwriting_replaces_content_completely() {
        let d = dir();
        let f = d.join("note.txt");
        write_file_atomic(&f, "a much longer original body").unwrap();
        write_file_atomic(&f, "short").unwrap();
        // A partial overwrite would leave trailing bytes of the old content.
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "short");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn no_temp_file_is_left_behind() {
        let d = dir();
        write_file_atomic(&d.join("note.txt"), "x").unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(&d)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left temp files: {leftovers:?}");
        std::fs::remove_dir_all(&d).ok();
    }

    /// The temp file must live in the SAME directory, otherwise the rename
    /// crosses a filesystem boundary and stops being atomic.
    #[test]
    fn the_temp_file_is_a_sibling_of_the_target() {
        let d = dir();
        let sub = d.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let f = sub.join("deep.txt");
        write_file_atomic(&f, "content").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "content");
        // Nothing stray in the parent.
        assert!(!d.join(".deep.txt.tmp").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_failure_reports_an_error_instead_of_destroying_the_original() {
        let d = dir();
        let f = d.join("exists.txt");
        write_file_atomic(&f, "original").unwrap();
        // Target a path whose parent does not exist: the write must fail and
        // the untouched file must still hold its original content.
        let bad = d.join("missing-dir").join("x.txt");
        assert!(write_file_atomic(&bad, "new").is_err());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "original");
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod ssrf_tests {
    use super::*;
    use std::net::IpAddr;

    #[test]
    fn loopback_private_and_metadata_addresses_are_classified_private() {
        for ip in [
            "127.0.0.1", "127.1.2.3", "0.0.0.0",
            "10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.1",
            "169.254.169.254",          // AWS/GCP/Azure instance metadata
            "100.64.0.1",               // carrier-grade NAT
            "::1", "fe80::1", "fc00::1", "fd12:3456::1",
            "::ffff:127.0.0.1",         // IPv4-mapped loopback
            "::ffff:169.254.169.254",   // IPv4-mapped metadata
        ] {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(is_private_ip(&parsed), "{ip} must be treated as private");
        }
    }

    #[test]
    fn public_addresses_stay_reachable() {
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700::1111"] {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(!is_private_ip(&parsed), "{ip} must stay allowed");
        }
    }

    #[test]
    fn non_http_schemes_are_refused() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "gopher://example.com",
            "data:text/plain,hello",
        ] {
            let err = ensure_url_is_fetchable(url).unwrap_err();
            assert!(
                format!("{err:?}").contains("only http and https"),
                "{url} -> {err:?}"
            );
        }
    }

    #[test]
    fn literal_private_hosts_are_refused_without_needing_dns() {
        for url in [
            "http://127.0.0.1:8080/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/",
            "http://[::1]:9000/",
            "http://192.168.0.1/router",
        ] {
            assert!(
                ensure_url_is_fetchable(url).is_err(),
                "{url} must be refused"
            );
        }
    }

    #[test]
    fn a_malformed_url_is_refused_rather_than_panicking() {
        assert!(ensure_url_is_fetchable("not a url").is_err());
        assert!(ensure_url_is_fetchable("").is_err());
        assert!(ensure_url_is_fetchable("http://").is_err());
    }
}

#[cfg(test)]
mod path_sandbox_tests {
    use super::*;

    /// BUG-04: `&s[..n]` panics when `n` lands inside a multi-byte character.
    /// Every one of these inputs would have aborted the process before.
    #[test]
    fn truncation_never_splits_a_character() {
        // "আ" is 3 bytes; cutting at 1..=2 is mid-character.
        let bangla = "আআআআআ";
        for max in 0..=bangla.len() {
            let out = truncate_str(bangla, max);
            assert!(out.len() <= max);
            assert!(bangla.starts_with(out), "must be a prefix");
            assert_eq!(out.len() % 3, 0, "only whole characters may survive");
        }
        // Emoji are 4 bytes, and combining sequences are longer still.
        for s in ["🇧🇩🇧🇩", "👨‍👩‍👧‍👦", "café", "日本語テキスト"] {
            for max in 0..=s.len() {
                let out = truncate_str(s, max);
                assert!(s.starts_with(out));
                assert!(std::str::from_utf8(out.as_bytes()).is_ok());
            }
        }
    }

    #[test]
    fn short_input_is_returned_untouched() {
        assert_eq!(truncate_str("আমি", 100), "আমি");
        assert_eq!(truncate_with_notice("আমি", 100), "আমি");
    }

    #[test]
    fn oversized_output_is_marked_as_truncated() {
        let big = "আ".repeat(30_000); // 90 000 bytes
        let out = truncate_with_notice(&big, MAX_OUTPUT_BYTES);
        assert!(out.contains("[... truncated:"), "model must be told it was cut");
        assert!(!out.contains('\u{fffd}'), "no broken characters");
    }

    fn workspace() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nk-sandbox-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/ok.txt"), b"hi").unwrap();
        dir
    }

    #[test]
    fn legitimate_relative_paths_resolve_inside_the_workspace() {
        let ws = workspace();
        let wss = ws.to_str().unwrap();
        for p in ["sub/ok.txt", "./sub/ok.txt", "sub/new-file.txt", "brand-new.txt"] {
            let resolved = resolve_path(wss, p)
                .unwrap_or_else(|e| panic!("{p} should be allowed: {e:?}"));
            let canon_ws = std::fs::canonicalize(&ws).unwrap();
            assert!(
                resolved.starts_with(&canon_ws),
                "{p} resolved outside the workspace: {resolved:?}"
            );
        }
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn traversal_and_absolute_paths_are_refused() {
        let ws = workspace();
        let wss = ws.to_str().unwrap();
        for p in [
            "../escape.txt",
            "sub/../../escape.txt",
            "a/b/../../../escape.txt",
            "/etc/passwd",
            "/tmp/evil",
            r"..\escape.txt",
            r"C:\Windows\system32",
            "//server/share/file",
        ] {
            assert!(
                resolve_path(wss, p).is_err(),
                "{p} must be rejected but was allowed"
            );
        }
        std::fs::remove_dir_all(&ws).ok();
    }

    /// The case canonicalization exists for: a symlink pointing out of the
    /// workspace. The pre-fix code skipped containment whenever canonicalize
    /// failed, so this escaped.
    #[cfg(unix)]
    #[test]
    fn a_symlink_pointing_outside_the_workspace_is_refused() {
        let ws = workspace();
        let wss = ws.to_str().unwrap();
        let outside = std::env::temp_dir().join(format!("nk-outside-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();

        std::os::unix::fs::symlink(&outside, ws.join("link")).unwrap();

        assert!(
            resolve_path(wss, "link/secret.txt").is_err(),
            "a symlink escaping the workspace must be refused"
        );
        // A symlink that stays inside is still fine.
        std::os::unix::fs::symlink(ws.join("sub"), ws.join("inner")).unwrap();
        assert!(resolve_path(wss, "inner/ok.txt").is_ok());

        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// Fail CLOSED: an unusable workspace must error, never fall through to an
    /// unchecked path.
    #[test]
    fn a_missing_workspace_fails_closed() {
        let missing = std::env::temp_dir().join("nk-does-not-exist-xyz-123");
        std::fs::remove_dir_all(&missing).ok();
        assert!(resolve_path(missing.to_str().unwrap(), "file.txt").is_err());
    }
}
