//! Tool runner — ALL tools execute natively in Rust.
//!
//! No WebView, no Capacitor bridge. Everything runs in-process so the agent
//! can operate while the app is backgrounded and the WebView is suspended.
//!
//! Tools: file I/O, git (libgit2), shell commands, content search, web fetch,
//! cron management, and edit_file (search-replace).

use crate::types::ToolDefinition;
use crate::{MemoryProvider, NativeAgentError};
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_MATCHES: usize = 100;
const MAX_GREP_MATCHES: usize = 50;
const MAX_GLOB_PATTERN_BYTES: usize = 1_024;
const MAX_REGEX_BYTES: usize = 4_096;
const MAX_MEMORY_QUERY_BYTES: usize = 8_192;
const MAX_MEMORY_TEXT_BYTES: usize = 20_000;
const MAX_MEMORY_KEY_BYTES: usize = 512;
const MAX_MEMORY_METADATA_BYTES: usize = 16_384;
const MAX_MEMORY_PROVIDER_RESPONSE_BYTES: usize = 512_000;
const MAX_SCAN_ENTRIES: usize = 50_000;
const MAX_SEARCH_DEPTH: usize = 64;
const MAX_FILE_SIZE: u64 = 10_000_000; // 10 MB per file
const MAX_GREP_TOTAL_BYTES: u64 = 50_000_000; // total UTF-8 file content scanned per grep call
/// Hard cap on captured process / HTTP output, in bytes.
const MAX_OUTPUT_BYTES: usize = 50_000;
const MAX_DIFF_BYTES: usize = 30_000;
const MAX_DIFF_FILES: usize = 50;
const MAX_DIFF_PATCH_BYTES: usize = 5_000;
const MAX_HTTP_REQUEST_BODY_BYTES: usize = 1_000_000;
const MAX_HTTP_URL_BYTES: usize = 8_192;
const MAX_HTTP_HEADERS: usize = 64;
const MAX_HTTP_HEADER_NAME_BYTES: usize = 256;
const MAX_HTTP_HEADER_VALUE_BYTES: usize = 8_192;
const MAX_COMMAND_BYTES: usize = 100_000;
const MAX_PATH_ARGUMENT_BYTES: usize = 4_096;
const MAX_GIT_COMMIT_MESSAGE_BYTES: usize = 10_000;
const MAX_GIT_IDENTITY_BYTES: usize = 512;
const MAX_CRON_NAME_BYTES: usize = 200;
const MAX_CRON_PROMPT_BYTES: usize = 50_000;
const MAX_CRON_SCHEDULE_BYTES: usize = 4_096;
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
    if relative.len() > MAX_PATH_ARGUMENT_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Path exceeds the {} byte limit", MAX_PATH_ARGUMENT_BYTES),
        });
    }
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
    // Do not advertise operations that the host OS cannot perform. The
    // dispatch implementation still returns an explicit unsupported result if
    // a model or caller fabricates the tool call on iOS.
    let all: Vec<ToolDefinition> = all_tool_definitions()
        .into_iter()
        .filter(|tool| {
            #[cfg(target_os = "ios")]
            {
                tool.name != "execute_command"
            }
            #[cfg(not(target_os = "ios"))]
            {
                let _ = tool;
                true
            }
        })
        .collect();
    match allowed_json {
        // `None` means unrestricted. An explicit empty array means no tools.
        // Invalid JSON fails closed rather than silently exposing every tool.
        None => all,
        Some(json) => match serde_json::from_str::<Vec<String>>(json) {
            Ok(names) => all
                .into_iter()
                .filter(|tool| names.contains(&tool.name))
                .collect(),
            Err(_) => Vec::new(),
        },
    }
}

/// Every tool the engine executes natively.
///
/// Single source of truth: `is_builtin_tool` and `builtin_tool_names` both read
/// this, so the membership test and the human-readable list can never drift
/// apart the way a duplicated `matches!` arm and a duplicated array would.
pub const BUILTIN_TOOL_NAMES: [&str; 21] = [
    "read_file",
    "write_file",
    "edit_file",
    "delete_file",
    "list_files",
    "find_files",
    "grep_files",
    "execute_command",
    "git_init",
    "git_status",
    "git_add",
    "git_commit",
    "git_log",
    "git_diff",
    "web_fetch",
    "manage_cron",
    "memory_recall",
    "memory_store",
    "memory_forget",
    "memory_search",
    "memory_list",
];

pub fn is_builtin_tool(name: &str) -> bool {
    BUILTIN_TOOL_NAMES.contains(&name)
}

/// The builtin names, for error messages that tell the model what it may call.
pub fn builtin_tool_names() -> &'static [&'static str] {
    &BUILTIN_TOOL_NAMES
}

fn validate_tool_arguments(name: &str, args: &serde_json::Value) -> Result<(), NativeAgentError> {
    let definition = all_tool_definitions()
        .into_iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| NativeAgentError::Tool { msg: format!("Unknown tool: {}", name) })?;
    validate_schema_value(name, "$", args, &definition.input_schema)
}

/// Validate the JSON Schema subset used by native tool definitions. This is
/// deliberately recursive: checking only the root object lets malformed nested
/// schedule/header/array values slip through despite their published schema.
fn validate_schema_value(
    tool_name: &str,
    path: &str,
    value: &serde_json::Value,
    schema: &serde_json::Value,
) -> Result<(), NativeAgentError> {
    let invalid = |message: String| NativeAgentError::Tool { msg: message };

    if let Some(kind) = schema.get("type").and_then(serde_json::Value::as_str) {
        let valid = match kind {
            "string" => value.is_string(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            _ => true,
        };
        if !valid {
            return Err(invalid(format!("Argument '{}' for '{}' must be {}", path, tool_name, kind)));
        }
    }

    if let Some(string) = value.as_str() {
        let character_count = string.chars().count();
        if schema
            .get("minLength")
            .and_then(serde_json::Value::as_u64)
            .map(|minimum| character_count < usize::try_from(minimum).unwrap_or(usize::MAX))
            .unwrap_or(false)
            || schema
                .get("maxLength")
                .and_then(serde_json::Value::as_u64)
                .map(|maximum| character_count > usize::try_from(maximum).unwrap_or(usize::MAX))
                .unwrap_or(false)
        {
            return Err(invalid(format!("Argument '{}' for '{}' has an invalid string length", path, tool_name)));
        }
    }

    if let Some(choices) = schema.get("enum").and_then(serde_json::Value::as_array) {
        if !choices.contains(value) {
            return Err(invalid(format!("Argument '{}' for '{}' has an unsupported value", path, tool_name)));
        }
    }

    let minimum = schema.get("minimum").and_then(serde_json::Value::as_f64);
    let maximum = schema.get("maximum").and_then(serde_json::Value::as_f64);
    if minimum.is_some() || maximum.is_some() {
        let number = value.as_f64().ok_or_else(|| {
            invalid(format!("Argument '{}' for '{}' must be numeric", path, tool_name))
        })?;
        if minimum.map(|minimum| number < minimum).unwrap_or(false)
            || maximum.map(|maximum| number > maximum).unwrap_or(false)
        {
            return Err(invalid(format!("Argument '{}' for '{}' is outside its allowed range", path, tool_name)));
        }
    }

    if let Some(array) = value.as_array() {
        if schema
            .get("minItems")
            .and_then(serde_json::Value::as_u64)
            .map(|minimum| array.len() < usize::try_from(minimum).unwrap_or(usize::MAX))
            .unwrap_or(false)
            || schema
                .get("maxItems")
                .and_then(serde_json::Value::as_u64)
                .map(|maximum| array.len() > usize::try_from(maximum).unwrap_or(usize::MAX))
                .unwrap_or(false)
        {
            return Err(invalid(format!("Argument '{}' for '{}' has an invalid array length", path, tool_name)));
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in array.iter().enumerate() {
                validate_schema_value(tool_name, &format!("{}[{}]", path, index), item, item_schema)?;
            }
        }
    }

    if let Some(object) = value.as_object() {
        if schema
            .get("maxProperties")
            .and_then(serde_json::Value::as_u64)
            .map(|maximum| object.len() > usize::try_from(maximum).unwrap_or(usize::MAX))
            .unwrap_or(false)
        {
            return Err(invalid(format!("Argument '{}' for '{}' has too many properties", path, tool_name)));
        }

        let properties = schema.get("properties").and_then(serde_json::Value::as_object);
        if let Some(required) = schema.get("required").and_then(serde_json::Value::as_array) {
            for field in required.iter().filter_map(serde_json::Value::as_str) {
                if object.get(field).map(serde_json::Value::is_null).unwrap_or(true) {
                    return Err(invalid(format!("Missing required argument '{}.{}' for '{}'", path, field, tool_name)));
                }
            }
        }

        for (field, child) in object {
            let child_path = format!("{}.{}", path, field);
            if let Some(property_schema) = properties.and_then(|properties| properties.get(field)) {
                validate_schema_value(tool_name, &child_path, child, property_schema)?;
                continue;
            }
            match schema.get("additionalProperties") {
                Some(serde_json::Value::Bool(false)) => {
                    return Err(invalid(format!("Unexpected argument '{}' for '{}'", child_path, tool_name)));
                }
                Some(additional_schema @ serde_json::Value::Object(_)) => {
                    validate_schema_value(tool_name, &child_path, child, additional_schema)?;
                }
                _ => {}
            }
        }
    }

    Ok(())
}

pub async fn execute_tool(
    name: &str,
    args: &serde_json::Value,
    workspace: &str,
    db_path: &str,
    memory_provider: Option<&Arc<dyn MemoryProvider>>,
) -> Result<serde_json::Value, NativeAgentError> {
    validate_tool_arguments(name, args)?;
    match name {
        "read_file" => tool_read_file(args, workspace),
        "write_file" => tool_write_file(args, workspace),
        "edit_file" => tool_edit_file(args, workspace),
        "delete_file" => tool_delete_file(args, workspace),
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

    validate_memory_tool_sizes(name, args)?;

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
            args["limit"].as_u64().unwrap_or(5).clamp(1, 10) as u32,
        ),
        "memory_store" => provider.store(
            args["key"].as_str().unwrap_or("").to_string(),
            args["text"].as_str().unwrap_or("").to_string(),
            metadata_json,
        ),
        "memory_forget" => {
            let key = args["key"].as_str().unwrap_or("").to_string();
            if key.trim().is_empty() {
                let query = args["query"].as_str().unwrap_or("").to_string();
                if query.trim().is_empty() {
                    return Ok(serde_json::json!({ "error": "Provide query or key." }));
                }

                let (matches, provider_truncated) = parse_memory_search_results(&provider.search(query, 5))?;
                if matches.is_empty() {
                    return Ok(serde_json::json!({ "message": "No matching memories found." }));
                }
                let (matches, capped) = cap_memory_results(matches, 5)?;
                return Ok(serde_json::json!({
                    "action": "candidates",
                    "candidates": matches,
                    "truncated": provider_truncated || capped,
                    "message": "Matches are only candidates; no data was deleted. Pass an exact key to delete a memory."
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
                .unwrap_or(5)
                .clamp(1, 10) as u32,
        ),
        "memory_list" => provider.list(
            args.get("prefix")
                .and_then(|value| value.as_str())
                .map(String::from),
            args.get("limit")
                .and_then(|value| value.as_u64())
                .map(|value| value.clamp(1, 50) as u32)
                .or(Some(50)),
        ),
        _ => unreachable!(),
    };

    if matches!(name, "memory_recall" | "memory_search") {
        let (results, provider_truncated) = parse_memory_search_results(&result_json)?;
        let (results, capped) = cap_memory_results(results, 10)?;
        ok_json(serde_json::json!({ "results": results, "truncated": provider_truncated || capped }))
    } else if name == "memory_list" {
        let limit = args["limit"].as_u64().unwrap_or(50).clamp(1, 50) as usize;
        parse_memory_list_result(&result_json, limit)
    } else {
        parse_memory_operation_result(name, &result_json)
    }
}

fn validate_memory_tool_sizes(name: &str, args: &serde_json::Value) -> Result<(), NativeAgentError> {
    let limits: &[(&str, usize)] = match name {
        "memory_recall" | "memory_search" => &[("query", MAX_MEMORY_QUERY_BYTES)],
        "memory_store" => &[
            ("text", MAX_MEMORY_TEXT_BYTES),
            ("key", MAX_MEMORY_KEY_BYTES),
        ],
        "memory_forget" => &[
            ("query", MAX_MEMORY_QUERY_BYTES),
            ("key", MAX_MEMORY_KEY_BYTES),
        ],
        "memory_list" => &[("prefix", MAX_MEMORY_KEY_BYTES)],
        _ => &[],
    };
    for (field, limit) in limits {
        if args
            .get(*field)
            .and_then(serde_json::Value::as_str)
            .map(|value| value.len() > *limit)
            .unwrap_or(false)
        {
            return Err(NativeAgentError::Tool {
                msg: format!("Argument '{}' for '{}' exceeds the {} UTF-8 byte limit", field, name, limit),
            });
        }
    }
    if let Some(metadata) = args.get("metadata") {
        if metadata.to_string().len() > MAX_MEMORY_METADATA_BYTES {
            return Err(NativeAgentError::Tool {
                msg: format!("Argument 'metadata' for '{}' exceeds the {} byte limit", name, MAX_MEMORY_METADATA_BYTES),
            });
        }
    }
    Ok(())
}

fn parse_memory_json(result_json: &str) -> Result<serde_json::Value, NativeAgentError> {
    if result_json.len() > MAX_MEMORY_PROVIDER_RESPONSE_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Memory provider response exceeds the {} byte limit", MAX_MEMORY_PROVIDER_RESPONSE_BYTES),
        });
    }
    serde_json::from_str(result_json).map_err(|e| NativeAgentError::Tool {
        msg: format!("Memory provider returned invalid JSON: {}", e),
    })
}

fn parse_memory_search_results(
    result_json: &str,
) -> Result<(Vec<serde_json::Value>, bool), NativeAgentError> {
    let value = parse_memory_json(result_json)?;
    match value {
        serde_json::Value::Array(items) => Ok((items, false)),
        serde_json::Value::Object(mut object) => {
            let truncated = object
                .remove("truncated")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            match object.remove("results") {
                Some(serde_json::Value::Array(items)) => Ok((items, truncated)),
                _ => Err(NativeAgentError::Tool {
                    msg: "Memory provider search returned an unexpected JSON shape".into(),
                }),
            }
        }
        _ => Err(NativeAgentError::Tool {
            msg: "Memory provider search returned an unexpected JSON shape".into(),
        }),
    }
}

fn sanitize_memory_provider_error(
    value: &serde_json::Value,
) -> Result<Option<serde_json::Value>, NativeAgentError> {
    let Some(raw_error) = value.get("error") else {
        return Ok(None);
    };
    let error = raw_error
        .as_str()
        .filter(|error| !error.trim().is_empty())
        .ok_or_else(|| NativeAgentError::Tool {
            msg: "Memory provider returned an invalid error field".into(),
        })?;
    let truncated = error.len() > 1_000;
    let mut result = serde_json::json!({ "error": truncate_str(error, 1_000) });
    if truncated {
        result["errorTruncated"] = serde_json::json!(true);
    }
    Ok(Some(result))
}

fn parse_memory_operation_result(
    operation: &str,
    result_json: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let value = parse_memory_json(result_json)?;
    if let Some(error) = sanitize_memory_provider_error(&value)? {
        return ok_json(error);
    }
    let Some(object) = value.as_object() else {
        return Err(NativeAgentError::Tool {
            msg: format!("Memory provider {} returned an unexpected JSON shape", operation),
        });
    };
    let success = object
        .get("success")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| NativeAgentError::Tool {
            msg: format!("Memory provider {} result is missing a boolean success field", operation),
        })?;
    let mut result = serde_json::Map::new();
    result.insert("success".into(), serde_json::json!(success));

    if let Some(raw_key) = object.get("key") {
        let key = raw_key.as_str().filter(|key| !key.trim().is_empty()).ok_or_else(|| {
            NativeAgentError::Tool { msg: "Memory provider returned an invalid key".into() }
        })?;
        if key.len() > MAX_MEMORY_KEY_BYTES {
            return Err(NativeAgentError::Tool {
                msg: "Memory provider returned a key that exceeds the 512 byte limit".into(),
            });
        }
        result.insert("key".into(), serde_json::json!(key));
    }
    if let Some(raw_text) = object.get("text") {
        let text = raw_text.as_str().ok_or_else(|| NativeAgentError::Tool {
            msg: "Memory provider returned a non-string text field".into(),
        })?;
        if text.len() > 2_000 {
            result.insert("text".into(), serde_json::json!(truncate_str(text, 2_000)));
            result.insert("textTruncated".into(), serde_json::json!(true));
        } else {
            result.insert("text".into(), serde_json::json!(text));
        }
    }
    if let Some(metadata) = object.get("metadata") {
        if metadata.to_string().len() > 1_000 {
            result.insert("metadata".into(), serde_json::json!({ "truncated": true }));
            result.insert("metadataTruncated".into(), serde_json::json!(true));
        } else {
            result.insert("metadata".into(), metadata.clone());
        }
    }
    ok_json(serde_json::Value::Object(result))
}

fn parse_memory_list_result(
    result_json: &str,
    max_keys: usize,
) -> Result<serde_json::Value, NativeAgentError> {
    let value = parse_memory_json(result_json)?;
    if let Some(error) = sanitize_memory_provider_error(&value)? {
        return ok_json(error);
    }
    let serde_json::Value::Array(keys) = value else {
        return Err(NativeAgentError::Tool {
            msg: "Memory provider list returned an unexpected JSON shape".into(),
        });
    };
    if keys.len() > max_keys {
        return Err(NativeAgentError::Tool {
            msg: format!("Memory provider returned more than the requested {} keys", max_keys),
        });
    }
    for key in &keys {
        let Some(key) = key.as_str().filter(|key| !key.trim().is_empty()) else {
            return Err(NativeAgentError::Tool {
                msg: "Memory provider list returned a non-string or empty key".into(),
            });
        };
        if key.len() > MAX_MEMORY_KEY_BYTES {
            return Err(NativeAgentError::Tool {
                msg: "Memory provider list returned a key that exceeds the 512 byte limit".into(),
            });
        }
    }
    ok_json(serde_json::Value::Array(keys))
}

fn cap_memory_results(
    mut items: Vec<serde_json::Value>,
    max_items: usize,
) -> Result<(Vec<serde_json::Value>, bool), NativeAgentError> {
    let mut truncated = items.len() > max_items;
    items.truncate(max_items);
    for item in &mut items {
        let Some(original) = item.as_object() else {
            return Err(NativeAgentError::Tool {
                msg: "Memory provider returned a non-object search result".into(),
            });
        };
        let key = original
            .get("key")
            .and_then(serde_json::Value::as_str)
            .filter(|key| !key.trim().is_empty())
            .ok_or_else(|| NativeAgentError::Tool {
                msg: "Memory provider search result is missing a non-empty key".into(),
            })?;
        if key.len() > MAX_MEMORY_KEY_BYTES {
            return Err(NativeAgentError::Tool {
                msg: "Memory provider returned a key that exceeds the 512 byte limit".into(),
            });
        }
        // Provider-owned custom fields are intentionally omitted: the stable
        // tool contract is key/text/score/metadata, and arbitrary extras could
        // defeat the response-size bound or leak unrelated host data. Keys are
        // rejected, never truncated, so an exact-key deletion cannot target a
        // different memory after lossy identifier normalization.
        let mut safe = serde_json::Map::new();
        safe.insert("key".into(), serde_json::json!(key));
        if let Some(text) = original.get("text").and_then(serde_json::Value::as_str) {
            if text.len() > 2_000 {
                safe.insert("text".into(), serde_json::json!(truncate_str(text, 2_000)));
                safe.insert("textTruncated".into(), serde_json::json!(true));
                truncated = true;
            } else {
                safe.insert("text".into(), serde_json::json!(text));
            }
        }
        if let Some(score) = original.get("score").filter(|score| score.is_number()) {
            safe.insert("score".into(), score.clone());
        }
        if let Some(metadata) = original.get("metadata") {
            if metadata.to_string().len() > 1_000 {
                safe.insert("metadata".into(), serde_json::json!({ "truncated": true }));
                safe.insert("metadataTruncated".into(), serde_json::json!(true));
                truncated = true;
            } else {
                safe.insert("metadata".into(), metadata.clone());
            }
        }
        *item = serde_json::Value::Object(safe);
    }
    Ok((items, truncated))
}

// ── File tools ──────────────────────────────────────────────────────────────

fn read_file_limited_to(path: &Path, max_bytes: u64) -> io::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("File exceeds the {} byte tool limit", max_bytes),
        ));
    }
    String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn read_file_limited(path: &Path) -> io::Result<String> {
    read_file_limited_to(path, MAX_FILE_SIZE)
}

fn tool_read_file(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or("");
    let path = resolve_path(workspace, rel)?;
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Failed to read file: {}", e) })),
    };
    let metadata = match file.metadata() {
        Ok(meta) => meta,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Failed to read file metadata: {}", e) })),
    };
    let file_bytes = metadata.len();
    let modified_ms = metadata.modified().ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
    if file_bytes > MAX_FILE_SIZE {
        return ok_json(serde_json::json!({
            "error": format!("Failed to read file: File exceeds the {} byte tool limit", MAX_FILE_SIZE)
        }));
    }

    let offset = args["offset_bytes"].as_u64().unwrap_or(0);
    if offset > file_bytes {
        return ok_json(serde_json::json!({ "error": format!("offset_bytes {} exceeds file size {}", offset, file_bytes) }));
    }
    let limit = args["limit_bytes"].as_u64().unwrap_or(MAX_OUTPUT_BYTES as u64)
        .clamp(1, MAX_OUTPUT_BYTES as u64) as usize;

    // `nextOffsetBytes` is always a UTF-8 boundary. Reject arbitrary offsets
    // into the middle of a code point rather than silently skipping bytes.
    if offset < file_bytes {
        if let Err(e) = file.seek(SeekFrom::Start(offset)) {
            return ok_json(serde_json::json!({ "error": format!("Failed to seek in file: {}", e) }));
        }
        let mut first = [0u8; 1];
        if let Err(e) = file.read_exact(&mut first) {
            return ok_json(serde_json::json!({ "error": format!("Failed to read file: {}", e) }));
        }
        if first[0] & 0b1100_0000 == 0b1000_0000 {
            return ok_json(serde_json::json!({ "error": "offset_bytes must be a UTF-8 character boundary" }));
        }
    }
    if let Err(e) = file.seek(SeekFrom::Start(offset)) {
        return ok_json(serde_json::json!({ "error": format!("Failed to seek in file: {}", e) }));
    }
    // Read a few look-ahead bytes so a requested chunk can end on a complete
    // UTF-8 character without loading the whole file on every pagination call.
    let read_limit = limit.saturating_add(4) as u64;
    let mut bytes = Vec::with_capacity(read_limit as usize);
    if let Err(e) = file.take(read_limit).read_to_end(&mut bytes) {
        return ok_json(serde_json::json!({ "error": format!("Failed to read file: {}", e) }));
    }

    let start = offset;
    let content_bytes = &bytes[..];
    let mut end = limit.min(content_bytes.len());
    if end < content_bytes.len() {
        while end > 0 && content_bytes[end] & 0b1100_0000 == 0b1000_0000 {
            end -= 1;
        }
        if end == 0 && !content_bytes.is_empty() {
            let first = content_bytes[0];
            let char_bytes = if first & 0b1000_0000 == 0 { 1 }
                else if first & 0b1110_0000 == 0b1100_0000 { 2 }
                else if first & 0b1111_0000 == 0b1110_0000 { 3 }
                else if first & 0b1111_1000 == 0b1111_0000 { 4 }
                else {
                    return ok_json(serde_json::json!({ "error": "Failed to read file: invalid UTF-8 sequence" }));
                };
            end = char_bytes.min(content_bytes.len());
        }
    }

    let content = match std::str::from_utf8(&content_bytes[..end]) {
        Ok(content) => content,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Failed to read file: {}", e) })),
    };
    let next_offset = start.saturating_add(end as u64);
    let has_more = next_offset < file_bytes;
    ok_json(serde_json::json!({
        "content": content,
        "fileBytes": file_bytes,
        "modifiedMs": modified_ms,
        "offsetBytes": start,
        "nextOffsetBytes": if has_more { Some(next_offset) } else { None },
        "truncated": has_more,
    }))
}

/// Write via a unique, exclusive temp file in the same directory, then rename.
/// `create_new` refuses an existing path (including a symlink), avoiding the
/// predictable-temp-file symlink write-through bug. The destination is never
/// truncated before the complete replacement is ready.
fn write_file_atomic(path: &Path, content: &str) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    for _ in 0..8 {
        let tmp = parent.join(format!(".native-agent-{}.tmp", uuid::Uuid::new_v4()));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        if let Err(e) = file.write_all(content.as_bytes()).and_then(|_| file.sync_all()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        drop(file);
        if let Err(e) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        return Ok(());
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary file",
    ))
}

/// Create a file without replacing an existing entry. Write the bytes to a
/// unique sibling first, then atomically hard-link it into place; unlike rename,
/// hard_link fails if a destination (including a symlink) already exists.
fn write_file_create_new(path: &Path, content: &str) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    for _ in 0..8 {
        let tmp = parent.join(format!(".native-agent-{}.tmp", uuid::Uuid::new_v4()));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        if let Err(e) = file.write_all(content.as_bytes()).and_then(|_| file.sync_all()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        drop(file);
        let link_result = std::fs::hard_link(&tmp, path);
        let _ = std::fs::remove_file(&tmp);
        return link_result.map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                io::Error::new(io::ErrorKind::AlreadyExists, "destination already exists; refusing to overwrite")
            } else {
                e
            }
        });
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "could not allocate a unique temporary file"))
}

fn tool_write_file(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");
    if content.len() as u64 > MAX_FILE_SIZE {
        return ok_json(serde_json::json!({
            "error": format!("Content exceeds the {} byte tool limit", MAX_FILE_SIZE)
        }));
    }
    let path = resolve_path(workspace, rel)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let create_only = args["create_only"].as_bool().unwrap_or(false);
    let result = if create_only {
        write_file_create_new(&path, content)
    } else {
        write_file_atomic(&path, content)
    };
    match result {
        Ok(_) => ok_json(serde_json::json!({ "success": true, "path": rel, "created": create_only })),
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
    if old_text.is_empty() {
        return ok_json(serde_json::json!({ "error": "old_text must not be empty" }));
    }
    if old_text.len() as u64 > MAX_FILE_SIZE || new_text.len() as u64 > MAX_FILE_SIZE {
        return ok_json(serde_json::json!({
            "error": format!("old_text and new_text must each be at most {} bytes", MAX_FILE_SIZE)
        }));
    }
    let path = resolve_path(workspace, rel)?;

    let content = match read_file_limited(&path) {
        Ok(c) => c,
        Err(e) => {
            return ok_json(serde_json::json!({ "error": format!("Failed to read file: {}", e) }))
        }
    };

    if let Some(idx) = content.find(old_text) {
        let suffix_start = idx + old_text.len();
        let new_len = idx
            .saturating_add(new_text.len())
            .saturating_add(content.len().saturating_sub(suffix_start));
        if new_len as u64 > MAX_FILE_SIZE {
            return ok_json(serde_json::json!({
                "error": format!("Edited file exceeds the {} byte tool limit", MAX_FILE_SIZE)
            }));
        }
        let mut new_content = String::with_capacity(new_len);
        new_content.push_str(&content[..idx]);
        new_content.push_str(new_text);
        new_content.push_str(&content[suffix_start..]);
        write_file_atomic(&path, &new_content)?;
        ok_json(serde_json::json!({ "success": true, "path": rel, "replacements": 1 }))
    } else {
        ok_json(
            serde_json::json!({ "error": "old_text not found in file. Use read_file to verify the exact content." }),
        )
    }
}

/// Delete exactly one regular file in the workspace. Resolve/canonicalize the
/// parent, not the leaf: canonicalizing the leaf would follow a symlink and
/// could silently delete its target. Symlinks and directories are rejected.
fn tool_delete_file(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or("");
    if rel.len() > MAX_PATH_ARGUMENT_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Path exceeds the {} byte limit", MAX_PATH_ARGUMENT_BYTES),
        });
    }
    let clean = rel.replace('\\', "/");
    if clean.starts_with('/') || (clean.len() >= 2 && clean.as_bytes()[1] == b':') {
        return Err(NativeAgentError::Tool {
            msg: "Access denied: absolute paths are not allowed, use a workspace-relative path".into(),
        });
    }
    if clean.split('/').any(|part| part == "..") {
        return Err(NativeAgentError::Tool {
            msg: "Access denied: path traversal (..) not allowed".into(),
        });
    }
    let relative = Path::new(&clean);
    let file_name = relative.file_name().ok_or_else(|| NativeAgentError::Tool {
        msg: "A file path is required; directories and the workspace root cannot be deleted".into(),
    })?;
    let parent_rel = relative.parent().unwrap_or_else(|| Path::new(""));
    let workspace_root = std::fs::canonicalize(workspace).map_err(|e| NativeAgentError::Tool {
        msg: format!("Workspace is not accessible: {}", e),
    })?;
    let parent = std::fs::canonicalize(Path::new(workspace).join(parent_rel)).map_err(|e| {
        NativeAgentError::Tool { msg: format!("Parent directory is not accessible: {}", e) }
    })?;
    if !parent.starts_with(&workspace_root) {
        return Err(NativeAgentError::Tool { msg: "Access denied: path outside workspace".into() });
    }
    let target = parent.join(file_name);
    let metadata = std::fs::symlink_metadata(&target).map_err(|e| NativeAgentError::Tool {
        msg: format!("File is not accessible: {}", e),
    })?;
    let kind = metadata.file_type();
    if kind.is_symlink() {
        return Err(NativeAgentError::Tool {
            msg: "Refusing to delete a symbolic link".into(),
        });
    }
    if !kind.is_file() {
        return Err(NativeAgentError::Tool {
            msg: "Only regular files can be deleted; directories are not supported".into(),
        });
    }
    let deleted_bytes = metadata.len();
    std::fs::remove_file(&target).map_err(|e| NativeAgentError::Tool {
        msg: format!("Failed to delete file: {}", e),
    })?;
    ok_json(serde_json::json!({ "success": true, "path": rel, "deletedBytes": deleted_bytes }))
}

fn tool_list_files(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or(".");
    let include_skipped = args["include_skipped"].as_bool().unwrap_or(false);
    let path = resolve_path(workspace, rel)?;
    match std::fs::read_dir(&path) {
        Ok(entries) => {
            let mut items = Vec::new();
            let mut truncated = false;
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !include_skipped && should_skip(&name) {
                    continue;
                }
                if items.len() >= MAX_MATCHES {
                    truncated = true;
                    break;
                }
                let kind = match entry.file_type() {
                    Ok(kind) if kind.is_symlink() => "symlink",
                    Ok(kind) if kind.is_dir() => "directory",
                    Ok(_) => "file",
                    Err(_) => "unknown",
                };
                let mut item = serde_json::json!({ "name": name, "type": kind });
                if kind == "file" {
                    if let Ok(meta) = entry.metadata() {
                        item["size"] = serde_json::json!(meta.len());
                    }
                }
                items.push(item);
            }
            ok_json(serde_json::json!({ "entries": items, "truncated": truncated }))
        }
        Err(e) => ok_json(serde_json::json!({ "error": format!("Failed to list directory: {}", e) })),
    }
}

struct WalkState {
    scanned_entries: usize,
    scanned_bytes: u64,
    visited_dirs: HashSet<PathBuf>,
    truncated: bool,
}

impl WalkState {
    fn new() -> Self {
        Self { scanned_entries: 0, scanned_bytes: 0, visited_dirs: HashSet::new(), truncated: false }
    }

    fn enter_dir(&mut self, dir: &Path, workspace: &Path, depth: usize) -> bool {
        if depth > MAX_SEARCH_DEPTH || self.scanned_entries >= MAX_SCAN_ENTRIES {
            self.truncated = true;
            return false;
        }
        let canonical = match std::fs::canonicalize(dir) {
            Ok(path) if path.starts_with(workspace) => path,
            _ => return false,
        };
        self.visited_dirs.insert(canonical)
    }

    fn scan_one(&mut self) -> bool {
        if self.scanned_entries >= MAX_SCAN_ENTRIES {
            self.truncated = true;
            return false;
        }
        self.scanned_entries += 1;
        true
    }
}

fn tool_find_files(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or(".");
    let pattern_str = args["pattern"].as_str().unwrap_or("*");
    let include_skipped = args["include_skipped"].as_bool().unwrap_or(false);
    if pattern_str.len() > MAX_GLOB_PATTERN_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Glob pattern exceeds the {} byte limit", MAX_GLOB_PATTERN_BYTES),
        });
    }
    let base = resolve_path(workspace, rel)?;
    let workspace_root = std::fs::canonicalize(workspace).map_err(|e| NativeAgentError::Tool {
        msg: format!("Workspace is not accessible: {}", e),
    })?;
    let pattern = glob_to_regex(pattern_str);
    let mut results = Vec::new();
    let mut state = WalkState::new();
    walk_find(&base, &pattern, &mut results, &workspace_root, 0, include_skipped, &mut state);
    ok_json(serde_json::json!({ "files": results, "returned": results.len(), "truncated": state.truncated }))
}

fn walk_find(
    dir: &Path,
    pattern: &regex::Regex,
    results: &mut Vec<serde_json::Value>,
    workspace: &Path,
    depth: usize,
    include_skipped: bool,
    state: &mut WalkState,
) {
    if !state.enter_dir(dir, workspace, depth) {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !state.scan_one() {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !include_skipped && should_skip(&name) {
            continue;
        }
        let kind = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => continue,
            Ok(kind) => kind,
            Err(_) => continue,
        };
        let path = entry.path();
        let is_dir = kind.is_dir();
        if pattern.is_match(&name) {
            if results.len() >= MAX_MATCHES {
                state.truncated = true;
                return;
            }
            let rel = path.strip_prefix(workspace).unwrap_or(&path);
            let rel_string = rel.to_string_lossy();
            let mut item = serde_json::json!({
                "path": truncate_str(&rel_string, 512),
                "pathTruncated": rel_string.len() > 512,
                "type": if is_dir { "directory" } else { "file" }
            });
            if !is_dir {
                if let Ok(meta) = entry.metadata() {
                    item["size"] = serde_json::json!(meta.len());
                }
            }
            results.push(item);
        }
        if is_dir {
            walk_find(&path, pattern, results, workspace, depth + 1, include_skipped, state);
            if state.truncated {
                return;
            }
        }
    }
}

fn tool_grep_files(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let rel = args["path"].as_str().unwrap_or(".");
    let pattern_str = args["pattern"].as_str().unwrap_or("");
    if pattern_str.len() > MAX_REGEX_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Regex exceeds the {} byte limit", MAX_REGEX_BYTES),
        });
    }
    let case_insensitive = args["case_insensitive"].as_bool().unwrap_or(false);
    let base = resolve_path(workspace, rel)?;
    let re = match regex::RegexBuilder::new(pattern_str).case_insensitive(case_insensitive).build() {
        Ok(regex) => regex,
        Err(e) => return ok_json(serde_json::json!({ "error": format!("Invalid regex: {}", e) })),
    };
    let workspace_root = std::fs::canonicalize(workspace).map_err(|e| NativeAgentError::Tool {
        msg: format!("Workspace is not accessible: {}", e),
    })?;
    let mut matches = Vec::new();
    let mut state = WalkState::new();
    if base.is_file() {
        grep_file(&base, &re, &mut matches, &workspace_root, &mut state);
    } else {
        walk_grep(&base, &re, &mut matches, &workspace_root, 0, &mut state);
    }
    ok_json(serde_json::json!({ "matches": matches, "returned": matches.len(), "truncated": state.truncated }))
}

fn grep_file(path: &Path, re: &regex::Regex, matches: &mut Vec<serde_json::Value>, workspace: &Path, state: &mut WalkState) {
    if !state.scan_one() {
        return;
    }
    let remaining = MAX_GREP_TOTAL_BYTES.saturating_sub(state.scanned_bytes);
    if remaining == 0 {
        state.truncated = true;
        return;
    }
    let per_file_limit = MAX_FILE_SIZE.min(remaining);
    let file_size = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(_) => return,
    };
    if file_size > per_file_limit {
        // Do not silently omit a large file or exceed the global scan budget.
        // Report truncation so the caller can narrow the path/pattern.
        state.truncated = true;
        return;
    }
    let content = match read_file_limited_to(path, per_file_limit) {
        Ok(content) => content,
        Err(_) => {
            state.truncated = true;
            return;
        }
    };
    state.scanned_bytes = state.scanned_bytes.saturating_add(content.len() as u64);
    let rel = path.strip_prefix(workspace).unwrap_or(path).to_string_lossy();
    let file_truncated = rel.len() > 512;
    let rel = truncate_str(&rel, 512).to_string();
    for (i, line) in content.lines().enumerate() {
        if re.is_match(line) {
            if matches.len() >= MAX_GREP_MATCHES {
                state.truncated = true;
                return;
            }
            matches.push(serde_json::json!({
                    "file": rel,
                    "fileTruncated": file_truncated,
                    "line": i + 1,
                "content": truncate_str(line, 500),
            }));
        }
    }
}

fn walk_grep(
    dir: &Path,
    re: &regex::Regex,
    matches: &mut Vec<serde_json::Value>,
    workspace: &Path,
    depth: usize,
    state: &mut WalkState,
) {
    if !state.enter_dir(dir, workspace, depth) {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !state.scan_one() {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip(&name) {
            continue;
        }
        let kind = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => continue,
            Ok(kind) => kind,
            Err(_) => continue,
        };
        let path = entry.path();
        if kind.is_dir() {
            walk_grep(&path, re, matches, workspace, depth + 1, state);
            if state.truncated {
                return;
            }
        } else {
            grep_file(&path, re, matches, workspace, state);
            if state.truncated {
                return;
            }
        }
    }
}

// ── Shell execution ─────────────────────────────────────────────────────────

/// iOS forbids process spawning outright for sandboxed apps: `fork`, `exec`
/// and `posix_spawn` all fail with EPERM, and `NSTask` is not part of the iOS
/// SDK. `tokio::process::Command` goes through `posix_spawn`, so this tool can
/// never work there.
///
/// Previously the model was simply told "Execute a shell command", tried it,
/// and got a bare "Command failed to start: Operation not permitted (os error
/// 1)". Nothing in that says the tool is *permanently* unavailable, so a model
/// would reasonably retry it — burning turns for the rest of the session.
/// Answering with an explicit, final explanation lets it switch strategy on the
/// very next step.
#[cfg(target_os = "ios")]
async fn tool_execute_command(
    args: &serde_json::Value,
    _workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let command = truncate_str(args["command"].as_str().unwrap_or(""), 512);
    ok_json(serde_json::json!({
        "exitCode": -1,
        "stdout": "",
        "stderr": format!(
            "execute_command is not available on iOS: the operating system does not \
             permit an app to start another process, so no shell exists to run '{}'. \
             This is permanent — do not retry it. Use read_file, write_file, edit_file, \
             list_files, find_files, grep_files and the git_* tools instead, which are \
             implemented natively and work on iOS.",
            command
        ),
        "timedOut": false,
        "unsupported": true,
    }))
}

#[cfg(not(target_os = "ios"))]
async fn collect_process_output<R>(mut reader: R) -> io::Result<(String, bool)>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::AsyncReadExt;

    let mut captured = Vec::with_capacity(MAX_OUTPUT_BYTES);
    let mut total = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n);
        let keep = n.min(MAX_OUTPUT_BYTES.saturating_sub(captured.len()));
        captured.extend_from_slice(&chunk[..keep]);
    }
    let text = String::from_utf8_lossy(&captured).into_owned();
    let truncated = total > captured.len();
    Ok((
        if truncated { truncate_with_notice(&text, MAX_OUTPUT_BYTES) } else { text },
        truncated,
    ))
}

#[cfg(not(target_os = "ios"))]
async fn tool_execute_command(
    args: &serde_json::Value,
    workspace: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let command = args["command"].as_str().unwrap_or("");
    if command.len() > MAX_COMMAND_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Command exceeds the {} byte limit", MAX_COMMAND_BYTES),
        });
    }
    let cwd = args["cwd"].as_str().unwrap_or("");
    let work_dir = if cwd.is_empty() {
        PathBuf::from(workspace)
    } else {
        resolve_path(workspace, cwd)?
    };
    let timeout_ms = args["timeout_ms"]
        .as_u64()
        .or_else(|| args["timeoutMs"].as_u64())
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_MS)
        .clamp(1, MAX_COMMAND_TIMEOUT_MS);

    let mut builder = tokio::process::Command::new("sh");
    builder
        .arg("-c")
        .arg(command)
        .current_dir(&work_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    builder.process_group(0);

    let mut child = builder.spawn().map_err(|e| NativeAgentError::Tool {
        msg: format!("Command failed to start: {}", e),
    })?;
    let stdout = child.stdout.take().ok_or_else(|| NativeAgentError::Tool {
        msg: "Command stdout pipe was not created".into(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| NativeAgentError::Tool {
        msg: "Command stderr pipe was not created".into(),
    })?;
    let mut stdout_task = tokio::spawn(collect_process_output(stdout));
    let mut stderr_task = tokio::spawn(collect_process_output(stderr));
    // Capture the group leader while it is definitely alive. The shell may exit
    // before descendants close inherited pipes; in that case child.id() can no
    // longer be available when the drain timeout fires, but the process group
    // still needs to be signalled.
    #[cfg(unix)]
    let process_group_id = child.id();

    // Bound both child.wait() and draining the pipes. A shell can exit while a
    // background descendant still owns stdout/stderr; waiting for EOF alone
    // would otherwise outlive the command timeout.
    let completion = async {
        let status = child.wait().await.map_err(|e| e.to_string())?;
        let stdout = (&mut stdout_task).await.ok().and_then(Result::ok).unwrap_or_default();
        let stderr = (&mut stderr_task).await.ok().and_then(Result::ok).unwrap_or_default();
        Ok::<_, String>((status, stdout, stderr))
    };
    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), completion).await {
        Ok(Ok((status, stdout, stderr))) => {
            ok_json(serde_json::json!({
                "exitCode": status.code().unwrap_or(-1),
                "stdout": stdout.0,
                "stderr": stderr.0,
                "stdoutTruncated": stdout.1,
                "stderrTruncated": stderr.1,
                "timedOut": false,
            }))
        }
        Ok(Err(e)) => {
            stdout_task.abort();
            stderr_task.abort();
            Err(NativeAgentError::Tool { msg: format!("Command failed: {}", e) })
        }
        Err(_) => {
            // A timeout must terminate the process group, not merely drop the
            // future. Tokio intentionally does not kill children on drop by
            // default, so configure kill_on_drop and send an explicit kill.
            #[cfg(unix)]
            if let Some(pid) = process_group_id {
                // SAFETY: `process_group(0)` made this child the leader of a new
                // process group; a negative pid signals that group only. The id
                // was captured before the child could exit, so it still works
                // when descendants outlive the shell and hold its pipes open.
                unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL); }
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_task.abort();
            stderr_task.abort();
            ok_json(serde_json::json!({
                "exitCode": -1,
                "stdout": "",
                "stderr": format!(
                    "Command timed out after {} ms; the process group was terminated. The maximum timeout is {} ms.",
                    timeout_ms, MAX_COMMAND_TIMEOUT_MS
                ),
                "timedOut": true,
            }))
        }
    }
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
fn safe_git_relative_path(raw: &str) -> Result<PathBuf, NativeAgentError> {
    if raw.len() > MAX_PATH_ARGUMENT_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Git path exceeds the {} byte limit", MAX_PATH_ARGUMENT_BYTES),
        });
    }
    let clean = raw.replace('\\', "/");
    if clean.is_empty() || clean.starts_with('/') || (clean.len() >= 2 && clean.as_bytes()[1] == b':')
        || clean.split('/').any(|part| part == "..")
    {
        return Err(NativeAgentError::Tool { msg: "Git paths must stay relative to the workspace".into() });
    }
    Ok(PathBuf::from(clean))
}

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
    let mut truncated = false;
    for entry in statuses.iter() {
        if files.len() >= MAX_MATCHES {
            truncated = true;
            break;
        }
        let raw_path = entry.path().unwrap_or("?");
        let path_truncated = raw_path.len() > 512;
        let path = truncate_str(raw_path, 512);
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
        files.push(serde_json::json!({ "path": path, "pathTruncated": path_truncated, "status": status }));
    }
    ok_json(serde_json::json!({ "files": files, "returned": files.len(), "truncated": truncated }))
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
        let path = safe_git_relative_path(path_arg)?;
        index
            .add_path(&path)
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
    let message = args["message"].as_str().unwrap_or("");
    if message.trim().is_empty() {
        return Err(NativeAgentError::Tool { msg: "Commit message must not be empty".into() });
    }
    if message.len() > MAX_GIT_COMMIT_MESSAGE_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Commit message exceeds the {} byte limit", MAX_GIT_COMMIT_MESSAGE_BYTES),
        });
    }
    let author_name = args["author_name"].as_str().unwrap_or("mobile-claw");
    let author_email = args["author_email"]
        .as_str()
        .unwrap_or("agent@mobile-claw.local");
    if author_name.len() > MAX_GIT_IDENTITY_BYTES || author_email.len() > MAX_GIT_IDENTITY_BYTES {
        return Err(NativeAgentError::Tool {
            msg: format!("Git author fields are limited to {} UTF-8 bytes", MAX_GIT_IDENTITY_BYTES),
        });
    }
    // Validate identity before staging anything so a malformed author cannot
    // leave the user's index partially changed when commit creation fails.
    let sig = git2::Signature::now(author_name, author_email)
        .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
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
            let raw_path = f.as_str().ok_or_else(|| NativeAgentError::Tool {
                msg: "Every git_commit.files item must be a string".into(),
            })?;
            if raw_path == "." {
                index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
                    .map_err(|e| NativeAgentError::Tool { msg: format!("Could not stage all files: {}", e) })?;
            } else {
                let path = safe_git_relative_path(raw_path)?;
                index
                    .add_path(&path)
                    .map_err(|e| NativeAgentError::Tool { msg: format!("Could not stage '{}': {}", raw_path, e) })?;
            }
        }
        index
            .write()
            .map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
    }

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
    if let Some(parent_commit) = parent.as_ref() {
        let parent_tree = parent_commit.tree().map_err(|e| NativeAgentError::Tool { msg: e.to_string() })?;
        if parent_tree.id() == tree.id() {
            return Err(NativeAgentError::Tool { msg: "No staged changes to commit".into() });
        }
    }
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
    let max_count = args["max_count"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
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
    for oid in revwalk.take(max_count + 1).flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            let author = commit.author();
            commits.push(serde_json::json!({
                "sha": oid.to_string(),
                "message": truncate_str(commit.message().unwrap_or(""), 1_000),
                "author": truncate_str(author.name().unwrap_or(""), 200),
                "email": truncate_str(author.email().unwrap_or(""), 200),
                "timestamp": commit.time().seconds(),
            }));
        }
    }
    let truncated = commits.len() > max_count;
    commits.truncate(max_count);
    let returned = commits.len();
    ok_json(serde_json::json!({ "commits": commits, "returned": returned, "truncated": truncated }))
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

    let mut changes: Vec<serde_json::Value> = Vec::new();
    let mut output_bytes = 0usize;
    let mut truncated = false;
    let mut last_full_path = String::new();
    let print_result = diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let full_path = delta.new_file().path()
            .or_else(|| delta.old_file().path())
            .unwrap_or(Path::new("?"))
            .to_string_lossy()
            .into_owned();
        let path_truncated = full_path.len() > 200;
        let path = truncate_str(&full_path, 200).to_string();
        // Compare untruncated paths; otherwise two long filenames sharing the
        // same 200-byte prefix could be incorrectly merged into one diff entry.
        let is_existing_file = last_full_path == full_path;
        if !is_existing_file && changes.len() >= MAX_DIFF_FILES {
            truncated = true;
            return false;
        }
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        let prefix = match line.origin() { '+' => "+", '-' => "-", ' ' => " ", _ => "" };
        let line_text = format!("{}{}", prefix, content);
        if output_bytes.saturating_add(line_text.len()) > MAX_DIFF_BYTES {
            truncated = true;
            return false;
        }
        output_bytes += line_text.len();

        if is_existing_file {
            if let Some(last) = changes.last_mut() {
                if let Some(patch) = last["patch"].as_str() {
                    let new_patch = format!("{}{}", patch, line_text);
                    if new_patch.len() > MAX_DIFF_PATCH_BYTES {
                        truncated = true;
                        return false;
                    }
                    last["patch"] = serde_json::json!(new_patch);
                }
                return true;
            }
        }
        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Modified => "modified",
            _ => "unknown",
        };
        changes.push(serde_json::json!({
            "path": path,
            "pathTruncated": path_truncated,
            "status": status,
            "patch": line_text,
        }));
        last_full_path = full_path;
        true
    });
    if let Err(e) = print_result {
        if !truncated {
            return Err(NativeAgentError::Tool { msg: format!("Diff failed: {}", e) });
        }
    }
    ok_json(serde_json::json!({ "changes": changes, "returned": changes.len(), "truncated": truncated }))
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

/// Resolve and validate every address for a URL. The returned addresses are
/// passed to reqwest's resolver override so the connection uses exactly the
/// addresses that were checked (rather than doing a second, rebinding-prone DNS
/// lookup). Redirects are not followed automatically; each new URL must go
/// through this check again.
pub(crate) async fn resolve_fetch_addresses(url: &reqwest::Url) -> Result<Vec<std::net::IpAddr>, NativeAgentError> {
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(NativeAgentError::Tool {
            msg: format!("Access denied: only http and https URLs can be fetched (got '{}')", other),
        }),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NativeAgentError::Tool { msg: "Access denied: URL credentials are not allowed".into() });
    }
    let host = url.host_str().ok_or_else(|| NativeAgentError::Tool {
        msg: "Access denied: the URL has no host".to_string(),
    })?;
    let port = url.port_or_known_default().unwrap_or(80);
    let addresses = if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        vec![ip]
    } else {
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| NativeAgentError::Tool { msg: format!("DNS lookup for '{}' timed out", host) })?
        .map_err(|e| NativeAgentError::Tool { msg: format!("Could not resolve host '{}': {}", host, e) })?
        .map(|address| address.ip())
        .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err(NativeAgentError::Tool { msg: format!("Could not resolve host '{}'", host) });
    }
    for ip in &addresses {
        if is_private_ip(ip) {
            return Err(NativeAgentError::Tool {
                msg: format!("Access denied: '{}' resolves to non-public address {}", host, ip),
            });
        }
    }
    Ok(addresses)
}

/// Conservative global-unicast check: reject private, local, reserved,
/// benchmark, documentation, multicast and non-global IPv6 ranges.
fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || octets[0] == 0
                || octets[0] >= 224 // multicast, reserved and limited broadcast
                || (octets[0] == 100 && (64..128).contains(&octets[1])) // CGNAT
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0) // protocol assignments
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99) // deprecated 6to4 relay
                || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)) // benchmarking
        }
        std::net::IpAddr::V6(v6) => {
            let segments = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (segments[0] & 0xe000) != 0x2000 // allow only 2000::/3 global-unicast space
                || (segments[0] == 0x2001 && segments[1] <= 0x01ff) // special-purpose block
                || (segments[0] == 0x2001 && segments[1] == 0x0002) // benchmarking
                || (segments[0] == 0x2001 && segments[1] == 0x0db8) // documentation
                || (segments[0] == 0x2002) // 6to4 embeds arbitrary IPv4 destinations
                || (segments[0] == 0x3fff && segments[1] <= 0x000f) // documentation
                || v6.to_ipv4_mapped()
                    .map(|v4| is_private_ip(&std::net::IpAddr::V4(v4)))
                    .unwrap_or(false)
        }
    }
}

#[cfg(test)]
async fn ensure_url_is_fetchable(raw_url: &str) -> Result<(), NativeAgentError> {
    let url = reqwest::Url::parse(raw_url).map_err(|e| NativeAgentError::Tool {
        msg: format!("Invalid URL: {}", e),
    })?;
    resolve_fetch_addresses(&url).await.map(|_| ())
}

async fn tool_web_fetch(args: &serde_json::Value) -> Result<serde_json::Value, NativeAgentError> {
    let raw_url = args["url"].as_str().unwrap_or("");
    if raw_url.len() > MAX_HTTP_URL_BYTES {
        return Err(NativeAgentError::Tool { msg: format!("URL exceeds the {} byte limit", MAX_HTTP_URL_BYTES) });
    }
    if args["body"].as_str().map(|body| body.len() > MAX_HTTP_REQUEST_BODY_BYTES).unwrap_or(false) {
        return Err(NativeAgentError::Tool { msg: format!("Request body exceeds the {} byte limit", MAX_HTTP_REQUEST_BODY_BYTES) });
    }
    if let Some(headers) = args.get("headers").and_then(serde_json::Value::as_object) {
        if headers.len() > MAX_HTTP_HEADERS {
            return Err(NativeAgentError::Tool {
                msg: format!("At most {} request headers are allowed", MAX_HTTP_HEADERS),
            });
        }
        for (name, value) in headers {
            let value = value.as_str().unwrap_or("");
            if name.len() > MAX_HTTP_HEADER_NAME_BYTES || value.len() > MAX_HTTP_HEADER_VALUE_BYTES {
                return Err(NativeAgentError::Tool {
                    msg: format!("HTTP header names are limited to {} bytes and values to {} bytes", MAX_HTTP_HEADER_NAME_BYTES, MAX_HTTP_HEADER_VALUE_BYTES),
                });
            }
            if value.contains('\r') || value.contains('\n') {
                return Err(NativeAgentError::Tool { msg: "HTTP header values must not contain CR or LF".into() });
            }
        }
    }
    let url = reqwest::Url::parse(raw_url).map_err(|e| NativeAgentError::Tool {
        msg: format!("Invalid URL: {}", e),
    })?;
    let method = args["method"].as_str().unwrap_or("GET").to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err(NativeAgentError::Tool { msg: format!("Unsupported HTTP method '{}'", method) });
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| NativeAgentError::Tool {
        msg: format!("Invalid HTTP method: {}", e),
    })?;
    let timeout_ms = args["timeout_ms"]
        .as_u64()
        .or_else(|| args["timeoutMs"].as_u64())
        .unwrap_or(30_000)
        .clamp(1, 120_000);

    let addresses = resolve_fetch_addresses(&url).await?;
    let host = url.host_str().unwrap_or("");
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none());
    if host.parse::<std::net::IpAddr>().is_err() {
        let pinned: Vec<std::net::SocketAddr> = addresses
            .iter()
            .copied()
            .map(|ip| std::net::SocketAddr::new(ip, 0))
            .collect();
        builder = builder.resolve_to_addrs(host, &pinned);
    }
    let client = builder.build().map_err(|e| NativeAgentError::Tool {
        msg: format!("Could not build HTTP client: {}", e),
    })?;
    let mut request = client.request(method, url.clone());
    if let Some(body) = args["body"].as_str() {
        request = request.body(body.to_string());
    }
    if let Some(headers) = args["headers"].as_object() {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                request = request.header(name.as_str(), value);
            }
        }
    }

    let mut response = request.send().await.map_err(|e| NativeAgentError::Tool {
        msg: format!("Fetch failed: {}", e),
    })?;
    let status = response.status().as_u16();
    let redirect_location = response.headers().get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok()).map(str::to_string);
    let mut body = Vec::with_capacity(MAX_OUTPUT_BYTES);
    let mut truncated = false;
    while let Some(chunk) = response.chunk().await.map_err(|e| NativeAgentError::Tool {
        msg: format!("Failed while reading response: {}", e),
    })? {
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(body.len());
        let keep = chunk.len().min(remaining);
        body.extend_from_slice(&chunk[..keep]);
        if keep < chunk.len() {
            truncated = true;
            break;
        }
    }
    let body = String::from_utf8_lossy(&body).into_owned();
    let body = if truncated { truncate_with_notice(&body, MAX_OUTPUT_BYTES) } else { body };
    ok_json(serde_json::json!({
        "url": raw_url,
        "status": status,
        "body": body,
        "truncated": truncated,
        "redirectLocation": redirect_location,
        "redirectsFollowed": false,
    }))
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
    for (field, limit) in [
        ("name", MAX_CRON_NAME_BYTES),
        ("prompt", MAX_CRON_PROMPT_BYTES),
        ("skillId", MAX_MEMORY_KEY_BYTES),
        ("id", MAX_MEMORY_KEY_BYTES),
        ("notificationTitle", MAX_MEMORY_KEY_BYTES),
    ] {
        if args
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(|value| value.len() > limit)
            .unwrap_or(false)
        {
            return Err(NativeAgentError::Tool {
                msg: format!("Cron argument '{}' exceeds the {} UTF-8 byte limit", field, limit),
            });
        }
    }
    if args
        .get("schedule")
        .map(|schedule| schedule.to_string().len() > MAX_CRON_SCHEDULE_BYTES)
        .unwrap_or(false)
    {
        return Err(NativeAgentError::Tool {
            msg: format!("Cron schedule exceeds the {} byte limit", MAX_CRON_SCHEDULE_BYTES),
        });
    }

    let conn = crate::db::open_db(db_path)?;
    crate::db::ensure_schema(&conn)?;

    match action {
        "list" => {
            let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 20) as u32;
            let (jobs_json, total) = crate::db::list_cron_jobs_limited(&conn, limit)?;
            let jobs: serde_json::Value = serde_json::from_str(&jobs_json)?;
            let mut items = jobs.as_array().cloned().unwrap_or_default();
            let mut truncated = total > items.len() as i64;
            for item in &mut items {
                for (field, cap) in [
                    ("id", 512),
                    ("name", 200),
                    ("skillId", 512),
                    ("prompt", 1_000),
                    ("deliveryWebhookUrl", 1_000),
                    ("deliveryNotificationTitle", 512),
                    ("lastError", 1_000),
                ] {
                    truncated |= cap_json_text_field(item, field, cap);
                }
            }
            let returned = items.len();
            ok_json(serde_json::json!({ "jobs": items, "total": total, "returned": returned, "truncated": truncated }))
        }
        "create" => {
            let name = args["name"].as_str().unwrap_or("").trim();
            let prompt = args["prompt"].as_str().unwrap_or("");
            let skill_id = args["skillId"].as_str();
            if name.is_empty() {
                return Err(NativeAgentError::Tool { msg: "A non-empty `name` is required".into() });
            }
            if prompt.trim().is_empty() && skill_id.map(str::trim).unwrap_or("").is_empty() {
                return Err(NativeAgentError::Tool { msg: "Provide a non-empty `prompt` or a valid `skillId`".into() });
            }
            let mut schedule_forms = 0usize;
            for field in ["schedule", "atMs", "everyMs", "everyMinutes", "inMinutes"] {
                if args.get(field).map(|value| !value.is_null()).unwrap_or(false) {
                    schedule_forms += 1;
                }
            }
            if schedule_forms != 1 {
                return Err(NativeAgentError::Tool {
                    msg: "Provide exactly one of `schedule`, `atMs`, `everyMs`, `everyMinutes`, or `inMinutes`".into(),
                });
            }
            if args.get("schedule").map(|value| !value.is_object()).unwrap_or(false) {
                return Err(NativeAgentError::Tool { msg: "`schedule` must be an object".into() });
            }

            let now = chrono::Utc::now().timestamp_millis();
            let schedule = if let Some(schedule) = args.get("schedule").filter(|value| value.is_object()) {
                let kind = schedule["kind"].as_str().unwrap_or("");
                match kind {
                    "at"
                        if schedule["atMs"].as_i64().map(|at_ms| at_ms >= 0).unwrap_or(false)
                            && schedule.get("everyMs").is_none()
                            && schedule.get("anchorMs").is_none() =>
                    {
                        schedule.clone()
                    }
                    "every" => {
                        if schedule.get("atMs").is_some() {
                            return Err(NativeAgentError::Tool { msg: "An `every` schedule cannot include `atMs`".into() });
                        }
                        let every_ms = schedule["everyMs"].as_i64().unwrap_or(0);
                        if every_ms <= 0 || now.checked_add(every_ms).is_none() {
                            return Err(NativeAgentError::Tool { msg: "An `every` schedule requires a positive, representable `everyMs`".into() });
                        }
                        if schedule.get("anchorMs").map(|value| value.as_i64().filter(|anchor| *anchor >= 0).is_none()).unwrap_or(false) {
                            return Err(NativeAgentError::Tool { msg: "`anchorMs` must be a non-negative representable timestamp".into() });
                        }
                        schedule.clone()
                    }
                    _ => return Err(NativeAgentError::Tool { msg: "Schedule must be {kind: 'at', atMs: non-negative timestamp} or {kind: 'every', everyMs: positive_ms}".into() }),
                }
            } else if let Some(at_ms) = args["atMs"].as_i64() {
                serde_json::json!({ "kind": "at", "atMs": at_ms })
            } else if let Some(every_ms) = args["everyMs"].as_i64() {
                if every_ms <= 0 || now.checked_add(every_ms).is_none() {
                    return Err(NativeAgentError::Tool { msg: "`everyMs` must be positive and representable".into() });
                }
                serde_json::json!({ "kind": "every", "everyMs": every_ms })
            } else if let Some(minutes) = args["everyMinutes"].as_i64() {
                let every_ms = minutes.checked_mul(60_000).filter(|value| *value > 0)
                    .ok_or_else(|| NativeAgentError::Tool { msg: "`everyMinutes` must be positive and within range".into() })?;
                if now.checked_add(every_ms).is_none() {
                    return Err(NativeAgentError::Tool { msg: "`everyMinutes` is too large".into() });
                }
                serde_json::json!({ "kind": "every", "everyMs": every_ms })
            } else if let Some(delay_minutes) = args["inMinutes"].as_i64() {
                let delay_ms = delay_minutes.checked_mul(60_000)
                    .ok_or_else(|| NativeAgentError::Tool { msg: "`inMinutes` is outside the supported range".into() })?;
                let at_ms = now.checked_add(delay_ms)
                    .filter(|_| delay_minutes >= 0)
                    .ok_or_else(|| NativeAgentError::Tool { msg: "`inMinutes` must be non-negative and representable".into() })?;
                serde_json::json!({ "kind": "at", "atMs": at_ms })
            } else {
                return Err(NativeAgentError::Tool {
                    msg: "A schedule is required. Pass `inMinutes`, `everyMinutes`, `everyMs`, `atMs`, or an `at`/`every` schedule object.".into(),
                });
            };

            let mut input = serde_json::Map::new();
            input.insert("name".into(), serde_json::json!(name));
            input.insert("prompt".into(), serde_json::json!(prompt));
            input.insert("schedule".into(), schedule);
            if let Some(skill) = skill_id {
                input.insert("skillId".into(), serde_json::json!(skill));
            }
            if let Some(title) = args["notificationTitle"].as_str() {
                input.insert("deliveryNotificationTitle".into(), serde_json::json!(title));
            }

            let created = crate::db::add_cron_job(
                &conn,
                &serde_json::to_string(&serde_json::Value::Object(input))?,
            )?;
            let mut created_value: serde_json::Value = serde_json::from_str(&created)?;
            let prompt_truncated = cap_json_text_field(&mut created_value, "prompt", 1_000);
            ok_json(serde_json::json!({ "success": true, "job": created_value, "promptTruncated": prompt_truncated }))
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
            let limit = args["limit"].as_i64().unwrap_or(20).clamp(1, 50);
            // Fetch one extra row so the response can report whether history was cut.
            let runs_json = crate::db::list_cron_runs(&conn, args["id"].as_str(), limit + 1)?;
            let runs: serde_json::Value = serde_json::from_str(&runs_json)?;
            let mut items = runs.as_array().cloned().unwrap_or_default();
            let truncated = items.len() > limit as usize;
            items.truncate(limit as usize);
            for item in &mut items {
                cap_json_text_field(item, "responseText", 1_000);
                cap_json_text_field(item, "error", 1_000);
            }
            let returned = items.len();
            ok_json(serde_json::json!({ "runs": items, "returned": returned, "truncated": truncated }))
        }
        "status" => {
            let (total, enabled): (i64, i64) = conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) FROM cron_jobs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let scheduler: serde_json::Value =
                serde_json::from_str(&crate::db::get_scheduler_config(&conn)?)?;
            let mut heartbeat: serde_json::Value =
                serde_json::from_str(&crate::db::get_heartbeat_config(&conn)?)?;
            let mut heartbeat_truncated = cap_json_text_field(&mut heartbeat, "prompt", 1_000);
            heartbeat_truncated |= cap_json_text_field(&mut heartbeat, "skillId", 512);
            ok_json(serde_json::json!({
                "totalJobs": total,
                "enabledJobs": enabled,
                "scheduler": scheduler,
                "heartbeat": heartbeat,
                "heartbeatTruncated": heartbeat_truncated,
            }))
        }
        _ => ok_json(serde_json::json!({
            "message": "Actions: list, create, delete, pause, resume, run, history, status",
            "createExample": { "action": "create", "name": "standup", "prompt": "Summarise my day", "everyMinutes": 1440 },
        })),
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn cap_json_text_field(value: &mut serde_json::Value, field: &str, max_bytes: usize) -> bool {
    let Some(text) = value.get(field).and_then(serde_json::Value::as_str).map(str::to_string) else {
        return false;
    };
    if text.len() <= max_bytes { return false; }
    if let Some(object) = value.as_object_mut() {
        object.insert(field.to_string(), serde_json::json!(truncate_str(&text, max_bytes)));
        object.insert(format!("{}Truncated", field), serde_json::json!(true));
    }
    true
}

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
            "Read a UTF-8 workspace file up to 10 MB in chunks of at most 50 KB; pass nextOffsetBytes as offset_bytes to continue.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "maxLength": 4096, "description": "File path relative to workspace (maximum 4 KB)" },
                    "offset_bytes": { "type": "integer", "minimum": 0, "maximum": 10000000, "description": "Byte offset returned as nextOffsetBytes (default 0)" },
                    "limit_bytes": { "type": "integer", "minimum": 1, "maximum": 50000, "description": "Maximum UTF-8 bytes to return (default 50000)" }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "write_file",
            "Write a UTF-8 text file atomically within the workspace (maximum 10 MB). Set create_only=true to atomically create a new file and refuse to overwrite an existing file.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "maxLength": 4096, "description": "File path relative to workspace (maximum 4 KB)" },
                    "content": { "type": "string", "description": "File content" },
                    "create_only": { "type": "boolean", "description": "If true, fail rather than replacing an existing file (default false)" }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "edit_file",
            "Replace the first non-empty old_text occurrence in a UTF-8 workspace file; result is atomic and limited to 10 MB.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "maxLength": 4096, "description": "File path relative to workspace (maximum 4 KB)" },
                    "old_text": { "type": "string", "description": "Text to find" },
                    "new_text": { "type": "string", "description": "Replacement text" }
                },
                "required": ["path", "old_text", "new_text"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "delete_file",
            "Permanently delete one regular file inside the workspace. Directories, symlinks, absolute paths, and paths outside the workspace are refused; this operation requires user approval by default.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "minLength": 1, "maxLength": 4096, "description": "Workspace-relative regular file path; directories and symlinks cannot be deleted" }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "list_files",
            "List one directory (up to 100 entries) inside the workspace; symlinks are reported but not followed. include_skipped can reveal normally skipped generated/system directories such as .git and node_modules.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "maxLength": 4096, "description": "Directory path relative to workspace (maximum 4 KB)" },
                    "include_skipped": { "type": "boolean", "description": "Include normally skipped directories such as .git and node_modules (default false)" }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "find_files",
            "Recursively match entry basenames against a case-insensitive glob, without following symlinks; returns at most 100 entries and scans at most 50,000 entries / 64 directory levels. include_skipped can reveal normally skipped generated/system directories.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "maxLength": 1024, "description": "Glob matched against each basename (maximum 1 KB; e.g. *.ts)" },
                    "path": { "type": "string", "maxLength": 4096, "description": "Base directory relative to workspace (default .)" },
                    "include_skipped": { "type": "boolean", "description": "Include normally skipped directories such as .git and node_modules (default false)" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "grep_files",
            "Search UTF-8 text files up to 10 MB each and 50 MB total per call with a line-based regex; symlinks are not followed, at most 50 matches / 50,000 entries / 64 levels.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "maxLength": 4096, "description": "Rust regex matched against each line (maximum 4 KB)" },
                    "path": { "type": "string", "maxLength": 4096, "description": "File or directory relative to workspace (default .)" },
                    "case_insensitive": { "type": "boolean", "description": "Match without case sensitivity (default false)" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "execute_command",
            // The model plans around this string, so it has to state the real
            // constraints: there is no shell at all on iOS, and Android ships a
            // minimal toybox userland — no git binary, no python, no node.
            "Execute a shell command via `sh -c` in the workspace. \
             ANDROID ONLY: iOS forbids starting processes, and this returns an \
             \"unsupported\" result there. The Android userland is minimal \
             (toybox): common file utilities exist, but git, python and node do \
             not — use the git_* tools for version control. Times out after 30 s \
             by default (`timeout_ms`, max 300000). stdin is /dev/null, so \
             interactive commands see EOF rather than hanging.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "maxLength": 100000, "description": "Shell command (maximum 100 KB); cwd is set to the workspace but this is not an OS-level filesystem sandbox" },
                    "cwd": { "type": "string", "maxLength": 4096, "description": "Working directory (relative to the workspace)" },
                    "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 300000, "description": "Command timeout in milliseconds (default 30000)" },
                    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 300000, "description": "Deprecated camelCase alias for timeout_ms" }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "git_init",
            "Initialize a git repository",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool_def(
            "git_status",
            "Get git status",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool_def(
            "git_add",
            "Stage files",
            serde_json::json!({
                "type": "object",
                "properties": { "path": { "type": "string", "maxLength": 4096, "description": "File or '.' for all" } },
                "required": ["path"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "git_commit",
            "Create a git commit",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string", "maxLength": 10000 },
                    "files": { "type": "array", "maxItems": 100, "items": { "type": "string", "maxLength": 4096 } },
                    "author_name": { "type": "string", "maxLength": 512 }, "author_email": { "type": "string", "maxLength": 512 }
                },
                "required": ["message"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "git_log",
            "Get commit log",
            serde_json::json!({
                "type": "object",
                "properties": { "max_count": { "type": "integer", "minimum": 1, "maximum": 50 } },
                "additionalProperties": false
            }),
        ),
        tool_def(
            "git_diff",
            "Get git diff",
            serde_json::json!({
                "type": "object",
                "properties": { "staged": { "type": "boolean" } },
                "additionalProperties": false
            }),
        ),
        tool_def(
            "web_fetch",
            "Fetch one public HTTP(S) URL; private/reserved IPs are blocked, DNS is pinned, redirects are returned but never followed, and response bodies are capped at 50 KB.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "maxLength": 8192, "description": "Public http(s) URL without embedded credentials (maximum 8 KB)" },
                    "method": { "type": "string", "enum": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method (default GET)" },
                    "body": { "type": "string", "maxLength": 1000000, "description": "Optional UTF-8 request body (maximum 1 MB)" },
                    "headers": { "type": "object", "maxProperties": 64, "additionalProperties": { "type": "string" } },
                    "timeout_ms": { "type": "integer", "minimum": 1, "maximum": 120000, "description": "Request timeout (default 30000)" },
                    "timeoutMs": { "type": "integer", "minimum": 1, "maximum": 120000, "description": "Deprecated camelCase alias for timeout_ms" }
                },
                "required": ["url"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "memory_recall",
            "Search long-term memories with the platform provider (currently lexical/token-overlap search, not guaranteed semantic search).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "maxLength": 8192, "description": "Natural language search query (maximum 8 KB)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 10, "description": "Max results (default: 5); text excerpts are capped at 2 KB" }
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
                    "text": { "type": "string", "maxLength": 20000, "description": "Information to remember (maximum 20 KB UTF-8)" },
                    "key": { "type": "string", "maxLength": 512, "description": "Optional explicit memory key (maximum 512 UTF-8 bytes)" },
                    "category": {
                        "type": "string",
                        "enum": ["preference", "fact", "decision", "entity", "other"],
                        "description": "Optional category stored as metadata (not automatically inferred)"
                    },
                    "metadata": {
                        "type": "object",
                        "maxProperties": 256,
                        "description": "Optional metadata object (maximum 16 KB)"
                    }
                },
                "required": ["text"],
                "additionalProperties": false
            }),
        ),
        tool_def(
            "memory_forget",
            "Delete only by exact key. A query performs lookup and returns candidates without deleting anything.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "maxLength": 8192, "description": "Search only; returns candidate keys and never deletes by itself (maximum 8 KB)" },
                    "key": { "type": "string", "maxLength": 512, "description": "Specific memory key to delete (maximum 512 UTF-8 bytes)" }
                },
                "additionalProperties": false
            }),
        ),
        tool_def(
            "memory_search",
            "Search stored memories using the platform provider (currently lexical/token-overlap search; the engine does not calculate embeddings).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "maxLength": 8192, "description": "Search query (maximum 8 KB)" },
                    "maxResults": { "type": "integer", "minimum": 1, "maximum": 10, "description": "Max results (default: 5); text excerpts are capped at 2 KB" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 10, "description": "Deprecated alias for maxResults" }
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
                    "prefix": { "type": "string", "maxLength": 512, "description": "Only return keys starting with this prefix (maximum 512 bytes)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Maximum number of keys to return (default: 50)" }
                },
                "additionalProperties": false
            }),
        ),
        tool_def(
            "manage_cron",
            "List up to 20 scheduled jobs; history accepts limit 1–50. Create requires a name, a prompt or an existing skillId, and either a schedule object, atMs, everyMs, everyMinutes, or inMinutes. Mutations ask for approval by default. pause/disable, resume/enable, and delete/remove are aliases.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "delete", "remove", "pause", "disable", "resume", "enable", "run", "history", "status", "help"] },
                    "name": { "type": "string", "maxLength": 200 },
                    "schedule": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["at", "every"] },
                            "atMs": { "type": "integer", "minimum": 0, "description": "Required for kind=at: non-negative epoch milliseconds" },
                            "everyMs": { "type": "integer", "minimum": 1, "description": "Required for kind=every: positive interval in milliseconds" },
                            "anchorMs": { "type": "integer", "minimum": 0, "description": "Optional kind=every schedule origin; a future anchor is the first run" }
                        },
                        "required": ["kind"],
                        "additionalProperties": false,
                        "description": "Use {kind: 'at', atMs: epoch_ms} for a one-shot or {kind: 'every', everyMs: positive_ms, anchorMs?: epoch_ms} for a recurring schedule"
                    },
                    "prompt": { "type": "string", "maxLength": 50000 },
                    "skillId": { "type": "string", "maxLength": 512 },
                    "id": { "type": "string", "maxLength": 512 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "History max: 1–50; the job list is hard-capped at 20" },
                    "atMs": { "type": "integer", "minimum": 0 },
                    "everyMs": { "type": "integer", "minimum": 1 },
                    "everyMinutes": { "type": "integer", "minimum": 1 },
                    "inMinutes": { "type": "integer", "minimum": 0 },
                    "notificationTitle": { "type": "string", "maxLength": 512 }
                },
                "required": ["action"],
                "additionalProperties": false
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
            let key = if key.trim().is_empty() { "test-generated-key".to_string() } else { key };
            let metadata = metadata_json
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
            serde_json::json!({
                "success": true,
                "key": key,
                "text": text,
                "metadata": metadata,
            })
            .to_string()
        }

        fn recall(&self, _query: String, _limit: u32) -> String {
            serde_json::json!([]).to_string()
        }

        fn forget(&self, key: String) -> String {
            serde_json::json!({
                "success": true,
                "key": key,
            })
            .to_string()
        }

        fn search(&self, _query: String, _max_results: u32) -> String {
            serde_json::json!([]).to_string()
        }

        fn list(&self, _prefix: Option<String>, _limit: Option<u32>) -> String {
            "[]".into()
        }
    }

    struct CandidateMemoryProvider {
        forget_called: Arc<std::sync::atomic::AtomicBool>,
    }

    impl MemoryProvider for CandidateMemoryProvider {
        fn store(&self, _key: String, _text: String, _metadata_json: Option<String>) -> String {
            r#"{"success":true}"#.into()
        }
        fn recall(&self, _query: String, _limit: u32) -> String {
            "[]".into()
        }
        fn forget(&self, key: String) -> String {
            self.forget_called.store(true, std::sync::atomic::Ordering::SeqCst);
            serde_json::json!({ "success": true, "key": key }).to_string()
        }
        fn search(&self, _query: String, _max_results: u32) -> String {
            serde_json::json!([{ "key": "exact-key", "text": "candidate memory", "score": 1.0 }]).to_string()
        }
        fn list(&self, _prefix: Option<String>, _limit: Option<u32>) -> String {
            "[]".into()
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

    #[test]
    fn definitions_only_advertise_shell_where_process_spawning_is_supported() {
        let tools = get_tool_definitions("", None);
        let has_shell = tools.iter().any(|tool| tool.name == "execute_command");
        #[cfg(target_os = "ios")]
        assert!(!has_shell, "iOS cannot launch a shell process");
        #[cfg(not(target_os = "ios"))]
        assert!(has_shell, "non-iOS hosts may expose the shell tool");
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
        assert_eq!(result["key"], "test-generated-key");
        assert_eq!(result["text"], "hello");
        assert_eq!(result["metadata"]["category"], "fact");
    }

    #[tokio::test]
    async fn memory_list_returns_a_validated_array_of_exact_keys() {
        let provider: Arc<dyn MemoryProvider> = Arc::new(TestMemoryProvider);
        let result = execute_tool(
            "memory_list",
            &serde_json::json!({ "limit": 2 }),
            "",
            "",
            Some(&provider),
        )
        .await
        .unwrap();
        assert_eq!(result, serde_json::json!([]));
    }

    #[tokio::test]
    async fn query_based_memory_forget_only_returns_candidates() {
        let forget_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let provider: Arc<dyn MemoryProvider> = Arc::new(CandidateMemoryProvider {
            forget_called: forget_called.clone(),
        });
        let result = execute_tool(
            "memory_forget",
            &serde_json::json!({ "query": "candidate memory" }),
            "",
            "",
            Some(&provider),
        )
        .await
        .unwrap();

        assert_eq!(result["action"], "candidates");
        assert_eq!(result["candidates"][0]["key"], "exact-key");
        assert_eq!(forget_called.load(std::sync::atomic::Ordering::SeqCst), false);
    }

    #[test]
    fn memory_search_preserves_provider_truncation_and_sanitizes_result_bounds() {
        let (items, provider_truncated) = parse_memory_search_results(
            r#"{"results":[{"key":"k","text":"x"}],"truncated":true}"#,
        )
        .unwrap();
        assert!(provider_truncated);
        assert_eq!(items.len(), 1);

        let long_text = "আমি".repeat(1_000);
        let item = serde_json::json!({
            "key": "k",
            "text": long_text,
            "score": 2.5,
            "metadata": { "large": "x".repeat(2_000) },
            "untrustedExtra": "must not escape the stable memory result contract"
        });
        let (bounded, truncated) = cap_memory_results(vec![item], 10).unwrap();
        assert!(truncated);
        assert_eq!(bounded.len(), 1);
        assert_eq!(bounded[0]["key"], "k");
        assert!(bounded[0]["text"].as_str().unwrap().len() <= 2_000);
        assert_eq!(bounded[0]["textTruncated"], true);
        assert_eq!(bounded[0]["metadataTruncated"], true);
        assert!(bounded[0].get("untrustedExtra").is_none());

        assert!(cap_memory_results(vec![serde_json::json!("not an object")], 1).is_err());
        assert!(cap_memory_results(
            vec![serde_json::json!({ "key": "k".repeat(MAX_MEMORY_KEY_BYTES + 1) })],
            1
        )
        .is_err());
        for key in ["", "   "] {
            assert!(cap_memory_results(
                vec![serde_json::json!({ "key": key, "text": "invalid" })],
                1
            )
            .is_err());
        }
        assert!(parse_memory_search_results("not-json").is_err());
        assert!(parse_memory_json(&"x".repeat(MAX_MEMORY_PROVIDER_RESPONSE_BYTES + 1)).is_err());
    }

    #[test]
    fn memory_mutation_and_list_provider_results_follow_bounded_contracts() {
        assert!(parse_memory_operation_result("store", r#"{"success":true,"key":"k"}"#).is_ok());
        assert!(parse_memory_operation_result("forget", r#"{"error":"not found"}"#).is_ok());
        assert!(parse_memory_operation_result("store", "[]").is_err());
        assert!(parse_memory_operation_result("store", r#"{"success":"yes"}"#).is_err());

        assert_eq!(parse_memory_list_result(r#"["k1","k2"]"#, 2).unwrap(), serde_json::json!(["k1", "k2"]));
        assert!(parse_memory_list_result(r#"["k1","k2"]"#, 1).is_err());
        assert!(parse_memory_list_result(r#"["   "]"#, 1).is_err());
        assert!(parse_memory_list_result(r#"{"error":"provider unavailable"}"#, 1).is_ok());
        let long_error = serde_json::json!({ "error": "x".repeat(2_000) }).to_string();
        let error = parse_memory_list_result(&long_error, 1).unwrap();
        assert!(error["error"].as_str().unwrap().len() <= 1_000);
        assert_eq!(error["errorTruncated"], true);
    }

    #[test]
    fn tool_schemas_accept_documented_compatibility_aliases() {
        assert!(validate_tool_arguments(
            "memory_search",
            &serde_json::json!({ "query": "vacation", "limit": 3 })
        )
        .is_ok());
        assert!(validate_tool_arguments(
            "web_fetch",
            &serde_json::json!({ "url": "https://example.com", "timeoutMs": 1_000 })
        )
        .is_ok());
        assert!(validate_tool_arguments(
            "execute_command",
            &serde_json::json!({ "command": "echo ok", "timeoutMs": 1_000 })
        )
        .is_ok());
        assert!(validate_tool_arguments(
            "list_files",
            &serde_json::json!({ "path": ".", "unexpected": true })
        )
        .is_err());
        assert!(validate_tool_arguments(
            "manage_cron",
            &serde_json::json!({
                "action": "create",
                "name": "test",
                "prompt": "check",
                "schedule": { "kind": "every", "everyMs": 60_000 }
            })
        )
        .is_ok());
        assert!(validate_tool_arguments(
            "manage_cron",
            &serde_json::json!({
                "action": "create",
                "name": "test",
                "prompt": "check",
                "schedule": { "kind": "daily", "everyMs": 60_000 }
            })
        )
        .is_err());
        assert!(validate_tool_arguments(
            "manage_cron",
            &serde_json::json!({
                "action": "create",
                "name": "test",
                "prompt": "check",
                "schedule": { "kind": "every", "everyMs": 0 }
            })
        )
        .is_err());
        assert!(validate_tool_arguments(
            "manage_cron",
            &serde_json::json!({
                "action": "create",
                "name": "test",
                "prompt": "check",
                "schedule": { "kind": "every", "everyMs": 60_000, "unexpected": true }
            })
        )
        .is_err());
    }

    #[test]
    fn cron_create_rejects_ambiguous_or_incomplete_schedules_without_inserting() {
        let db_path = std::env::temp_dir().join(format!(
            "nk-cron-validation-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db_path_str = db_path.to_string_lossy().into_owned();

        let ambiguous = tool_manage_cron(
            &serde_json::json!({
                "action": "create",
                "name": "ambiguous",
                "prompt": "run",
                "everyMs": 60_000,
                "inMinutes": 5
            }),
            &db_path_str,
        )
        .unwrap_err();
        assert!(ambiguous.to_string().contains("exactly one"));

        let incomplete = tool_manage_cron(
            &serde_json::json!({
                "action": "create",
                "name": "incomplete",
                "prompt": "run",
                "schedule": { "kind": "at" }
            }),
            &db_path_str,
        )
        .unwrap_err();
        assert!(incomplete.to_string().contains("Schedule must"));

        let conn = crate::db::open_db(&db_path_str).unwrap();
        crate::db::ensure_schema(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cron_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(conn);
        std::fs::remove_file(&db_path).ok();
    }

    #[test]
    fn memory_input_and_schema_collection_limits_are_enforced() {
        let oversized_text = "x".repeat(MAX_MEMORY_TEXT_BYTES + 1);
        assert!(validate_memory_tool_sizes(
            "memory_store",
            &serde_json::json!({"text": oversized_text})
        )
        .is_err());

        let oversized_pattern = "x".repeat(MAX_REGEX_BYTES + 1);
        assert!(validate_tool_arguments(
            "grep_files",
            &serde_json::json!({"pattern": oversized_pattern})
        )
        .is_err());

        let files = vec!["a.txt"; 101];
        assert!(validate_tool_arguments(
            "git_commit",
            &serde_json::json!({"message": "test", "files": files})
        )
        .is_err());
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
    fn create_only_refuses_to_overwrite_an_existing_file() {
        let d = dir();
        let target = d.join("notes.txt");
        write_file_atomic(&target, "original").unwrap();
        let err = write_file_create_new(&target, "replacement").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn create_only_adds_a_new_file_without_leaving_a_temp_file() {
        let d = dir();
        let target = d.join("new.txt");
        write_file_create_new(&target, "নতুন 🇧🇩").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "নতুন 🇧🇩");
        let leftovers: Vec<_> = std::fs::read_dir(&d).unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left temp files: {leftovers:?}");
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
mod file_delete_tests {
    use super::*;

    fn temp_workspace(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nk-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn delete_file_removes_only_the_requested_regular_workspace_file() {
        let root = temp_workspace("delete");
        let file = root.join("notes.txt");
        std::fs::write(&file, "delete me").unwrap();
        let result = execute_tool(
            "delete_file",
            &serde_json::json!({ "path": "notes.txt" }),
            root.to_str().unwrap(),
            "",
            None,
        )
        .await
        .unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["path"], "notes.txt");
        assert_eq!(result["deletedBytes"], 9);
        assert!(!file.exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn delete_file_rejects_directories_and_workspace_root() {
        let root = temp_workspace("delete-dir");
        std::fs::create_dir(root.join("folder")).unwrap();
        for path in ["folder", "."] {
            let err = execute_tool(
                "delete_file",
                &serde_json::json!({ "path": path }),
                root.to_str().unwrap(),
                "",
                None,
            )
            .await
            .unwrap_err();
            assert!(err.to_string().contains("regular files") || err.to_string().contains("file path"));
        }
        assert!(root.join("folder").is_dir());
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn delete_file_rejects_absolute_and_parent_traversal_paths() {
        let root = temp_workspace("delete-path");
        let outside = root.with_extension("outside.txt");
        std::fs::write(&outside, "keep").unwrap();
        for path in ["../outside.txt", outside.to_str().unwrap()] {
            let err = execute_tool(
                "delete_file",
                &serde_json::json!({ "path": path }),
                root.to_str().unwrap(),
                "",
                None,
            )
            .await
            .unwrap_err();
            assert!(err.to_string().contains("Access denied"));
        }
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_file(outside).ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_file_refuses_symlinks_and_symlinked_parent_escapes() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace("delete-symlink");
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        std::fs::write(&target, "keep target").unwrap();
        symlink(&target, &link).unwrap();
        let err = execute_tool(
            "delete_file",
            &serde_json::json!({ "path": "link.txt" }),
            root.to_str().unwrap(),
            "",
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("symbolic link"));
        assert!(link.symlink_metadata().is_ok());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep target");

        let outside_dir = root.with_extension("outside-dir");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside_file = outside_dir.join("keep.txt");
        std::fs::write(&outside_file, "outside").unwrap();
        symlink(&outside_dir, root.join("escape")).unwrap();
        let err = execute_tool(
            "delete_file",
            &serde_json::json!({ "path": "escape/keep.txt" }),
            root.to_str().unwrap(),
            "",
            None,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("outside workspace"));
        assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");

        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(outside_dir).ok();
    }

    #[tokio::test]
    async fn read_file_chunks_preserve_utf8_and_require_character_boundary_offsets() {
        let root = temp_workspace("read-chunks");
        let content = "বাংলা🙂".repeat(9_000);
        std::fs::write(root.join("bangla.txt"), &content).unwrap();

        let mut combined = String::new();
        let mut offset = 0u64;
        loop {
            let result = execute_tool(
                "read_file",
                &serde_json::json!({ "path": "bangla.txt", "offset_bytes": offset, "limit_bytes": 50_000 }),
                root.to_str().unwrap(),
                "",
                None,
            )
            .await
            .unwrap();
            assert!(result.get("error").is_none(), "unexpected read error: {result}");
            let chunk = result["content"].as_str().unwrap();
            combined.push_str(chunk);
            if !result["truncated"].as_bool().unwrap() { break; }
            let next = result["nextOffsetBytes"].as_u64().unwrap();
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(combined, content);

        let middle = execute_tool(
            "read_file",
            &serde_json::json!({ "path": "bangla.txt", "offset_bytes": 1, "limit_bytes": 100 }),
            root.to_str().unwrap(),
            "",
            None,
        )
        .await
        .unwrap();
        assert!(middle["error"].as_str().unwrap().contains("character boundary"));
        std::fs::remove_dir_all(root).ok();
    }
}

#[cfg(test)]
mod file_listing_tests {
    use super::*;

    fn temp_workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "nk-list-skipped-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(path.join("node_modules/example")).unwrap();
        std::fs::create_dir_all(path.join(".git")).unwrap();
        std::fs::write(path.join("normal.txt"), "visible").unwrap();
        std::fs::write(path.join("node_modules/example/package.json"), "{}\n").unwrap();
        std::fs::write(path.join(".git/config"), "[core]\n").unwrap();
        path
    }

    #[tokio::test]
    async fn generated_directories_are_hidden_by_default_but_explicitly_browsable_and_searchable() {
        let root = temp_workspace();
        let workspace = root.to_str().unwrap();
        let defaults = execute_tool(
            "list_files",
            &serde_json::json!({ "path": "." }),
            workspace,
            "",
            None,
        )
        .await
        .unwrap();
        assert!(defaults["entries"].as_array().unwrap().iter().all(|entry| entry["name"] != "node_modules"));

        let inclusive = execute_tool(
            "list_files",
            &serde_json::json!({ "path": ".", "include_skipped": true }),
            workspace,
            "",
            None,
        )
        .await
        .unwrap();
        assert!(inclusive["entries"].as_array().unwrap().iter().any(|entry| entry["name"] == "node_modules"));
        assert!(inclusive["entries"].as_array().unwrap().iter().any(|entry| entry["name"] == ".git"));

        let hidden_search = execute_tool(
            "find_files",
            &serde_json::json!({ "pattern": "config", "path": "." }),
            workspace,
            "",
            None,
        )
        .await
        .unwrap();
        assert_eq!(hidden_search["returned"], 0);

        let inclusive_search = execute_tool(
            "find_files",
            &serde_json::json!({ "pattern": "config", "path": ".", "include_skipped": true }),
            workspace,
            "",
            None,
        )
        .await
        .unwrap();
        assert!(inclusive_search["files"].as_array().unwrap().iter().any(|item| item["path"] == ".git/config"));
        std::fs::remove_dir_all(root).ok();
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

    #[tokio::test]
    async fn non_http_schemes_are_refused() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "gopher://example.com",
            "data:text/plain,hello",
        ] {
            let err = ensure_url_is_fetchable(url).await.unwrap_err();
            assert!(
                format!("{err:?}").contains("only http and https"),
                "{url} -> {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn literal_private_hosts_are_refused_without_needing_dns() {
        for url in [
            "http://127.0.0.1:8080/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/",
            "http://[::1]:9000/",
            "http://192.168.0.1/router",
        ] {
            assert!(
                ensure_url_is_fetchable(url).await.is_err(),
                "{url} must be refused"
            );
        }
    }

    #[tokio::test]
    async fn a_malformed_url_is_refused_rather_than_panicking() {
        assert!(ensure_url_is_fetchable("not a url").await.is_err());
        assert!(ensure_url_is_fetchable("").await.is_err());
        assert!(ensure_url_is_fetchable("http://").await.is_err());
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
    fn grep_marks_when_the_global_byte_budget_is_exhausted() {
        let ws = workspace();
        let mut state = WalkState::new();
        state.scanned_bytes = MAX_GREP_TOTAL_BYTES;
        let mut matches = Vec::new();
        grep_file(
            &ws.join("sub/ok.txt"),
            &regex::Regex::new("hi").unwrap(),
            &mut matches,
            &std::fs::canonicalize(&ws).unwrap(),
            &mut state,
        );
        assert!(state.truncated);
        assert!(matches.is_empty());
        std::fs::remove_dir_all(ws).ok();
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
