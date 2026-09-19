//! Event bus — dispatches events from agent loop to UniFFI callback.
//!
//! Every event includes a `sessionKey` so consumers can distinguish events
//! from different agent sessions (e.g. skill A winding down vs. skill B
//! starting up). This prevents stale-event mis-attribution during transitions.

use crate::NativeEventCallback;

/// Emit an event to the callback if present.
pub fn emit(
    callback: Option<&dyn NativeEventCallback>,
    event_type: &str,
    payload: &serde_json::Value,
) {
    if let Some(cb) = callback {
        cb.on_event(event_type.to_string(), payload.to_string());
    }
}

/// Emit a text_delta event.
pub fn emit_text_delta(callback: Option<&dyn NativeEventCallback>, text: &str, session_key: &str) {
    emit(
        callback,
        "text_delta",
        &serde_json::json!({ "text": text, "sessionKey": session_key }),
    );
}

/// Emit a tool_use event.
pub fn emit_tool_use(
    callback: Option<&dyn NativeEventCallback>,
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
    session_key: &str,
) {
    emit(
        callback,
        "tool_use",
        &serde_json::json!({
            "toolName": tool_name,
            "toolCallId": tool_call_id,
            "args": args,
            "sessionKey": session_key,
        }),
    );
}

/// Emit a tool_result event.
pub fn emit_tool_result(
    callback: Option<&dyn NativeEventCallback>,
    tool_name: &str,
    tool_call_id: &str,
    result: &serde_json::Value,
    session_key: &str,
) {
    emit(
        callback,
        "tool_result",
        &serde_json::json!({
            "toolName": tool_name,
            "toolCallId": tool_call_id,
            "result": result,
            "sessionKey": session_key,
        }),
    );
}

/// Emit an approval_request event.
pub fn emit_approval_request(
    callback: Option<&dyn NativeEventCallback>,
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
    require_biometric: bool,
    session_key: &str,
) {
    emit(
        callback,
        "approval_request",
        &serde_json::json!({
            "toolName": tool_name,
            "toolCallId": tool_call_id,
            "args": args,
            "requireBiometric": require_biometric,
            "sessionKey": session_key,
        }),
    );
}

/// Emit an mcp_tool_call event.
pub fn emit_mcp_tool_call(
    callback: Option<&dyn NativeEventCallback>,
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
    session_key: &str,
) {
    emit(
        callback,
        "mcp_tool_call",
        &serde_json::json!({
            "toolName": tool_name,
            "toolCallId": tool_call_id,
            "args": args,
            "sessionKey": session_key,
        }),
    );
}

/// Emit a thinking delta event.
pub fn emit_thinking(callback: Option<&dyn NativeEventCallback>, text: &str, session_key: &str) {
    emit(
        callback,
        "thinking",
        &serde_json::json!({ "text": text, "sessionKey": session_key }),
    );
}

/// Emit a web_search_start event.
pub fn emit_web_search_start(
    callback: Option<&dyn NativeEventCallback>,
    query: &str,
    session_key: &str,
) {
    emit(
        callback,
        "web_search_start",
        &serde_json::json!({ "query": query, "sessionKey": session_key }),
    );
}

/// Emit a web_search_complete event.
pub fn emit_web_search_complete(
    callback: Option<&dyn NativeEventCallback>,
    results_count: u32,
    session_key: &str,
) {
    emit(
        callback,
        "web_search_complete",
        &serde_json::json!({ "resultsCount": results_count, "sessionKey": session_key }),
    );
}

/// Emit retry event.
pub fn emit_retry(
    callback: Option<&dyn NativeEventCallback>,
    attempt: u32,
    delay_ms: u64,
    session_key: &str,
) {
    emit(
        callback,
        "retry",
        &serde_json::json!({
            "attempt": attempt,
            "delayMs": delay_ms,
            "sessionKey": session_key,
        }),
    );
}
