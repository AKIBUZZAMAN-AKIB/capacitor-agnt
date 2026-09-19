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

static SKIP_DIRS: &[&str] = &[".git", ".openclaw", "node_modules"];

// ── Path safety ─────────────────────────────────────────────────────────────

fn resolve_path(workspace: &str, relative: &str) -> Result<PathBuf, NativeAgentError> {
    let clean = relative.replace('\\', "/");
    let clean = clean.trim_start_matches('/');

    // Block traversal
    for part in clean.split('/') {
        if part == ".." {
            return Err(NativeAgentError::Tool {
                msg: "Access denied: path traversal (..) not allowed".into(),
            });
        }
    }

    let full = PathBuf::from(workspace).join(clean);

    // Ensure it's still under workspace after canonicalization
    if let (Ok(canon_ws), Ok(canon_full)) = (
        std::fs::canonicalize(workspace),
        std::fs::canonicalize(&full).or_else(|_| {
            // File may not exist yet (write_file) — canonicalize parent
            if let Some(parent) = full.parent() {
                std::fs::canonicalize(parent).map(|p| p.join(full.file_name().unwrap_or_default()))
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no parent",
                ))
            }
        }),
    ) {
        if !canon_full.starts_with(&canon_ws) {
            return Err(NativeAgentError::Tool {
                msg: "Access denied: path outside workspace".into(),
            });
        }
    }

    Ok(full)
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
        "manage_cron" => tool_manage_cron(args, workspace),
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
    match std::fs::write(&path, content) {
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
        std::fs::write(&path, new_content)?;
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
                let trunc = if line.len() > 500 { &line[..500] } else { line };
                matches.push(serde_json::json!({ "file": rel.to_string_lossy(), "line": i + 1, "content": trunc }));
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

    let output = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(&work_dir)
        .output()
        .await
        .map_err(|e| NativeAgentError::Tool {
            msg: format!("Command failed: {}", e),
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let max_len = 50_000;
    ok_json(serde_json::json!({
        "exitCode": output.status.code().unwrap_or(-1),
        "stdout": if stdout.len() > max_len { &stdout[..max_len] } else { &stdout },
        "stderr": if stderr.len() > max_len { &stderr[..max_len] } else { &stderr },
    }))
}

// ── Git tools ────────────────────────────────────────────────────────────

// When compiled with the "libgit2" feature (default, used on Android/macOS),
// git operations use libgit2 in-process. On iOS (built with --no-default-features),
// libgit2 is excluded because its vendored C code references ___chkstk_darwin
// (macOS-only stack probe, absent from the iOS SDK). In that case we shell out
// to the git CLI, which is available on iOS via the app sandbox.

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

// ── Git tools (stub for iOS — no libgit2, no CLI) ───────────────────────
//
// On iOS, libgit2 is excluded (___chkstk_darwin) and spawning child processes
// from within the app sandbox hangs indefinitely. Return a clear error so the
// agent can use isomorphic-git (JS) or skip git operations.

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

async fn tool_web_fetch(args: &serde_json::Value) -> Result<serde_json::Value, NativeAgentError> {
    let url = args["url"].as_str().unwrap_or("");
    let method = args["method"].as_str().unwrap_or("GET").to_uppercase();
    let client = reqwest::Client::new();

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
            let trunc = if body.len() > 50_000 {
                &body[..50_000]
            } else {
                &body
            };
            ok_json(serde_json::json!({ "status": status, "body": trunc }))
        }
        Err(e) => ok_json(serde_json::json!({ "error": format!("Fetch failed: {}", e) })),
    }
}

// ── Cron management ─────────────────────────────────────────────────────────

fn tool_manage_cron(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let action = args["action"].as_str().unwrap_or("help");
    let db_path = Path::new(workspace)
        .parent()
        .unwrap_or(Path::new(workspace))
        .join("mobile-claw.db");

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;

    match action {
        "list" => {
            let mut stmt = conn.prepare(
                "SELECT id, name, prompt, schedule, status, last_run_at, run_count FROM cron_jobs ORDER BY name"
            ).map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;
            let jobs: Vec<serde_json::Value> = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
                    "prompt": row.get::<_, String>(2)?, "schedule": row.get::<_, String>(3)?,
                    "status": row.get::<_, String>(4)?, "lastRunAt": row.get::<_, Option<String>>(5)?,
                    "runCount": row.get::<_, i64>(6)?,
                }))
            }).map_err(|e| NativeAgentError::Database { msg: e.to_string() })?
            .filter_map(|r| r.ok()).collect();
            ok_json(serde_json::json!({ "jobs": jobs }))
        }
        "create" => {
            let name = args["name"].as_str().unwrap_or("unnamed");
            let schedule = args["schedule"].as_str().unwrap_or("0 * * * *");
            let prompt = args["prompt"].as_str().unwrap_or("");
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO cron_jobs (id, name, prompt, schedule, status, run_count) VALUES (?, ?, ?, ?, 'active', 0)",
                rusqlite::params![id, name, prompt, schedule],
            ).map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;
            ok_json(serde_json::json!({ "success": true, "id": id, "name": name }))
        }
        "delete" => {
            let id = args["id"].as_str().unwrap_or("");
            conn.execute("DELETE FROM cron_jobs WHERE id = ?", rusqlite::params![id])
                .map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;
            ok_json(serde_json::json!({ "success": true, "id": id }))
        }
        "pause" => {
            let id = args["id"].as_str().unwrap_or("");
            conn.execute(
                "UPDATE cron_jobs SET status = 'paused' WHERE id = ?",
                rusqlite::params![id],
            )
            .map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;
            ok_json(serde_json::json!({ "success": true, "status": "paused" }))
        }
        "resume" => {
            let id = args["id"].as_str().unwrap_or("");
            conn.execute(
                "UPDATE cron_jobs SET status = 'active' WHERE id = ?",
                rusqlite::params![id],
            )
            .map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;
            ok_json(serde_json::json!({ "success": true, "status": "active" }))
        }
        "history" => {
            let limit = args["limit"].as_u64().unwrap_or(20);
            let query = if let Some(jid) = args["id"].as_str() {
                format!("SELECT id, job_id, started_at, completed_at, error FROM cron_runs WHERE job_id = '{}' ORDER BY started_at DESC LIMIT {}", jid, limit)
            } else {
                format!("SELECT id, job_id, started_at, completed_at, error FROM cron_runs ORDER BY started_at DESC LIMIT {}", limit)
            };
            let mut stmt = conn
                .prepare(&query)
                .map_err(|e| NativeAgentError::Database { msg: e.to_string() })?;
            let runs: Vec<serde_json::Value> = stmt.query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?, "jobId": row.get::<_, String>(1)?,
                    "startedAt": row.get::<_, String>(2)?, "completedAt": row.get::<_, Option<String>>(3)?,
                    "error": row.get::<_, Option<String>>(4)?,
                }))
            }).map_err(|e| NativeAgentError::Database { msg: e.to_string() })?
            .filter_map(|r| r.ok()).collect();
            ok_json(serde_json::json!({ "runs": runs }))
        }
        "status" => {
            ok_json(serde_json::json!({ "message": "Cron system active. Use 'list' to see jobs." }))
        }
        _ => ok_json(
            serde_json::json!({ "message": "Actions: list, create, delete, pause, resume, history, status" }),
        ),
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
        let err = execute_tool("memory_recall", &serde_json::json!({"query": "hello"}), "", None)
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
            Some(&provider),
        )
        .await
        .unwrap();

        assert_eq!(result["success"], true);
        assert_eq!(result["text"], "hello");
        assert_eq!(result["metadata"], r#"{"category":"fact"}"#);
    }
}
