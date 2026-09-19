//! Agent loop — direct port of mobile-claw AgentRunner.run().
//!
//! Runs LLM completion in a loop: prompt -> stream response -> execute tools -> repeat.
//! Matches the JS behavior: maxTurns, retry with backoff, abort flag.

use crate::event_bus;
use crate::llm_driver::{AnthropicDriver, CompletionRequest, LlmDriver, LlmError, StreamEvent};
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
    pub approval_sender: Arc<Mutex<Option<oneshot::Sender<ApprovalResponse>>>>,
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
            break;
        }

        let mut tool_results: Vec<ContentBlock> = vec![];

        for tool_call in &response.tool_calls {
            if wall_clock_timeout_reached(&ctx, started_at) {
                break;
            }
            ensure_not_aborted(&ctx.abort_flag).await?;
            event_bus::emit_tool_use(callback, &tool_call.name, &tool_call.id, &tool_call.input, &ctx.session_key);

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
                let require_biometric = db_permissions.get(&tool_call.name)
                    .map(|(p, _)| p == "always_ask_biometric")
                    .unwrap_or(false);
                let approval = wait_for_approval(
                    callback,
                    &tool_call.name,
                    &tool_call.id,
                    &tool_call.input,
                    &ctx.approval_sender,
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

            let (content, is_error) = if tool_runner::is_builtin_tool(&tool_call.name) {
                match tool_runner::execute_tool(
                    &tool_call.name,
                    &tool_call.input,
                    &ctx.config.workspace_path,
                    ctx.memory_provider.as_ref(),
                )
                .await
                {
                    Ok(val) => (serde_json::to_string(&val).unwrap_or_default(), false),
                    Err(e) => (e.to_string(), true),
                }
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
    approval_sender: &Arc<Mutex<Option<oneshot::Sender<ApprovalResponse>>>>,
    abort_flag: &Arc<Mutex<bool>>,
    require_biometric: bool,
    session_key: &str,
) -> Result<ApprovalResponse, NativeAgentError> {
    let (tx, rx) = oneshot::channel();
    {
        let mut sender = approval_sender.lock().await;
        *sender = Some(tx);
    }
    event_bus::emit_approval_request(callback, tool_name, tool_call_id, args, require_biometric, session_key);

    tokio::select! {
        result = rx => {
            result.map_err(|_| NativeAgentError::Agent {
                msg: format!("Approval channel closed for tool '{}'", tool_call_id),
            })
        }
        _ = wait_until_cancelled(abort_flag) => {
            let mut sender = approval_sender.lock().await;
            *sender = None;
            Err(NativeAgentError::Cancelled)
        }
    }
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
        return policy != "always_allow";
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

                let delay = std::cmp::min(BASE_DELAY_MS * 2u64.pow(attempt), MAX_DELAY_MS);
                let jitter = delay / 2 + (rand_u64() % (delay / 2 + 1));

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
        other => Err(NativeAgentError::Agent {
            msg: format!("Unsupported provider: {}", other),
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
mod tests {
    use super::*;

    #[tokio::test]
    async fn approval_roundtrip_sends_payload() {
        let sender = Arc::new(Mutex::new(None));
        let abort_flag = Arc::new(Mutex::new(false));
        let sender_for_task = sender.clone();
        let abort_for_task = abort_flag.clone();

        let task = tokio::spawn(async move {
            wait_for_approval(
                None,
                "write_file",
                "toolu_1",
                &serde_json::json!({"path": "a.txt"}),
                &sender_for_task,
                &abort_for_task,
                false,
                "test-session",
            )
            .await
            .unwrap()
        });

        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        let tx = sender.lock().await.take().unwrap();
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
            },
            ToolDefinition {
                name: "native_tool".to_string(),
                description: "Native".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                webview_only: false,
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
