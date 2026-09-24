//! Agent loop — direct port of mobile-claw AgentRunner.run().
//!
//! Runs LLM completion in a loop: prompt -> stream response -> execute tools -> repeat.
//! Matches the JS behavior: maxTurns, retry with backoff, abort flag.

use crate::event_bus;
use crate::llm_driver::{
    AnthropicDriver, CompletionRequest, LlmDriver, LlmError, OpenAiDriver, StreamEvent,
};
use crate::tool_runner;
use crate::types::{
    ApprovalResponse, ContentBlock, InitConfig, McpToolResult, Message, MessageContent,
    SendMessageParams, StopReason, TokenUsage, ToolDefinition,
};
use crate::NativeAgentError;
use crate::MemoryProvider;
use crate::NativeEventCallback;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

const DEFAULT_MAX_TOKENS: u32 = 8192;
const DEFAULT_MAX_TURNS: u32 = 25;
const MAX_RETRIES: u32 = 2;
const BASE_DELAY_MS: u64 = 2000;
const MAX_DELAY_MS: u64 = 30000;
const ABORT_POLL_MS: u64 = 100;

/// Result of an agent turn — usage + serialized messages for persistence.
pub struct AgentTurnResult {
    pub usage: TokenUsage,
    pub messages_json: String,
    pub messages: Vec<Message>,
    pub model: String,
}

pub struct AgentLoopContext<'a> {
    pub config: &'a InitConfig,
    pub params: &'a SendMessageParams,
    pub callback: Option<Arc<dyn NativeEventCallback>>,
    pub abort_flag: Arc<Mutex<bool>>,
    pub is_background: bool,
    pub wall_clock_timeout_ms: Option<u64>,
    pub prior_messages: Option<Vec<Message>>,
    /// Pending tool approvals, keyed by `tool_call_id`.
    ///
    /// This used to be a single `Option<Sender>`. Claude routinely emits several
    /// tool_use blocks in one turn, and each new request overwrote the previous
    /// one, so `respondToApproval` could resolve a *different* tool than the one
    /// the user was looking at — approving `read_file` could run
    /// `execute_command`. Keyed pending map, same shape as `mcp_pending`.
    pub approval_senders: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalResponse>>>>,
    pub steer_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    pub mcp_tools: Arc<Mutex<Vec<ToolDefinition>>>,
    pub mcp_pending: Arc<Mutex<HashMap<String, oneshot::Sender<McpToolResult>>>>,
    pub memory_provider: Option<Arc<dyn MemoryProvider>>,
    /// When true, suppress the `user_message` event for the prompt.
    /// Used by skill kickoffs to hide the internal instruction from the chat UI.
    pub skip_user_echo: bool,
    /// Session key for this agent turn. Included in every emitted event so
    /// consumers can filter stale events during skill transitions.
    pub session_key: String,
}

/// Run one agent turn (prompt -> LLM -> tools -> ... -> done).
/// Returns usage + messages JSON for session persistence.
pub async fn run_agent_turn(
    ctx: AgentLoopContext<'_>,
) -> Result<AgentTurnResult, NativeAgentError> {
    let callback = ctx.callback.as_deref();
    let started_at = std::time::Instant::now();

    let provider = ctx.params.provider.as_deref().unwrap_or("anthropic");
    let auth = crate::auth::get_auth_token(&ctx.config.auth_profiles_path, provider)?;
    let api_key = auth.api_key.ok_or_else(|| NativeAgentError::Auth {
        msg: format!("No API key for provider '{}'", provider),
    })?;

    let model = ctx
        .params
        .model
        .as_deref()
        .unwrap_or(default_model(provider));
    let driver = create_driver(provider, &api_key)?;

    let max_turns = ctx.params.max_turns.unwrap_or(DEFAULT_MAX_TURNS);
    let mut messages = ctx.prior_messages.clone().unwrap_or_default();
    let mut cumulative_usage = TokenUsage::default();

    if !ctx.params.prompt.trim().is_empty() {
        messages.push(Message::user(&ctx.params.prompt));
        if !ctx.skip_user_echo {
            event_bus::emit(
                callback,
                "user_message",
                &serde_json::json!({
                    "text": ctx.params.prompt,
                    "sessionKey": ctx.session_key,
                }),
            );
        }
    }

    // Parse allowed tools for skill sessions — used to skip approval
    let skill_tools: Option<HashSet<String>> = ctx
        .params
        .allowed_tools_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .map(|v| v.into_iter().collect());

    // Load tool permissions from DB for approval decisions (works in background without WebView)
    let db_permissions = crate::db::open_db(&ctx.config.db_path)
        .and_then(|conn| crate::db::load_tool_permissions_map(&conn))
        .unwrap_or_default();

    let mut turn_count: u32 = 0;

    loop {
        if wall_clock_timeout_reached(&ctx, started_at) {
            break;
        }
        ensure_not_aborted(&ctx.abort_flag).await?;
        apply_steer_messages(&ctx.steer_rx, &mut messages).await;

        let req = CompletionRequest {
            model: model.to_string(),
            messages: messages.clone(),
            tools: merged_tool_definitions(
                &ctx.config.workspace_path,
                ctx.params.allowed_tools_json.as_deref(),
                &ctx.mcp_tools,
                ctx.is_background,
            )
            .await,
            max_tokens: DEFAULT_MAX_TOKENS,
            temperature: 0.0,
            system: Some(ctx.params.system_prompt.clone()),
        };

        let response = call_with_retry(&*driver, &req, callback, &ctx.abort_flag, &ctx.session_key).await?;

        cumulative_usage.input_tokens += response.usage.input_tokens;
        cumulative_usage.output_tokens += response.usage.output_tokens;
        cumulative_usage.total_tokens += response.usage.total_tokens;

        messages.push(Message::assistant_blocks(response.content.clone()));
        turn_count += 1;

        if response.stop_reason != StopReason::ToolUse || response.tool_calls.is_empty() {
            break;
        }

        if turn_count >= max_turns {
            event_bus::emit(
                callback,
                "max_turns_reached",
                &serde_json::json!({
                    "turns": turn_count,
                    "sessionKey": ctx.session_key,
                }),
            );
            // Same hazard as the wall-clock timeout below: the assistant
            // message just pushed carries one `tool_use` block per pending
            // call, and the Messages API rejects a transcript where a
            // `tool_use` has no matching `tool_result` ("tool_use ids were
            // found without tool_result blocks"). Breaking straight out left
            // the saved session permanently un-resumable — every later turn
            // 400'd with no way back. Close each pending call with a synthetic
            // result before stopping, so the persisted transcript stays valid.
            let closing: Vec<ContentBlock> = response
                .tool_calls
                .iter()
                .map(|tool_call| {
                    let content = format!(
                        "Tool not executed: the turn limit of {} was reached before this call could run.",
                        max_turns
                    );
                    event_bus::emit_tool_result(
                        callback,
                        &tool_call.name,
                        &tool_call.id,
                        &serde_json::json!({ "content": content, "isError": true }),
                        &ctx.session_key,
                    );
                    ContentBlock::ToolResult {
                        tool_use_id: tool_call.id.clone(),
                        content,
                        is_error: true,
                    }
                })
                .collect();
            if !closing.is_empty() {
                messages.push(Message {
                    role: crate::types::Role::User,
                    content: MessageContent::Blocks(closing),
                });
            }
            break;
        }

        let mut tool_results: Vec<ContentBlock> = vec![];
        // Set when the wall-clock budget runs out mid-loop. We must NOT just
        // `break`: the assistant message already contains one `tool_use` block
        // per call, and the Anthropic Messages API rejects any request where a
        // `tool_use` has no matching `tool_result` ("tool_use ids were found
        // without tool_result blocks"). Breaking early therefore left the
        // session permanently un-resumable — every later message 400'd. Instead
        // we stop doing real work but still synthesise a result for each
        // remaining call, so the transcript stays valid.
        let mut timed_out = false;

        for tool_call in &response.tool_calls {
            if timed_out || wall_clock_timeout_reached(&ctx, started_at) {
                timed_out = true;
                let content =
                    "Tool call skipped: the turn exceeded its wall-clock budget.".to_string();
                event_bus::emit_tool_result(
                    callback,
                    &tool_call.name,
                    &tool_call.id,
                    &serde_json::json!({ "content": content, "isError": true }),
                    &ctx.session_key,
                );
                tool_results.push(ContentBlock::ToolResult {
                    tool_use_id: tool_call.id.clone(),
                    content,
                    is_error: true,
                });
                continue;
            }
            ensure_not_aborted(&ctx.abort_flag).await?;

            // NOTE: `tool_use` is deliberately emitted *after* the disabled and
            // approval gates (further down), not here. Emitting it up front made
            // the UI announce "running execute_command…" for calls that were then
            // refused, and left that phantom entry in the audit trail with no
            // cancel signal to retract it.

            // Check if tool is disabled in permissions DB
            if let Some((_, false)) = db_permissions.get(&tool_call.name) {
                let content = format!("Tool \"{}\" is disabled in tool settings.", tool_call.name);
                event_bus::emit_tool_result(
                    callback,
                    &tool_call.name,
                    &tool_call.id,
                    &serde_json::json!({ "content": content, "isError": true }),
                    &ctx.session_key,
                );
                tool_results.push(ContentBlock::ToolResult {
                    tool_use_id: tool_call.id.clone(),
                    content,
                    is_error: true,
                });
                continue;
            }

            if requires_approval(&tool_call.name, skill_tools.as_ref(), &db_permissions) {
                let require_biometric = db_permissions
                    .get(&tool_call.name)
                    .map(|(p, _)| canonical_permission(p) == "always_ask_biometric")
                    .unwrap_or(false);
                let approval = wait_for_approval(
                    callback,
                    &tool_call.name,
                    &tool_call.id,
                    &tool_call.input,
                    &ctx.approval_senders,
                    &ctx.abort_flag,
                    require_biometric,
                    &ctx.session_key,
                )
                .await?;

                if !approval.approved {
                    let content = approval
                        .reason
                        .unwrap_or_else(|| "Tool execution denied by user.".to_string());
                    event_bus::emit_tool_result(
                        callback,
                        &tool_call.name,
                        &tool_call.id,
                        &serde_json::json!({ "content": content, "isError": true }),
                        &ctx.session_key,
                    );
                    tool_results.push(ContentBlock::ToolResult {
                        tool_use_id: tool_call.id.clone(),
                        content,
                        is_error: true,
                    });
                    continue;
                }
            }

            // Gates passed: the tool really is about to run, so announce it now.
            event_bus::emit_tool_use(
                callback,
                &tool_call.name,
                &tool_call.id,
                &tool_call.input,
                &ctx.session_key,
            );

            let (content, is_error) = if tool_runner::is_builtin_tool(&tool_call.name) {
                match tool_runner::execute_tool(
                    &tool_call.name,
                    &tool_call.input,
                    &ctx.config.workspace_path,
                    &ctx.config.db_path,
                    ctx.memory_provider.as_ref(),
                )
                .await
                {
                    Ok(val) => (serde_json::to_string(&val).unwrap_or_default(), false),
                    Err(e) => (e.to_string(), true),
                }
            } else if !is_registered_mcp_tool(&ctx.mcp_tools, &tool_call.name).await {
                // Dispatch used to be "builtin, otherwise MCP", with no check
                // that the name is actually in the registered catalogue. A model
                // that invents a tool name therefore fell through to the MCP
                // path and blocked the whole turn for the full 30-second
                // timeout, waiting for a WebView response that was never coming
                // — and then reported a misleading "timed out" to the model.
                // Fail immediately and say what is actually wrong, so the model
                // can pick a real tool on the next turn.
                let known = {
                    let mcp = ctx.mcp_tools.lock().await;
                    let mut names: Vec<String> =
                        tool_runner::builtin_tool_names().iter().map(|s| s.to_string()).collect();
                    names.extend(mcp.iter().map(|t| t.name.clone()));
                    names.sort();
                    names.join(", ")
                };
                (
                    format!(
                        "Unknown tool '{}'. It is neither a built-in tool nor a registered MCP \
                         tool. Available tools: {}.",
                        tool_call.name, known
                    ),
                    true,
                )
            } else {
                let result = wait_for_mcp_tool_result(
                    callback,
                    &tool_call.name,
                    &tool_call.id,
                    &tool_call.input,
                    ctx.is_background,
                    &ctx.mcp_pending,
                    &ctx.abort_flag,
                    &ctx.session_key,
                )
                .await?;
                (result.result_json, result.is_error)
            };

            event_bus::emit_tool_result(
                callback,
                &tool_call.name,
                &tool_call.id,
                &serde_json::json!({ "content": content, "isError": is_error }),
                &ctx.session_key,
            );

            tool_results.push(ContentBlock::ToolResult {
                tool_use_id: tool_call.id.clone(),
                content,
                is_error,
            });
        }

        messages.push(Message {
            role: crate::types::Role::User,
            content: MessageContent::Blocks(tool_results),
        });

        // Every tool_use now has its tool_result, so the transcript is valid and
        // we can safely stop.
        if timed_out {
            break;
        }
    }

    let messages_json = serde_json::to_string(&messages).unwrap_or_else(|_| "[]".to_string());

    Ok(AgentTurnResult {
        usage: cumulative_usage,
        messages_json,
        messages,
        model: model.to_string(),
    })
}

fn wall_clock_timeout_reached(ctx: &AgentLoopContext<'_>, started_at: std::time::Instant) -> bool {
    let Some(timeout_ms) = ctx.wall_clock_timeout_ms else {
        return false;
    };
    if started_at.elapsed().as_millis() <= timeout_ms as u128 {
        return false;
    }
    if ctx.is_background {
        event_bus::emit(
            ctx.callback.as_deref(),
            "agent.background_timeout",
            &serde_json::json!({ "timeoutMs": timeout_ms, "sessionKey": ctx.session_key }),
        );
    }
    true
}

async fn merged_tool_definitions(
    workspace_path: &str,
    allowed_json: Option<&str>,
    mcp_tools: &Arc<Mutex<Vec<ToolDefinition>>>,
    is_background: bool,
) -> Vec<ToolDefinition> {
    let builtin = tool_runner::get_tool_definitions(workspace_path, None);
    let builtin_names: HashSet<&str> = builtin.iter().map(|tool| tool.name.as_str()).collect();
    let mut mcp = mcp_tools.lock().await.clone();
    mcp.retain(|tool| !builtin_names.contains(tool.name.as_str()));

    let mut tools = Vec::with_capacity(builtin.len() + mcp.len());
    tools.extend(builtin);
    tools.extend(mcp);

    if is_background {
        tools.retain(|tool| !tool.webview_only);
    }

    let allowed: Option<HashSet<String>> = allowed_json
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .map(|items| items.into_iter().collect());

    match allowed {
        Some(names) if !names.is_empty() => tools
            .into_iter()
            .filter(|tool| names.contains(&tool.name))
            .collect(),
        _ => tools,
    }
}

async fn apply_steer_messages(
    steer_rx: &Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    messages: &mut Vec<Message>,
) {
    let mut receiver_guard = steer_rx.lock().await;
    let Some(receiver) = receiver_guard.as_mut() else {
        return;
    };

    while let Ok(text) = receiver.try_recv() {
        if text.trim().is_empty() {
            continue;
        }
        messages.push(Message::user(&text));
    }
}

async fn wait_for_approval(
    callback: Option<&dyn NativeEventCallback>,
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
    approval_senders: &Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalResponse>>>>,
    abort_flag: &Arc<Mutex<bool>>,
    require_biometric: bool,
    session_key: &str,
) -> Result<ApprovalResponse, NativeAgentError> {
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = approval_senders.lock().await;
        pending.insert(tool_call_id.to_string(), tx);
    }
    event_bus::emit_approval_request(callback, tool_name, tool_call_id, args, require_biometric, session_key);

    tokio::select! {
        result = rx => {
            // Resolved (or the sender was dropped): drop the slot either way.
            approval_senders.lock().await.remove(tool_call_id);
            result.map_err(|_| NativeAgentError::Agent {
                msg: format!("Approval channel closed for tool '{}'", tool_call_id),
            })
        }
        _ = wait_until_cancelled(abort_flag) => {
            approval_senders.lock().await.remove(tool_call_id);
            Err(NativeAgentError::Cancelled)
        }
    }
}

/// Is `name` present in the MCP catalogue the WebView published?
async fn is_registered_mcp_tool(
    mcp_tools: &Arc<Mutex<Vec<ToolDefinition>>>,
    name: &str,
) -> bool {
    mcp_tools.lock().await.iter().any(|t| t.name == name)
}

async fn wait_for_mcp_tool_result(
    callback: Option<&dyn NativeEventCallback>,
    tool_name: &str,
    tool_call_id: &str,
    args: &serde_json::Value,
    is_background: bool,
    mcp_pending: &Arc<Mutex<HashMap<String, oneshot::Sender<McpToolResult>>>>,
    abort_flag: &Arc<Mutex<bool>>,
    session_key: &str,
) -> Result<McpToolResult, NativeAgentError> {
    if is_background {
        return Ok(McpToolResult {
            result_json: r#"{"error":"Tool unavailable (WebView inactive)"}"#.into(),
            is_error: true,
        });
    }

    let (tx, rx) = oneshot::channel();
    {
        let mut pending = mcp_pending.lock().await;
        pending.insert(tool_call_id.to_string(), tx);
    }
    event_bus::emit_mcp_tool_call(callback, tool_name, tool_call_id, args, session_key);

    tokio::select! {
        result = rx => {
            let mut pending = mcp_pending.lock().await;
            pending.remove(tool_call_id);
            result.map_err(|_| NativeAgentError::Agent {
                msg: format!("MCP result channel closed for tool '{}'", tool_call_id),
            })
        }
        _ = tokio::time::sleep(Duration::from_secs(30)) => {
            let mut pending = mcp_pending.lock().await;
            pending.remove(tool_call_id);
            Ok(McpToolResult {
                result_json: r#"{"error":"MCP tool timed out (WebView may be inactive)"}"#.into(),
                is_error: true,
            })
        }
        _ = wait_until_cancelled(abort_flag) => {
            let mut pending = mcp_pending.lock().await;
            pending.remove(tool_call_id);
            Err(NativeAgentError::Cancelled)
        }
    }
}

/// Normalise the permission strings that reach us from JS.
///
/// The engine only ever compared against the exact literal `"always_allow"`,
/// but `definitions.ts` types this field as a free-form `string` and the demo
/// lab seeds `"allow"` / `"ask"`. `"allow" != "always_allow"`, so every
/// pre-approved tool still prompted and the allow-list looked broken. Accept
/// the common spellings and map them onto the canonical policy.
fn canonical_permission(policy: &str) -> &'static str {
    match policy.trim().to_ascii_lowercase().as_str() {
        "always_allow" | "allow" | "allowed" | "auto" | "always" => "always_allow",
        "always_ask_biometric" | "ask_biometric" | "biometric" => "always_ask_biometric",
        // Anything unrecognised is treated as "ask": unknown policies must
        // fail CLOSED, never silently grant access.
        _ => "always_ask",
    }
}

fn requires_approval(
    tool_name: &str,
    skill_tools: Option<&HashSet<String>>,
    db_permissions: &HashMap<String, (String, bool)>,
) -> bool {
    // Skill tools never need approval (matches old JS agent behavior)
    if let Some(allowed) = skill_tools {
        if allowed.contains(tool_name) {
            return false;
        }
    }

    // Check DB-stored permission policy (synced from WebView, persists for background)
    if let Some((policy, _)) = db_permissions.get(tool_name) {
        return canonical_permission(policy) != "always_allow";
    }

    // Fallback for tools not yet in DB: builtin read-only = allow, MCP = ask
    if !tool_runner::is_builtin_tool(tool_name) {
        return true;
    }
    matches!(
        tool_name,
        "write_file" | "edit_file" | "execute_command" | "git_commit" | "manage_cron"
    )
}

async fn ensure_not_aborted(abort_flag: &Arc<Mutex<bool>>) -> Result<(), NativeAgentError> {
    if *abort_flag.lock().await {
        Err(NativeAgentError::Cancelled)
    } else {
        Ok(())
    }
}

async fn wait_until_cancelled(abort_flag: &Arc<Mutex<bool>>) {
    loop {
        if *abort_flag.lock().await {
            return;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(ABORT_POLL_MS)).await;
    }
}

/// Call LLM with retry logic (matches JS withRetry behavior).
async fn call_with_retry(
    driver: &dyn LlmDriver,
    req: &CompletionRequest,
    callback: Option<&dyn NativeEventCallback>,
    abort_flag: &Arc<Mutex<bool>>,
    session_key: &str,
) -> Result<crate::llm_driver::CompletionResponse, NativeAgentError> {
    let mut last_error: Option<LlmError> = None;
    let sk = session_key.to_string();

    for attempt in 0..=MAX_RETRIES {
        ensure_not_aborted(abort_flag).await?;

        let on_event = |event: StreamEvent| match &event {
            StreamEvent::TextDelta(text) => event_bus::emit_text_delta(callback, text, &sk),
            StreamEvent::ThinkingDelta(text) => event_bus::emit_thinking(callback, text, &sk),
            StreamEvent::ToolUseStart { .. } => {}
            StreamEvent::ToolUseEnd { .. } => {}
            StreamEvent::WebSearchStart { query } => {
                event_bus::emit_web_search_start(callback, query, &sk)
            }
            StreamEvent::WebSearchComplete { results_count } => {
                event_bus::emit_web_search_complete(callback, *results_count, &sk)
            }
            StreamEvent::MessageDone(_) => {}
        };

        match driver.stream(req, &on_event).await {
            Ok(response) => return Ok(response),
            Err(e) => {
                if attempt == MAX_RETRIES || !e.is_retryable() {
                    return Err(NativeAgentError::Llm { msg: e.to_string() });
                }

                // Respect a server-supplied cool-off when there is one. The
                // driver decodes `Retry-After` into the error, but this loop
                // used to ignore it and always apply its own exponential
                // backoff — so a "wait 60 s" was retried after ~1 s.
                let server_delay = match &e {
                    LlmError::RateLimited { retry_after_ms }
                    | LlmError::Overloaded { retry_after_ms } => Some(*retry_after_ms),
                    _ => None,
                };
                let backoff = std::cmp::min(BASE_DELAY_MS * 2u64.pow(attempt), MAX_DELAY_MS);
                let jitter = match server_delay {
                    // Honour the server's figure, plus a little jitter so
                    // concurrent clients do not all resume in lockstep.
                    Some(wait) => wait + (rand_u64() % 1_000),
                    None => backoff / 2 + (rand_u64() % (backoff / 2 + 1)),
                };

                event_bus::emit_retry(callback, attempt + 1, jitter, &sk);

                last_error = Some(e);
                tokio::time::sleep(tokio::time::Duration::from_millis(jitter)).await;
            }
        }
    }

    Err(NativeAgentError::Llm {
        msg: last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "Unknown error".to_string()),
    })
}

fn create_driver(provider: &str, api_key: &str) -> Result<Box<dyn LlmDriver>, NativeAgentError> {
    match provider {
        "anthropic" => Ok(Box::new(AnthropicDriver::new(api_key.to_string(), None))),
        "openrouter" => Ok(Box::new(AnthropicDriver::new(
            api_key.to_string(),
            Some("https://openrouter.ai/api".to_string()),
        ))),
        // `openai` was advertised by get_models_json() and default_model() but
        // had no driver, so choosing it always failed with "Unsupported
        // provider". Backed by a real Chat Completions implementation now.
        "openai" => Ok(Box::new(OpenAiDriver::new(api_key.to_string(), None))),
        other => Err(NativeAgentError::Agent {
            msg: format!(
                "Unsupported provider: {}. Supported providers: anthropic, openai, openrouter.",
                other
            ),
        }),
    }
}

fn default_model(provider: &str) -> &str {
    match provider {
        "anthropic" => "claude-sonnet-4-20250514",
        "openrouter" => "anthropic/claude-sonnet-4.5",
        "openai" => "gpt-4o",
        _ => "claude-sonnet-4-20250514",
    }
}

/// Simple pseudo-random u64 (no external dep needed).
fn rand_u64() -> u64 {
    use std::time::SystemTime;
    let seed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let mut x = seed;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

#[cfg(test)]
mod transcript_invariant_tests {
    use super::*;

    /// The invariant the Messages API enforces: in a saved transcript every
    /// `tool_use` id must be answered by a `tool_result` with the same id,
    /// otherwise the next request 400s and the session is unusable forever.
    fn unanswered_tool_uses(messages: &[Message]) -> Vec<String> {
        let mut pending: Vec<String> = Vec::new();
        for m in messages {
            if let MessageContent::Blocks(blocks) = &m.content {
                for b in blocks {
                    match b {
                        ContentBlock::ToolUse { id, .. } => pending.push(id.clone()),
                        ContentBlock::ToolResult { tool_use_id, .. } => {
                            pending.retain(|p| p != tool_use_id);
                        }
                        _ => {}
                    }
                }
            }
        }
        pending
    }

    fn assistant_with_tool_calls(ids: &[&str]) -> Message {
        Message::assistant_blocks(
            ids.iter()
                .map(|id| ContentBlock::ToolUse {
                    id: (*id).to_string(),
                    name: "read_file".into(),
                    input: serde_json::json!({}),
                })
                .collect(),
        )
    }

    /// Mirrors what the max_turns branch now builds.
    fn closing_results(ids: &[&str]) -> Message {
        Message {
            role: crate::types::Role::User,
            content: MessageContent::Blocks(
                ids.iter()
                    .map(|id| ContentBlock::ToolResult {
                        tool_use_id: (*id).to_string(),
                        content: "Tool not executed: the turn limit was reached".into(),
                        is_error: true,
                    })
                    .collect(),
            ),
        }
    }

    #[test]
    fn the_detector_catches_an_orphaned_tool_use() {
        // This is the shape the OLD max_turns path persisted.
        let broken = vec![Message::user("hi"), assistant_with_tool_calls(&["toolu_1"])];
        assert_eq!(
            unanswered_tool_uses(&broken),
            vec!["toolu_1".to_string()],
            "the detector must flag the pre-fix transcript"
        );
    }

    #[test]
    fn closing_every_pending_call_restores_a_valid_transcript() {
        let fixed = vec![
            Message::user("hi"),
            assistant_with_tool_calls(&["toolu_1", "toolu_2"]),
            closing_results(&["toolu_1", "toolu_2"]),
        ];
        assert!(
            unanswered_tool_uses(&fixed).is_empty(),
            "every tool_use must be answered"
        );
    }

    #[test]
    fn answering_only_some_calls_is_still_invalid() {
        // Guards against a partial fix: all pending ids must be closed.
        let partial = vec![
            assistant_with_tool_calls(&["toolu_1", "toolu_2"]),
            closing_results(&["toolu_1"]),
        ];
        assert_eq!(unanswered_tool_uses(&partial), vec!["toolu_2".to_string()]);
    }

    #[test]
    fn a_multi_turn_transcript_stays_balanced() {
        let messages = vec![
            Message::user("hi"),
            assistant_with_tool_calls(&["a1"]),
            closing_results(&["a1"]),
            assistant_with_tool_calls(&["b1", "b2"]),
            closing_results(&["b2", "b1"]), // order must not matter
            Message::assistant_blocks(vec![ContentBlock::Text { text: "done".into() }]),
        ];
        assert!(unanswered_tool_uses(&messages).is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn approval_roundtrip_sends_payload() {
        // Senders are now keyed by tool_call_id (a single slot could deliver a
        // decision to the wrong tool when two approvals were in flight).
        let senders = Arc::new(Mutex::new(HashMap::new()));
        let abort_flag = Arc::new(Mutex::new(false));
        let senders_for_task = senders.clone();
        let abort_for_task = abort_flag.clone();

        let task = tokio::spawn(async move {
            wait_for_approval(
                None,
                "write_file",
                "toolu_1",
                &serde_json::json!({"path": "a.txt"}),
                &senders_for_task,
                &abort_for_task,
                false,
                "test-session",
            )
            .await
            .unwrap()
        });

        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        let tx = senders.lock().await.remove("toolu_1").unwrap();
        tx.send(ApprovalResponse {
            tool_call_id: "toolu_1".to_string(),
            approved: true,
            reason: None,
        })
        .unwrap();

        let response = task.await.unwrap();
        assert!(response.approved);
        assert_eq!(response.tool_call_id, "toolu_1");
    }

    /// The bug BUG-10 fixed: with one shared slot, a decision for tool B could
    /// be handed to tool A. Keyed senders must route each to its own waiter.
    #[tokio::test]
    async fn concurrent_approvals_are_routed_by_tool_call_id() {
        let senders = Arc::new(Mutex::new(HashMap::new()));
        let abort_flag = Arc::new(Mutex::new(false));

        let mut tasks = Vec::new();
        for id in ["toolu_a", "toolu_b"] {
            let s = senders.clone();
            let a = abort_flag.clone();
            tasks.push(tokio::spawn(async move {
                wait_for_approval(
                    None,
                    "write_file",
                    id,
                    &serde_json::json!({}),
                    &s,
                    &a,
                    false,
                    "test-session",
                )
                .await
                .unwrap()
            }));
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        // Answer B first, and deny it, while A is still waiting.
        let tx_b = senders.lock().await.remove("toolu_b").unwrap();
        tx_b.send(ApprovalResponse {
            tool_call_id: "toolu_b".to_string(),
            approved: false,
            reason: Some("nope".to_string()),
        })
        .unwrap();
        let tx_a = senders.lock().await.remove("toolu_a").unwrap();
        tx_a.send(ApprovalResponse {
            tool_call_id: "toolu_a".to_string(),
            approved: true,
            reason: None,
        })
        .unwrap();

        let mut results = Vec::new();
        for t in tasks {
            results.push(t.await.unwrap());
        }
        let a = results.iter().find(|r| r.tool_call_id == "toolu_a").unwrap();
        let b = results.iter().find(|r| r.tool_call_id == "toolu_b").unwrap();
        assert!(a.approved, "A was approved and must stay approved");
        assert!(!b.approved, "B was denied and must stay denied");
    }

    #[tokio::test]
    async fn steer_messages_are_drained_in_order() {
        let (tx, rx) = mpsc::unbounded_channel();
        let steer_rx = Arc::new(Mutex::new(Some(rx)));
        let mut messages = vec![Message::user("original")];

        tx.send("first".to_string()).unwrap();
        tx.send("second".to_string()).unwrap();

        apply_steer_messages(&steer_rx, &mut messages).await;

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1].text(), "first");
        assert_eq!(messages[2].text(), "second");
    }

    #[tokio::test]
    async fn merged_tool_definitions_excludes_webview_tools_in_background() {
        let mcp_tools = Arc::new(Mutex::new(vec![
            ToolDefinition {
                name: "web_tool".to_string(),
                description: "WebView only".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                webview_only: true,
                approval_policy: None,
            },
            ToolDefinition {
                name: "native_tool".to_string(),
                description: "Native".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                webview_only: false,
                approval_policy: None,
            },
        ]));

        let tools =
            merged_tool_definitions("", Some(r#"["web_tool","native_tool"]"#), &mcp_tools, true)
                .await;

        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        assert_eq!(names, vec!["native_tool"]);
    }

    #[tokio::test]
    async fn merged_tool_definitions_prefers_builtin_memory_tools_over_mcp() {
        let mcp_tools = Arc::new(Mutex::new(vec![ToolDefinition {
            name: "memory_recall".to_string(),
            description: "MCP memory".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
            webview_only: true,
            approval_policy: None,
        }]));

        let tools = merged_tool_definitions("", None, &mcp_tools, false).await;
        let memory_recall = tools
            .iter()
            .filter(|tool| tool.name == "memory_recall")
            .collect::<Vec<_>>();

        assert_eq!(memory_recall.len(), 1);
        assert_eq!(
            memory_recall[0].description,
            "Search through long-term memories and return semantically similar entries."
        );
        assert!(!memory_recall[0].webview_only);
    }

    #[tokio::test]
    async fn wait_for_mcp_tool_result_returns_immediate_error_in_background() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let abort_flag = Arc::new(Mutex::new(false));

        let result = wait_for_mcp_tool_result(
            None,
            "web_tool",
            "toolu_1",
            &serde_json::json!({}),
            true,
            &pending,
            &abort_flag,
            "test-session",
        )
        .await
        .unwrap();

        assert!(result.is_error);
        assert_eq!(
            result.result_json,
            r#"{"error":"Tool unavailable (WebView inactive)"}"#
        );
        assert!(pending.lock().await.is_empty());
    }
}
