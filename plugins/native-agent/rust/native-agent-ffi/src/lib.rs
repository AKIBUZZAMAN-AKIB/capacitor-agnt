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
    approval_sender: Arc<Mutex<Option<oneshot::Sender<types::ApprovalResponse>>>>,
    cron_approval_sender: Arc<Mutex<Option<oneshot::Sender<bool>>>>,
    steer_tx: mpsc::UnboundedSender<String>,
    steer_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    mcp_tools: Arc<Mutex<Vec<types::ToolDefinition>>>,
    mcp_pending: Arc<Mutex<HashMap<String, oneshot::Sender<types::McpToolResult>>>>,
    active_skills: Arc<Mutex<types::SkillSessions>>,
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
            let mut sender = self.approval_sender.lock().await;
            if let Some(tx) = sender.take() {
                let _ = tx.send(types::ApprovalResponse {
                    tool_call_id,
                    approved,
                    reason,
                });
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
        self.runtime.block_on(async {
            auth::exchange_oauth_code(
                &token_url,
                &body_json,
                content_type.as_deref(),
            )
            .await
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

        self.runtime.block_on(async {
            let mut current = self.current_session.lock().await;
            *current = Some(types::SessionState {
                session_key,
                agent_id,
                provider,
                model,
                system_prompt,
                max_turns: Some(25),
                allowed_tools_json: None,
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
        let approval_sender = self.approval_sender.clone();
        let steer_rx = self.steer_rx.clone();
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
                approval_sender,
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
            allowed_tools_json: launch
                .get("allowedToolsJson")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    skill
                        .get("allowedTools")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                }),
            prior_messages_json: None,
        };

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
        let approval_sender = self.approval_sender.clone();
        let steer_rx = self.steer_rx.clone();
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
                approval_sender,
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
                        let payload = serde_json::json!({
                            "runId": "",
                            "sessionKey": params_for_task.session_key,
                            "usage": turn_result.usage,
                            "messagesJson": turn_result.messages_json,
                            "displayMessagesJson": display_json,
                        });
                        cb.on_event("agent.completed".into(), payload.to_string());
                    }
                }
                Err(e) => {
                    if let Ok(conn) = db::open_db(&config.db_path) {
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

                    if let Some(cb) = &callback {
                        let payload = serde_json::json!({
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
    pub fn start_mcp(&self, tools_json: String) -> Result<u32, NativeAgentError> {
        self.set_mcp_tools(tools_json)
    }

    /// Restart MCP server with new tools.
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
        let memory_provider = self.memory_provider_clone();
        self.runtime.block_on(async {
            let result =
                tool_runner::execute_tool(&tool_name, &args, &workspace, memory_provider.as_ref())
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
            approval_sender: Arc::new(Mutex::new(None)),
            cron_approval_sender: Arc::new(Mutex::new(None)),
            steer_tx,
            steer_rx: Arc::new(Mutex::new(Some(steer_rx))),
            mcp_tools: Arc::new(Mutex::new(vec![])),
            mcp_pending: Arc::new(Mutex::new(HashMap::new())),
            active_skills: Arc::new(Mutex::new(HashMap::new())),
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
        let run_id = uuid::Uuid::new_v4().to_string();
        let config = self.config.clone();
        let callback = self.callback_clone();
        let abort_flag = self.abort_flag.clone();
        let approval_sender = self.approval_sender.clone();
        let steer_rx = self.steer_rx.clone();
        let mcp_tools = self.mcp_tools.clone();
        let mcp_pending = self.mcp_pending.clone();
        let memory_provider = self.memory_provider_clone();
        let current_session = self.current_session.clone();
        let params_for_task = params.clone();
        let run_id_for_task = run_id.clone();

        self.runtime.spawn(async move {
            let start_time = chrono::Utc::now().timestamp_millis();
            let result = agent_loop::run_agent_turn(agent_loop::AgentLoopContext {
                config: &config,
                params: &params_for_task,
                callback: callback.clone(),
                abort_flag: abort_flag.clone(),
                is_background: false,
                wall_clock_timeout_ms: None,
                prior_messages,
                approval_sender,
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
                    // Persist session row even on error so it appears in listSessions.
                    // This prevents the "session accumulation" race where prior errored
                    // turns leave no DB row and the index appears empty.
                    if let Ok(conn) = db::open_db(&config.db_path) {
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

    fn set_mcp_tools(&self, tools_json: String) -> Result<u32, NativeAgentError> {
        let tool_values: Vec<serde_json::Value> = serde_json::from_str(&tools_json)?;
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

        let count = parsed.len() as u32;
        self.runtime.block_on(async {
            let mut tools = self.mcp_tools.lock().await;
            *tools = parsed;
        });
        Ok(count)
    }
}

uniffi::setup_scaffolding!();
