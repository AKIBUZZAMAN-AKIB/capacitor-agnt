//! Native Agent FFI — Rust agent loop for Capacitor mobile apps.
//!
//! Provides the core agent loop, LLM drivers, tool execution, auth management,
//! workspace initialization, and SQLite persistence. Exposed to Kotlin/Swift
//! via UniFFI.

pub mod agent_loop;
pub mod auth;
pub mod config_store;
pub mod db;
pub mod event_bus;
pub mod llm_driver;
pub mod tool_runner;
pub mod types;
pub mod workspace;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

/// Top-level error type exposed via UniFFI.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum NativeAgentError {
    #[error("Agent error: {msg}")]
    Agent { msg: String },
    #[error("Auth error: {msg}")]
    Auth { msg: String },
    #[error("Database error: {msg}")]
    Database { msg: String },
    #[error("LLM error: {msg}")]
    Llm { msg: String },
    #[error("Tool error: {msg}")]
    Tool { msg: String },
    #[error("IO error: {msg}")]
    Io { msg: String },
    #[error("Cancelled")]
    Cancelled,
}

impl From<std::io::Error> for NativeAgentError {
    fn from(e: std::io::Error) -> Self {
        NativeAgentError::Io { msg: e.to_string() }
    }
}

impl From<rusqlite::Error> for NativeAgentError {
    fn from(e: rusqlite::Error) -> Self {
        NativeAgentError::Database { msg: e.to_string() }
    }
}

impl From<serde_json::Error> for NativeAgentError {
    fn from(e: serde_json::Error) -> Self {
        NativeAgentError::Agent { msg: e.to_string() }
    }
}

/// Callback interface for events from the native agent.
#[uniffi::export(callback_interface)]
pub trait NativeEventCallback: Send + Sync {
    /// Called when the agent emits an event.
    /// `event_type`: text_delta, tool_use, tool_result, agent.completed, agent.error, etc.
    /// `payload_json`: JSON-encoded event data.
    fn on_event(&self, event_type: String, payload_json: String);
}

/// Callback interface for platform-native notification delivery.
#[uniffi::export(callback_interface)]
pub trait NativeNotifier: Send + Sync {
    fn send_notification(&self, title: String, body: String, data_json: String) -> String;
}

/// Callback interface for memory operations (LanceDB or any vector store).
/// Implemented by Kotlin/Swift, which bridges to the actual memory backend.
#[uniffi::export(callback_interface)]
pub trait MemoryProvider: Send + Sync {
    fn store(&self, key: String, text: String, metadata_json: Option<String>) -> String;
    fn recall(&self, query: String, limit: u32) -> String;
    fn forget(&self, key: String) -> String;
    fn search(&self, query: String, max_results: u32) -> String;
    fn list(&self, prefix: Option<String>, limit: Option<u32>) -> String;
}

/// Standalone workspace initialization for cold-start paths.
#[uniffi::export]
pub fn init_workspace(config: types::InitConfig) -> Result<(), NativeAgentError> {
    workspace::init_default_files(&config)
}

#[uniffi::export]
pub fn create_handle_from_persisted_config(
    config_path: String,
) -> Result<Arc<NativeAgentHandle>, NativeAgentError> {
    let config = config_store::load_persisted_config(&config_path)?;
    NativeAgentHandle::from_config(config, false)
}

/// Normalise an `allowedTools` value into the JSON-array string the engine
/// expects.
///
/// Callers legitimately provide either a JSON array (`["read_file"]`) or an
/// already-encoded string (`"[\"read_file\"]"`). Only the string form used to
/// be recognised, so the array form silently disabled the whole restriction.
/// Returns `None` only when there is genuinely no restriction to apply.
fn normalize_allowed_tools(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Array(items) => {
            let names: Vec<&str> = items.iter().filter_map(|item| item.as_str()).collect();
            if names.is_empty() {
                // An explicit empty array means "no tools at all"; preserve it
                // rather than falling through to unrestricted.
                Some("[]".to_string())
            } else {
                serde_json::to_string(&names).ok()
            }
        }
        serde_json::Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            // Already-encoded JSON array.
            if trimmed.starts_with('[') {
                return Some(trimmed.to_string());
            }
            // Comma-separated shorthand ("read_file, grep_files").
            let names: Vec<&str> = trimmed
                .split(',')
                .map(|part| part.trim())
                .filter(|part| !part.is_empty())
                .collect();
            if names.is_empty() {
                None
            } else {
                serde_json::to_string(&names).ok()
            }
        }
        serde_json::Value::Null => None,
        _ => None,
    }
}

/// A steer receiver that is deliberately never fed.
///
/// Background runs (cron wakes, skills) need *a* receiver to satisfy the
/// agent-loop context, but must not compete with the foreground turn for the
/// user's steer messages. The matching sender is dropped immediately, so
/// `try_recv` simply reports the channel as empty/closed and the loop proceeds
/// without injecting anything.
fn detached_steer_rx() -> Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>> {
    let (_tx, rx) = mpsc::unbounded_channel();
    Arc::new(Mutex::new(Some(rx)))
}

/// Normalise a JS-supplied MCP tool result into what the model should read.
///
/// The MCP spec's `CallToolResult` is
/// `{ content: ContentBlock[], isError?: bool, structuredContent?: object }`,
/// and the spec is explicit that a tool's own failures are reported *inside*
/// the result with `isError: true` — not as a protocol error — precisely so the
/// model can see the failure and self-correct.
///
/// Two problems this fixes:
///
///  * `respond_to_mcp_tool` takes `is_error` as a SEPARATE argument, so a
///    caller that forwards a real `CallToolResult` verbatim (the obvious thing
///    to do) had its `isError` silently ignored. A failed MCP tool was handed
///    to the model as a success, defeating the one guarantee the field exists
///    to provide.
///  * The whole JSON blob was passed through as the tool-result text, so the
///    model saw `{"content":[{"type":"text","text":"16C"}]}` instead of `16C` —
///    noisier, more tokens, and meaningless for image/resource blocks.
///
/// Anything that is not shaped like a `CallToolResult` is passed through
/// unchanged, so existing callers that already send plain text or their own
/// JSON keep working.
fn normalize_mcp_result(result_json: &str, is_error_arg: bool) -> (String, bool) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(result_json) else {
        // Not JSON at all — plain text is a perfectly good tool result.
        return (result_json.to_string(), is_error_arg);
    };

    let Some(content) = value.get("content").and_then(|c| c.as_array()) else {
        return (result_json.to_string(), is_error_arg);
    };

    // `isError` is OR-ed, never overridden: an explicit `true` from the caller
    // must not be downgraded by a result that omits the field.
    let is_error = is_error_arg
        || value
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

    let mut parts: Vec<String> = Vec::new();
    for block in content {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    parts.push(text.to_string());
                }
            }
            // The model cannot consume raw base64 here, but it must still learn
            // that the tool produced something and what kind.
            Some("image") => {
                let mime = block
                    .get("mimeType")
                    .and_then(|m| m.as_str())
                    .unwrap_or("image");
                parts.push(format!("[image content returned ({mime})]"));
            }
            Some("audio") => {
                let mime = block
                    .get("mimeType")
                    .and_then(|m| m.as_str())
                    .unwrap_or("audio");
                parts.push(format!("[audio content returned ({mime})]"));
            }
            Some("resource") | Some("resource_link") => {
                // An embedded resource carries its text inline when it is textual.
                let res = block.get("resource").unwrap_or(block);
                if let Some(text) = res.get("text").and_then(|t| t.as_str()) {
                    parts.push(text.to_string());
                } else {
                    let uri = res.get("uri").and_then(|u| u.as_str()).unwrap_or("unknown");
                    parts.push(format!("[resource: {uri}]"));
                }
            }
            // Unknown/future block types: keep the raw JSON rather than drop it.
            _ => parts.push(block.to_string()),
        }
    }

    // `structuredContent` is the machine-readable half and must survive even on
    // the error path — it is where servers put error codes and retry hints.
    if let Some(structured) = value.get("structuredContent") {
        if !structured.is_null() {
            parts.push(structured.to_string());
        }
    }

    if parts.is_empty() {
        // A CallToolResult with an empty content array is legal. Say so plainly
        // instead of handing the model "".
        let fallback = if is_error {
            "The MCP tool reported an error with no content.".to_string()
        } else {
            "The MCP tool returned no content.".to_string()
        };
        return (fallback, is_error);
    }

    (parts.join("\n"), is_error)
}

/// Clears the `turn_in_flight` flag on drop.
///
/// A plain "set it back to false at the end" would leak the flag whenever the
/// task returned early or panicked, permanently wedging the agent into
/// "a turn is already running". Drop runs on every exit path, including unwind.
struct TurnGuard(Arc<std::sync::atomic::AtomicBool>);

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Long-lived handle — one per app lifecycle.
#[derive(uniffi::Object)]
pub struct NativeAgentHandle {
    runtime: tokio::runtime::Runtime,
    config: types::InitConfig,
    event_callback: Arc<Mutex<Option<Arc<dyn NativeEventCallback>>>>,
    notifier: Arc<Mutex<Option<Arc<dyn NativeNotifier>>>>,
    memory_provider: Arc<Mutex<Option<Arc<dyn MemoryProvider>>>>,
    abort_flag: Arc<Mutex<bool>>,
    current_session: Arc<Mutex<Option<types::SessionState>>>,
    /// Pending tool approvals keyed by `tool_call_id` (see agent_loop).
    approval_senders: Arc<Mutex<HashMap<String, oneshot::Sender<types::ApprovalResponse>>>>,
    cron_approval_sender: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    steer_tx: mpsc::UnboundedSender<String>,
    steer_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    mcp_tools: Arc<Mutex<Vec<types::ToolDefinition>>>,
    mcp_pending: Arc<Mutex<HashMap<String, oneshot::Sender<types::McpToolResult>>>>,
    active_skills: Arc<Mutex<types::SkillSessions>>,
    /// Set while a foreground turn is in flight.
    ///
    /// `spawn_main_turn` snapshots `current_session` when it starts and
    /// overwrites it when it finishes. Two overlapping sendMessage() calls
    /// therefore both branch from the SAME history and the slower one wins,
    /// silently discarding the other turn's messages — and both write the same
    /// session row. A private guard (not part of the FFI surface) makes the
    /// second call fail loudly instead of corrupting the transcript.
    turn_in_flight: Arc<std::sync::atomic::AtomicBool>,
}

#[uniffi::export]
impl NativeAgentHandle {
    /// Create a new native agent handle.
    #[uniffi::constructor]
    pub fn new(config: types::InitConfig) -> Result<Arc<Self>, NativeAgentError> {
        Self::from_config(config, true)
    }

    /// Set the event callback for receiving agent events.
    pub fn set_event_callback(
        &self,
        callback: Box<dyn NativeEventCallback>,
    ) -> Result<(), NativeAgentError> {
        let callback: Arc<dyn NativeEventCallback> = Arc::from(callback);
        let pending = {
            let conn = db::open_db(&self.config.db_path)?;
            db::drain_pending_events(&conn)?
        };
        self.runtime.block_on(async {
            let mut cb = self.event_callback.lock().await;
            *cb = Some(callback.clone());
        });
        for event in pending {
            callback.on_event(event.event_type, event.payload_json);
        }
        Ok(())
    }

    pub fn set_notifier(&self, notifier: Box<dyn NativeNotifier>) -> Result<(), NativeAgentError> {
        self.runtime.block_on(async {
            let mut current = self.notifier.lock().await;
            *current = Some(Arc::from(notifier));
        });
        Ok(())
    }

    pub fn set_memory_provider(
        &self,
        provider: Box<dyn MemoryProvider>,
    ) -> Result<(), NativeAgentError> {
        self.runtime.block_on(async {
            let mut current = self.memory_provider.lock().await;
            *current = Some(Arc::from(provider));
        });
        Ok(())
    }

    pub fn persist_config(&self) -> Result<(), NativeAgentError> {
        let path = config_store::default_config_path(&self.config.workspace_path);
        config_store::persist_config(&self.config, &path.display().to_string())?;
        Ok(())
    }

    // ── Agent ──────────────────────────────────────────────────────────────

    /// Send a message to the agent and start an agent loop turn.
    pub fn send_message(
        &self,
        params: types::SendMessageParams,
    ) -> Result<String, NativeAgentError> {
        self.reset_abort_flag(&self.abort_flag);
        // Parse prior messages if provided (for skill follow-ups with history)
        let prior_messages: Option<Vec<types::Message>> = params
            .prior_messages_json
            .as_deref()
            .and_then(|json| serde_json::from_str(json).ok());
        let params = self.prepare_params(params)?;
        let session_state = self.session_state_from_params(
            &params,
            prior_messages.clone().unwrap_or_default(),
        );
        self.spawn_main_turn(params, prior_messages, session_state)
    }

    /// Follow up on the current conversation.
    pub fn follow_up(&self, prompt: String) -> Result<(), NativeAgentError> {
        self.reset_abort_flag(&self.abort_flag);

        let session = self
            .runtime
            .block_on(async { self.current_session.lock().await.clone() });
        let Some(session) = session else {
            return Err(NativeAgentError::Agent {
                msg: "No current session to follow up".to_string(),
            });
        };

        let params = self.prepare_params(session.to_params(prompt))?;
        let session_state = self.session_state_from_params(&params, session.messages.clone());
        self.spawn_main_turn(params, Some(session.messages), session_state)?;
        Ok(())
    }

    /// Abort the current agent turn.
    pub fn abort(&self) -> Result<(), NativeAgentError> {
        self.runtime.block_on(async {
            let mut flag = self.abort_flag.lock().await;
            *flag = true;
        });
        Ok(())
    }

    /// Steer the running agent with additional context.
    //
    // Applies to the FOREGROUND turn only. The text is queued and injected as a
    // user message at the top of the next iteration of the main agent loop.
    // It deliberately does not reach background work: cron jobs (`handle_wake`)
    // and skill runs used to share this very receiver, so whichever of them
    // happened to poll first would consume the user's steer text and the
    // foreground turn would never see it — a race decided by timing alone.
    // Background runs now get their own (never-fed) channel.
    pub fn steer(&self, text: String) -> Result<(), NativeAgentError> {
        self.steer_tx
            .send(text)
            .map_err(|e| NativeAgentError::Agent { msg: e.to_string() })
    }

    // ── Approval gate ──────────────────────────────────────────────────────

    /// Respond to a tool approval request.
    pub fn respond_to_approval(
        &self,
        tool_call_id: String,
        approved: bool,
        reason: Option<String>,
    ) -> Result<(), NativeAgentError> {
        self.runtime.block_on(async {
            // Honour `tool_call_id` instead of blindly resolving whatever
            // request happened to be in flight. An unknown id is a no-op rather
            // than a mis-routed approval.
            let mut pending = self.approval_senders.lock().await;
            if let Some(tx) = pending.remove(&tool_call_id) {
                let _ = tx.send(types::ApprovalResponse {
                    tool_call_id,
                    approved,
                    reason,
                });
            } else {
                tracing::warn!(
                    tool_call_id = %tool_call_id,
                    "respond_to_approval: no pending approval with this id (already answered, cancelled, or stale)"
                );
            }
        });
        Ok(())
    }

    /// Respond to a pending MCP tool call.
    pub fn respond_to_mcp_tool(
        &self,
        tool_call_id: String,
        result_json: String,
        is_error: bool,
    ) -> Result<(), NativeAgentError> {
        self.runtime.block_on(async {
            let mut pending = self.mcp_pending.lock().await;
            if let Some(tx) = pending.remove(&tool_call_id) {
                // Honour the MCP `isError` carried inside the result and flatten
                // its content blocks into text the model can actually read.
                let (result_json, is_error) = normalize_mcp_result(&result_json, is_error);
                let _ = tx.send(types::McpToolResult {
                    result_json,
                    is_error,
                });
            }
        });
        Ok(())
    }

    // ── Auth ──────────────────────────────────────────────────────────────

    /// Get auth token for a provider.
    pub fn get_auth_token(
        &self,
        provider: String,
    ) -> Result<types::AuthTokenResult, NativeAgentError> {
        auth::get_auth_token(&self.config.auth_profiles_path, &provider)
    }

    /// Set an auth key for a provider.
    pub fn set_auth_key(
        &self,
        key: String,
        provider: String,
        auth_type: String,
    ) -> Result<(), NativeAgentError> {
        auth::set_auth_key(&self.config.auth_profiles_path, &key, &provider, &auth_type)
    }

    /// Delete auth for a provider.
    pub fn delete_auth(&self, provider: String) -> Result<(), NativeAgentError> {
        auth::delete_auth(&self.config.auth_profiles_path, &provider)
    }

    /// Refresh an OAuth token.
    pub fn refresh_token(
        &self,
        provider: String,
    ) -> Result<types::AuthTokenResult, NativeAgentError> {
        self.runtime.block_on(async {
            auth::refresh_oauth_token(&self.config.auth_profiles_path, &provider).await
        })
    }

    /// Exchange an OAuth authorization code for tokens.
    pub fn exchange_oauth_code(
        &self,
        token_url: String,
        body_json: String,
        content_type: Option<String>,
    ) -> Result<String, NativeAgentError> {
        let auth_path = self.config.auth_profiles_path.clone();
        self.runtime.block_on(async move {
            let raw =
                auth::exchange_oauth_code(&token_url, &body_json, content_type.as_deref()).await?;

            // Store the tokens instead of only handing them to JS: without this
            // the refresh token was dropped and the profile could never renew.
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if parsed.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                    if let Some(data) = parsed.get("data") {
                        // Infer the provider from the token endpoint.
                        let provider = if token_url.contains("anthropic") {
                            "anthropic"
                        } else if token_url.contains("openai") {
                            "openai"
                        } else if token_url.contains("openrouter") {
                            "openrouter"
                        } else {
                            "anthropic"
                        };
                        if let Err(e) = auth::persist_oauth_tokens(&auth_path, provider, data) {
                            tracing::warn!(error = %e, "could not persist exchanged OAuth tokens");
                        }
                    }
                }
            }
            Ok(raw)
        })
    }

    /// Get auth status (masked key).
    pub fn get_auth_status(
        &self,
        provider: String,
    ) -> Result<types::AuthStatusResult, NativeAgentError> {
        auth::get_auth_status(&self.config.auth_profiles_path, &provider)
    }

    // ── Sessions ──────────────────────────────────────────────────────────

    /// List sessions for an agent.
    pub fn list_sessions(&self, agent_id: String) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::list_sessions(&conn, &agent_id)
    }

    /// Load session message history.
    pub fn load_session(&self, session_key: String) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::load_session_messages(&conn, &session_key)
    }

    /// Resume a session (load messages into agent context).
    pub fn resume_session(
        &self,
        session_key: String,
        agent_id: String,
        messages_json: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    ) -> Result<(), NativeAgentError> {
        let messages: Vec<types::Message> = if let Some(json) = messages_json {
            serde_json::from_str(&json)?
        } else {
            let conn = db::open_db(&self.config.db_path)?;
            db::load_session_messages_raw(&conn, &session_key)?
        };
        let system_prompt = workspace::load_system_prompt(
            &self.config.workspace_path,
            &self.merged_tools_for_prompt(),
        )?;

        // Restore the constraints the session actually ran under. These were
        // hardcoded to `max_turns: 25` / `allowed_tools_json: None`, so
        // resuming a tool-restricted session (e.g. one started by a skill
        // limited to three read-only tools) silently unlocked every tool —
        // a sandbox escape reachable from the UI's own "resume" button.
        let (stored_max_turns, stored_allowed_tools) = {
            let conn = db::open_db(&self.config.db_path)?;
            db::load_session_constraints(&conn, &session_key)?
        };

        self.runtime.block_on(async {
            let mut current = self.current_session.lock().await;
            *current = Some(types::SessionState {
                session_key,
                agent_id,
                provider,
                model,
                system_prompt,
                max_turns: stored_max_turns.or(Some(25)),
                allowed_tools_json: stored_allowed_tools,
                messages,
            });
        });
        Ok(())
    }

    /// Clear the current in-memory session state so the next sendMessage
    /// starts a fresh conversation.  The session row in SQLite is preserved
    /// so it remains in the session index for later resume/switch.
    pub fn clear_session(&self) -> Result<(), NativeAgentError> {
        self.runtime.block_on(async {
            self.current_session.lock().await.take();
        });
        Ok(())
    }

    // ── Cron / heartbeat ──────────────────────────────────────────────────

    /// Add a cron job.
    pub fn add_cron_job(&self, input_json: String) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::add_cron_job(&conn, &input_json)
    }

    /// Update a cron job.
    pub fn update_cron_job(&self, id: String, patch_json: String) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::update_cron_job(&conn, &id, &patch_json)
    }

    /// Remove a cron job.
    pub fn remove_cron_job(&self, id: String) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::remove_cron_job(&conn, &id)
    }

    /// List all cron jobs.
    pub fn list_cron_jobs(&self) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::list_cron_jobs(&conn)
    }

    /// Force-trigger a cron job.
    pub fn run_cron_job(&self, job_id: String) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::run_cron_job(&conn, &job_id)
    }

    /// List cron run history.
    pub fn list_cron_runs(
        &self,
        job_id: Option<String>,
        limit: i64,
    ) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::list_cron_runs(&conn, job_id.as_deref(), limit)
    }

    /// Handle a wake event (evaluate due cron jobs).
    pub fn handle_wake(&self, source: String) -> Result<(), NativeAgentError> {
        let config = self.config.clone();
        let callback = self.callback_clone();
        let notifier = self.notifier_clone();
        let memory_provider = self.memory_provider_clone();
        let abort_flag = self.abort_flag.clone();
        let approval_senders = self.approval_senders.clone();
        // Background wakes must NOT drain the foreground steer channel — see
        // the note on `steer()`. Hand them a private receiver that nobody feeds.
        let steer_rx = detached_steer_rx();
        let mcp_tools = self.mcp_tools.clone();
        let mcp_pending = self.mcp_pending.clone();

        self.runtime.block_on(async {
            db::handle_wake(
                &config,
                &source,
                callback,
                notifier,
                memory_provider,
                abort_flag,
                approval_senders,
                steer_rx,
                mcp_tools,
                mcp_pending,
            )
            .await
        })
    }

    /// Get scheduler config.
    pub fn get_scheduler_config(&self) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::get_scheduler_config(&conn)
    }

    /// Set scheduler config.
    pub fn set_scheduler_config(&self, config_json: String) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::set_scheduler_config(&conn, &config_json)
    }

    /// Get heartbeat config.
    pub fn get_heartbeat_config(&self) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::get_heartbeat_config(&conn)
    }

    /// Set heartbeat config.
    pub fn set_heartbeat_config(&self, config_json: String) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::set_heartbeat_config(&conn, &config_json)
    }

    /// Respond to a cron approval request.
    pub fn respond_to_cron_approval(
        &self,
        _request_id: String,
        approved: bool,
    ) -> Result<(), NativeAgentError> {
        self.runtime.block_on(async {
            let mut sender = self.cron_approval_sender.lock().await;
            if let Some(tx) = sender.take() {
                let _ = tx.send(approved);
            }
        });
        Ok(())
    }

    // ── Skills ─────────────────────────────────────────────────────────────

    /// Add a cron skill.
    pub fn add_skill(&self, input_json: String) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::add_skill(&conn, &input_json)
    }

    /// Update a cron skill.
    pub fn update_skill(&self, id: String, patch_json: String) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::update_skill(&conn, &id, &patch_json)
    }

    /// Remove a cron skill.
    pub fn remove_skill(&self, id: String) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::remove_skill(&conn, &id)
    }

    /// List all cron skills.
    pub fn list_skills(&self) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::list_skills(&conn)
    }

    // ── Tool Permissions ──────────────────────────────────────────────

    /// Seed tool permissions from defaults. INSERT OR IGNORE preserves user overrides.
    pub fn seed_tool_permissions(&self, defaults_json: String) -> Result<u32, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::seed_tool_permissions(&conn, &defaults_json)
    }

    /// Set a single tool's permission (upsert).
    pub fn set_tool_permission(&self, tool_name: String, permission: String, enabled: bool) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::set_tool_permission(&conn, &tool_name, &permission, enabled)
    }

    /// List all tool permissions as JSON array.
    pub fn list_tool_permissions(&self) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::list_tool_permissions(&conn)
    }

    /// Delete all tool permissions (reset to defaults on next seed).
    pub fn reset_tool_permissions(&self) -> Result<(), NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        db::reset_tool_permissions(&conn)
    }

    /// Start a skill session.
    pub fn start_skill(
        &self,
        skill_id: String,
        config_json: String,
        provider: Option<String>,
    ) -> Result<String, NativeAgentError> {
        let conn = db::open_db(&self.config.db_path)?;
        let skill_json = db::load_skill(&conn, &skill_id)?;
        let skill: serde_json::Value = serde_json::from_str(&skill_json)?;
        let launch: serde_json::Value = if config_json.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&config_json)?
        };

        let prompt = launch
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Run skill {}", skill_id));
        let session_key = launch
            .get("sessionKey")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("skill-{}", uuid::Uuid::new_v4()));

        // Skills bypass prepare_params entirely — no workspace system prompt,
        // no IDENTITY.md, no MEMORY.md. This matches the old JS agent behavior
        // where skills ran in a completely isolated Agent instance.
        let params = types::SendMessageParams {
            prompt,
            session_key: session_key.clone(),
            model: launch
                .get("model")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    skill
                        .get("model")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                }),
            provider,
            system_prompt: launch
                .get("systemPrompt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    skill
                        .get("systemPrompt")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default(),
            max_turns: launch
                .get("maxTurns")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .or_else(|| {
                    skill
                        .get("maxTurns")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as u32)
                }),
            // `allowedTools` is naturally a JSON *array* (["read_file", ...]),
            // but this only ever called `.as_str()`. An array yielded `None`,
            // which the engine reads as "no restrictions" — so a skill that was
            // meant to be limited to three read-only tools silently ran with
            // full access. Accept both shapes and fail closed.
            allowed_tools_json: launch
                .get("allowedToolsJson")
                .and_then(normalize_allowed_tools)
                .or_else(|| launch.get("allowedTools").and_then(normalize_allowed_tools))
                .or_else(|| skill.get("allowedTools").and_then(normalize_allowed_tools)),
            prior_messages_json: None,
        };

        let run_id = uuid::Uuid::new_v4().to_string();
        let run_id_for_task = run_id.clone();
        let skill_abort_flag = Arc::new(Mutex::new(false));
        self.runtime.block_on(async {
            let mut skills = self.active_skills.lock().await;
            skills.insert(
                skill_id.clone(),
                types::SkillSession {
                    session_key: session_key.clone(),
                    abort_flag: skill_abort_flag.clone(),
                },
            );
        });

        let config = self.config.clone();
        let callback = self.callback_clone();
        let approval_senders = self.approval_senders.clone();
        // A skill runs alongside the main chat; it must not swallow the user's
        // steer text meant for the foreground turn.
        let steer_rx = detached_steer_rx();
        let mcp_tools = self.mcp_tools.clone();
        let mcp_pending = self.mcp_pending.clone();
        let memory_provider = self.memory_provider_clone();
        let active_skills = self.active_skills.clone();
        let current_session = self.current_session.clone();
        let skill_id_for_task = skill_id.clone();
        let params_for_task = params.clone();

        self.runtime.spawn(async move {
            let start_time = chrono::Utc::now().timestamp_millis();
            let result = agent_loop::run_agent_turn(agent_loop::AgentLoopContext {
                config: &config,
                params: &params_for_task,
                callback: callback.clone(),
                abort_flag: skill_abort_flag.clone(),
                is_background: false,
                wall_clock_timeout_ms: None,
                prior_messages: None,
                approval_senders,
                steer_rx,
                mcp_tools,
                mcp_pending,
                memory_provider: memory_provider.clone(),
                skip_user_echo: true, // Skill kickoff — hide internal instruction from chat
                session_key: params_for_task.session_key.clone(),
            })
            .await;

            match result {
                Ok(turn_result) => {
                    if let Ok(conn) = db::open_db(&config.db_path) {
                        let _ = db::save_session(
                            &conn,
                            &params_for_task.session_key,
                            &skill_id_for_task,
                            &turn_result.messages_json,
                            Some(&turn_result.model),
                            start_time,
                            Some(&turn_result.usage),
                        );
                        // Skills are the main source of tool-restricted
                        // sessions; persist the restriction so a resume cannot
                        // widen it.
                        let _ = db::save_session_constraints(
                            &conn,
                            &params_for_task.session_key,
                            params_for_task.max_turns,
                            params_for_task.allowed_tools_json.as_deref(),
                        );
                    }

                    // Store into current_session so followUp() works for skill follow-ups.
                    // Mirrors pi-agent-core where Agent.state.messages persisted across prompt() calls.
                    let next_session = types::SessionState {
                        session_key: params_for_task.session_key.clone(),
                        agent_id: skill_id_for_task.clone(),
                        provider: params_for_task.provider.clone(),
                        model: Some(turn_result.model.clone()),
                        system_prompt: params_for_task.system_prompt.clone(),
                        max_turns: params_for_task.max_turns,
                        allowed_tools_json: params_for_task.allowed_tools_json.clone(),
                        messages: turn_result.messages,
                    };

                    // Build display JSON before moving messages into session state
                    let display = types::DisplayMessage::from_messages(
                        &next_session.messages,
                        Some(&turn_result.model),
                        Some(&turn_result.usage),
                        chrono::Utc::now().timestamp_millis(),
                    );
                    let display_json = serde_json::to_string(&display).unwrap_or_else(|_| "[]".into());

                    *current_session.lock().await = Some(next_session);

                    if let Some(cb) = &callback {
                        // Was hardcoded to "" so the UI could not tell which run
                        // had finished.
                        let payload = serde_json::json!({
                            "runId": run_id_for_task,
                            "skillId": skill_id_for_task,
                            "sessionKey": params_for_task.session_key,
                            "usage": turn_result.usage,
                            "messagesJson": turn_result.messages_json,
                            "displayMessagesJson": display_json,
                        });
                        cb.on_event("agent.completed".into(), payload.to_string());
                    }
                }
                Err(e) => {
                    // Only create the row when there is nothing to lose — see
                    // the matching note in spawn_main_turn. Writing "[]" over an
                    // existing session destroyed its history.
                    if let Ok(conn) = db::open_db(&config.db_path) {
                        let already_has_history =
                            db::load_session_messages_raw(&conn, &params_for_task.session_key)
                                .map(|messages| !messages.is_empty())
                                .unwrap_or(false);
                        if !already_has_history {
                            let _ = db::save_session(
                                &conn,
                                &params_for_task.session_key,
                                &skill_id_for_task,
                                "[]",
                                None,
                                start_time,
                                None,
                            );
                        }
                    }

                    if let Some(cb) = &callback {
                        let payload = serde_json::json!({
                            "runId": run_id_for_task,
                            "skillId": skill_id_for_task,
                            "sessionKey": params_for_task.session_key,
                            "error": format!("{}", e),
                        });
                        cb.on_event("agent.error".into(), payload.to_string());
                    }
                }
            }

            active_skills.lock().await.remove(&skill_id_for_task);
        });

        Ok(session_key)
    }

    /// End a skill session.
    pub fn end_skill(&self, skill_id: String) -> Result<(), NativeAgentError> {
        let session = self
            .runtime
            .block_on(async { self.active_skills.lock().await.remove(&skill_id) });
        if let Some(session) = session {
            self.runtime.block_on(async {
                let mut flag = session.abort_flag.lock().await;
                *flag = true;
            });
        }
        Ok(())
    }

    // ── MCP ────────────────────────────────────────────────────────────────

    /// Start MCP server with given tools.
    //
    // Architecture note: MCP servers are hosted by the WebView, not by Rust.
    // The engine only keeps the tool catalogue and dispatches calls back to JS
    // through `mcp_pending`, so "start" means "publish the tools you have
    // connected", not "spawn a process".
    //
    // `start` and `restart` used to be byte-identical aliases of
    // `set_mcp_tools`, which made `startMcp("[]")` silently erase every
    // registered tool — exactly what the demo lab did on page load. `start` is
    // now additive and refuses to clear the catalogue; use `restart` (or
    // `setMcpTools`) to replace it.
    pub fn start_mcp(&self, tools_json: String) -> Result<u32, NativeAgentError> {
        let incoming = Self::parse_mcp_tools(&tools_json)?;
        if incoming.is_empty() {
            // Nothing to add — report the current count rather than wiping.
            return Ok(self
                .runtime
                .block_on(async { self.mcp_tools.lock().await.len() }) as u32);
        }
        self.runtime.block_on(async {
            let mut tools = self.mcp_tools.lock().await;
            for tool in incoming {
                // Replace a same-named entry instead of duplicating it.
                if let Some(slot) = tools.iter_mut().find(|t| t.name == tool.name) {
                    *slot = tool;
                } else {
                    tools.push(tool);
                }
            }
            Ok(tools.len() as u32)
        })
    }

    /// Restart MCP server with new tools.
    //
    // Unlike `start_mcp` this REPLACES the catalogue, dropping anything
    // previously registered.
    pub fn restart_mcp(&self, tools_json: String) -> Result<u32, NativeAgentError> {
        self.set_mcp_tools(tools_json)
    }

    // ── Models ─────────────────────────────────────────────────────────────

    /// Get available models for a provider.
    pub fn get_models(&self, provider: String) -> Result<String, NativeAgentError> {
        Ok(workspace::get_models_json(&provider))
    }

    // ── Tools ──────────────────────────────────────────────────────────────

    /// Invoke a tool directly.
    pub fn invoke_tool(
        &self,
        tool_name: String,
        args_json: String,
    ) -> Result<String, NativeAgentError> {
        let args: serde_json::Value = serde_json::from_str(&args_json)?;
        let workspace = self.config.workspace_path.clone();
        let db_path = self.config.db_path.clone();
        let memory_provider = self.memory_provider_clone();
        self.runtime.block_on(async {
            let result = tool_runner::execute_tool(
                &tool_name,
                &args,
                &workspace,
                &db_path,
                memory_provider.as_ref(),
            )
            .await?;
            Ok(serde_json::to_string(&result)?)
        })
    }
}

impl NativeAgentHandle {
    fn from_config(
        config: types::InitConfig,
        persist_config: bool,
    ) -> Result<Arc<Self>, NativeAgentError> {
        workspace::init_default_files(&config)?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| NativeAgentError::Agent { msg: e.to_string() })?;

        let conn = db::open_db(&config.db_path)?;
        db::ensure_schema(&conn)?;

        if persist_config {
            let path = config_store::default_config_path(&config.workspace_path);
            config_store::persist_config(&config, &path.display().to_string())?;
        }

        let (steer_tx, steer_rx) = mpsc::unbounded_channel();

        Ok(Arc::new(Self {
            runtime,
            config,
            event_callback: Arc::new(Mutex::new(None)),
            notifier: Arc::new(Mutex::new(None)),
            memory_provider: Arc::new(Mutex::new(None)),
            abort_flag: Arc::new(Mutex::new(false)),
            current_session: Arc::new(Mutex::new(None)),
            approval_senders: Arc::new(Mutex::new(HashMap::new())),
            cron_approval_sender: Arc::new(Mutex::new(None)),
            steer_tx,
            steer_rx: Arc::new(Mutex::new(Some(steer_rx))),
            mcp_tools: Arc::new(Mutex::new(vec![])),
            mcp_pending: Arc::new(Mutex::new(HashMap::new())),
            active_skills: Arc::new(Mutex::new(HashMap::new())),
            turn_in_flight: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }))
    }

    fn callback_clone(&self) -> Option<Arc<dyn NativeEventCallback>> {
        self.runtime
            .block_on(async { self.event_callback.lock().await.clone() })
    }

    fn notifier_clone(&self) -> Option<Arc<dyn NativeNotifier>> {
        self.runtime
            .block_on(async { self.notifier.lock().await.clone() })
    }

    fn memory_provider_clone(&self) -> Option<Arc<dyn MemoryProvider>> {
        self.runtime
            .block_on(async { self.memory_provider.lock().await.clone() })
    }

    fn reset_abort_flag(&self, abort_flag: &Arc<Mutex<bool>>) {
        self.runtime.block_on(async {
            let mut flag = abort_flag.lock().await;
            *flag = false;
        });
    }

    /// Build the full tool list (builtin + MCP, deduplicated) for system prompt generation.
    fn merged_tools_for_prompt(&self) -> Vec<types::ToolDefinition> {
        let mcp = self.runtime.block_on(async {
            self.mcp_tools.lock().await.clone()
        });
        let mut all = tool_runner::get_tool_definitions(&self.config.workspace_path, None);
        let builtin_names: std::collections::HashSet<String> =
            all.iter().map(|t| t.name.clone()).collect();
        all.extend(mcp.into_iter().filter(|t| !builtin_names.contains(&t.name)));
        all
    }

    fn prepare_params(
        &self,
        mut params: types::SendMessageParams,
    ) -> Result<types::SendMessageParams, NativeAgentError> {
        // Skills provide their own system prompt — never fall back to workspace
        // default (IDENTITY.md, MEMORY.md, etc.). When allowed_tools_json is set,
        // we're in skill mode and the system prompt is already correct.
        if params.allowed_tools_json.is_none() && params.system_prompt.trim().is_empty() {
            params.system_prompt = workspace::load_system_prompt(
                &self.config.workspace_path,
                &self.merged_tools_for_prompt(),
            )?;
        }
        Ok(params)
    }

    fn session_state_from_params(
        &self,
        params: &types::SendMessageParams,
        messages: Vec<types::Message>,
    ) -> types::SessionState {
        types::SessionState {
            session_key: params.session_key.clone(),
            agent_id: "main".to_string(),
            provider: params.provider.clone(),
            model: params.model.clone(),
            system_prompt: params.system_prompt.clone(),
            max_turns: params.max_turns,
            allowed_tools_json: params.allowed_tools_json.clone(),
            messages,
        }
    }

    fn spawn_main_turn(
        &self,
        params: types::SendMessageParams,
        prior_messages: Option<Vec<types::Message>>,
        session_state: types::SessionState,
    ) -> Result<String, NativeAgentError> {
        // Reject a second concurrent turn rather than letting it race.
        // `compare_exchange` is the atomic test-and-set: only the first caller
        // sees `false` and proceeds.
        if self
            .turn_in_flight
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_err()
        {
            return Err(NativeAgentError::Agent {
                msg: "A turn is already running — call abort() first, or wait for \
                      agent.completed before sending another message."
                    .to_string(),
            });
        }

        let run_id = uuid::Uuid::new_v4().to_string();
        let config = self.config.clone();
        let callback = self.callback_clone();
        let abort_flag = self.abort_flag.clone();
        let approval_senders = self.approval_senders.clone();
        let steer_rx = self.steer_rx.clone();
        let mcp_tools = self.mcp_tools.clone();
        let mcp_pending = self.mcp_pending.clone();
        let memory_provider = self.memory_provider_clone();
        let current_session = self.current_session.clone();
        let params_for_task = params.clone();
        let run_id_for_task = run_id.clone();
        let turn_in_flight = self.turn_in_flight.clone();

        self.runtime.spawn(async move {
            // Released when this task ends, however it ends.
            let _turn_guard = TurnGuard(turn_in_flight);
            let start_time = chrono::Utc::now().timestamp_millis();
            let result = agent_loop::run_agent_turn(agent_loop::AgentLoopContext {
                config: &config,
                params: &params_for_task,
                callback: callback.clone(),
                abort_flag: abort_flag.clone(),
                is_background: false,
                wall_clock_timeout_ms: None,
                prior_messages,
                approval_senders,
                steer_rx,
                mcp_tools,
                mcp_pending,
                memory_provider: memory_provider.clone(),
                skip_user_echo: false,
                session_key: params_for_task.session_key.clone(),
            })
            .await;

            match result {
                Ok(turn_result) => {
                    if let Ok(conn) = db::open_db(&config.db_path) {
                        let _ = db::save_session(
                            &conn,
                            &params_for_task.session_key,
                            "main",
                            &turn_result.messages_json,
                            Some(&turn_result.model),
                            start_time,
                            Some(&turn_result.usage),
                        );
                        // Remember the constraints so resumeSession() restores
                        // them instead of defaulting to "unrestricted".
                        let _ = db::save_session_constraints(
                            &conn,
                            &params_for_task.session_key,
                            params_for_task.max_turns,
                            params_for_task.allowed_tools_json.as_deref(),
                        );
                    }

                    let mut next_session = session_state;
                    next_session.messages = turn_result.messages;

                    // Build display JSON before moving session state
                    let display = types::DisplayMessage::from_messages(
                        &next_session.messages,
                        Some(&turn_result.model),
                        Some(&turn_result.usage),
                        chrono::Utc::now().timestamp_millis(),
                    );
                    let display_json = serde_json::to_string(&display).unwrap_or_else(|_| "[]".into());

                    *current_session.lock().await = Some(next_session);

                    if let Some(cb) = &callback {
                        let payload = serde_json::json!({
                            "runId": run_id_for_task,
                            "sessionKey": params_for_task.session_key,
                            "usage": turn_result.usage,
                            "messagesJson": turn_result.messages_json,
                            "displayMessagesJson": display_json,
                        });
                        cb.on_event("agent.completed".into(), payload.to_string());
                    }
                }
                Err(e) => {
                    // Persist the session row even on error so it appears in
                    // listSessions — but NEVER with an empty message array.
                    //
                    // The previous version wrote "[]" here, which `save_session`
                    // treats as the new full message list: one transient network
                    // failure wiped the user's entire conversation history with
                    // no backup and no way to recover it. Instead, only create
                    // the row when the session does not exist yet; if it does,
                    // leave the stored messages untouched.
                    if let Ok(conn) = db::open_db(&config.db_path) {
                        let already_has_history = db::load_session_messages_raw(
                            &conn,
                            &params_for_task.session_key,
                        )
                        .map(|messages| !messages.is_empty())
                        .unwrap_or(false);

                        if !already_has_history {
                            let _ = db::save_session(
                                &conn,
                                &params_for_task.session_key,
                                "main",
                                "[]",
                                None,
                                start_time,
                                None,
                            );
                        }
                    }

                    if let Some(cb) = &callback {
                        let payload = serde_json::json!({
                            "runId": run_id_for_task,
                            "error": e.to_string(),
                        });
                        cb.on_event("agent.error".into(), payload.to_string());
                    }
                }
            }
        });

        Ok(run_id)
    }

    /// Shared parser for the MCP tool catalogue JSON.
    fn parse_mcp_tools(tools_json: &str) -> Result<Vec<types::ToolDefinition>, NativeAgentError> {
        let tool_values: Vec<serde_json::Value> = serde_json::from_str(tools_json)?;
        let mut parsed = Vec::with_capacity(tool_values.len());
        for tool in tool_values {
            let name = tool.get("name").and_then(|v| v.as_str()).ok_or_else(|| {
                NativeAgentError::Agent {
                    msg: "MCP tool is missing 'name'".to_string(),
                }
            })?;
            let description = tool
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = tool
                .get("inputSchema")
                .cloned()
                .or_else(|| tool.get("input_schema").cloned())
                .unwrap_or_else(|| serde_json::json!({"type": "object"}));
            let webview_only = tool
                .get("webviewOnly")
                .or_else(|| tool.get("webview_only"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let approval_policy = tool
                .get("approvalPolicy")
                .or_else(|| tool.get("approval_policy"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            parsed.push(types::ToolDefinition {
                name: name.to_string(),
                description,
                input_schema,
                webview_only,
                approval_policy,
            });
        }
        Ok(parsed)
    }

    fn set_mcp_tools(&self, tools_json: String) -> Result<u32, NativeAgentError> {
        let parsed = Self::parse_mcp_tools(&tools_json)?;
        let count = parsed.len() as u32;
        self.runtime.block_on(async {
            let mut tools = self.mcp_tools.lock().await;
            *tools = parsed;
        });
        Ok(count)
    }
}

uniffi::setup_scaffolding!();

#[cfg(test)]
mod turn_guard_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// The flag must behave as a strict test-and-set: exactly one of N racing
    /// callers may claim the turn.
    #[test]
    fn only_one_caller_can_claim_a_turn() {
        let flag = Arc::new(AtomicBool::new(false));
        let claim = |f: &Arc<AtomicBool>| {
            f.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        };
        assert!(claim(&flag), "first caller wins");
        assert!(!claim(&flag), "second caller must be rejected");
        assert!(!claim(&flag), "and stays rejected while in flight");
    }

    /// Drop must release the flag on EVERY exit path, or the agent wedges
    /// permanently into "a turn is already running".
    #[test]
    fn the_guard_releases_the_flag_when_dropped() {
        let flag = Arc::new(AtomicBool::new(true));
        {
            let _g = TurnGuard(flag.clone());
            assert!(flag.load(Ordering::SeqCst));
        }
        assert!(!flag.load(Ordering::SeqCst), "drop must clear the flag");

        // A new turn can be claimed afterwards.
        assert!(flag
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok());
    }

    /// Even an early return / panic-unwind path releases the flag.
    #[test]
    fn a_panicking_task_still_releases_the_flag() {
        let flag = Arc::new(AtomicBool::new(true));
        let f = flag.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _g = TurnGuard(f);
            panic!("simulated task failure");
        }));
        assert!(result.is_err(), "the panic must propagate");
        assert!(
            !flag.load(Ordering::SeqCst),
            "the flag must be released during unwind"
        );
    }

    /// Sequential turns must keep working — the guard must not be sticky.
    #[test]
    fn consecutive_turns_are_allowed() {
        let flag = Arc::new(AtomicBool::new(false));
        for i in 0..5 {
            assert!(
                flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok(),
                "turn {i} should be claimable"
            );
            drop(TurnGuard(flag.clone()));
        }
    }
}

#[cfg(test)]
mod mcp_result_tests {
    use super::*;

    /// The spec is explicit: a tool's own failure is reported inside the result
    /// with `isError: true`, so the model can see it and self-correct. The
    /// engine took `is_error` as a separate argument and ignored the one in the
    /// payload, turning every forwarded failure into a silent success.
    #[test]
    fn the_is_error_inside_a_call_tool_result_is_honoured() {
        let raw = r#"{"content":[{"type":"text","text":"rate limited"}],"isError":true}"#;
        // Caller forwards the result verbatim and passes false, as is natural.
        let (text, is_error) = normalize_mcp_result(raw, false);
        assert!(is_error, "the inner isError must not be lost");
        assert_eq!(text, "rate limited");
    }

    /// OR, never override: an explicit error from the caller must survive a
    /// result that omits the field.
    #[test]
    fn an_explicit_error_is_never_downgraded() {
        let raw = r#"{"content":[{"type":"text","text":"partial"}]}"#;
        let (_, is_error) = normalize_mcp_result(raw, true);
        assert!(is_error);
        let (_, is_error) = normalize_mcp_result(raw, false);
        assert!(!is_error, "absent isError means success");
    }

    #[test]
    fn text_blocks_are_flattened_instead_of_dumped_as_json() {
        let raw = r#"{"content":[{"type":"text","text":"16C"},{"type":"text","text":"cloudy"}]}"#;
        let (text, is_error) = normalize_mcp_result(raw, false);
        // Previously the model saw the entire JSON blob.
        assert_eq!(text, "16C\ncloudy");
        assert!(!text.contains("\"type\""), "no raw JSON should leak through");
        assert!(!is_error);
    }

    #[test]
    fn non_text_blocks_are_described_rather_than_dropped() {
        let raw = r#"{"content":[
            {"type":"image","mimeType":"image/png","data":"aGk="},
            {"type":"resource","resource":{"uri":"file:///a.txt","text":"file body"}},
            {"type":"resource","resource":{"uri":"file:///b.bin"}}
        ]}"#;
        let (text, _) = normalize_mcp_result(raw, false);
        assert!(text.contains("[image content returned (image/png)]"));
        assert!(text.contains("file body"), "textual resources inline their text");
        assert!(text.contains("[resource: file:///b.bin]"));
        // The base64 payload is useless to the model and must not be inlined.
        assert!(!text.contains("aGk="));
    }

    /// structuredContent is where servers put error codes and retry hints, and
    /// the spec does not gate it on isError.
    #[test]
    fn structured_content_survives_even_on_the_error_path() {
        let raw = r#"{"content":[],"isError":true,
                      "structuredContent":{"code":"RATE_LIMITED","retry_after":30}}"#;
        let (text, is_error) = normalize_mcp_result(raw, false);
        assert!(is_error);
        assert!(text.contains("RATE_LIMITED"), "got: {text}");
        assert!(text.contains("retry_after"));
    }

    #[test]
    fn an_empty_content_array_produces_a_readable_message() {
        let (text, is_error) = normalize_mcp_result(r#"{"content":[]}"#, false);
        assert!(!is_error);
        assert_eq!(text, "The MCP tool returned no content.");

        let (text, is_error) = normalize_mcp_result(r#"{"content":[],"isError":true}"#, false);
        assert!(is_error);
        assert!(text.contains("error"), "got: {text}");
        // The model must never be handed an empty string.
        assert!(!text.is_empty());
    }

    /// Backward compatibility: callers already sending plain text or their own
    /// JSON shape must keep working untouched.
    #[test]
    fn non_call_tool_result_payloads_pass_through_unchanged() {
        for raw in [
            "just plain text",
            r#"{"ok":true,"from":"demo lab"}"#,
            r#"[1,2,3]"#,
            "",
        ] {
            let (text, is_error) = normalize_mcp_result(raw, false);
            assert_eq!(text, raw, "payload must be untouched");
            assert!(!is_error);
        }
        // And the explicit flag still applies to them.
        let (_, is_error) = normalize_mcp_result("boom", true);
        assert!(is_error);
    }

    #[test]
    fn unknown_block_types_are_preserved_not_silently_dropped() {
        let raw = r#"{"content":[{"type":"future_kind","payload":{"a":1}}]}"#;
        let (text, _) = normalize_mcp_result(raw, false);
        assert!(text.contains("future_kind"), "got: {text}");
    }
}
