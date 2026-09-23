//! Types exposed via UniFFI to Kotlin/Swift.
//!
//! These mirror the JS types from mobile-claw (auth-store, cron-db-access, etc.)
//! and the openfang message types.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Configuration for initializing the native agent handle.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct InitConfig {
    /// Path to the SQLite database.
    pub db_path: String,
    /// Path to the workspace root.
    pub workspace_path: String,
    /// Path to auth-profiles.json.
    pub auth_profiles_path: String,
}

/// Parameters for sending a message.
#[derive(Debug, Clone, uniffi::Record)]
pub struct SendMessageParams {
    pub prompt: String,
    pub session_key: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub system_prompt: String,
    pub max_turns: Option<u32>,
    /// JSON-encoded list of allowed tool names. Empty = all tools.
    pub allowed_tools_json: Option<String>,
    /// JSON-encoded prior conversation messages for multi-turn sessions.
    pub prior_messages_json: Option<String>,
}

/// Auth token result.
#[derive(Debug, Clone, uniffi::Record)]
pub struct AuthTokenResult {
    pub api_key: Option<String>,
    pub is_oauth: bool,
}

/// Auth status result.
#[derive(Debug, Clone, uniffi::Record)]
pub struct AuthStatusResult {
    pub has_key: bool,
    pub masked: String,
    pub provider: String,
}

/// Token usage from an agent turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize, uniffi::Record)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
}

/// Buffered event emitted while no foreground callback is attached.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct PendingEvent {
    pub id: i64,
    pub event_type: String,
    pub payload_json: String,
    pub created_at: i64,
}

// ── Internal types (not UniFFI-exported, used by agent loop) ──

/// Role in a conversation message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// Content block in a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "server_tool_use")]
    ServerToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "web_search_tool_result")]
    WebSearchToolResult {
        tool_use_id: String,
        content: serde_json::Value, // encrypted — preserve for multi-turn citations
    },
}

/// Message content — simple text or structured blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

/// A conversation message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: MessageContent,
}

impl Message {
    pub fn user(text: &str) -> Self {
        Self {
            role: Role::User,
            content: MessageContent::Text(text.to_string()),
        }
    }

    pub fn assistant_text(text: &str) -> Self {
        Self {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![ContentBlock::Text {
                text: text.to_string(),
            }]),
        }
    }

    pub fn assistant_blocks(blocks: Vec<ContentBlock>) -> Self {
        Self {
            role: Role::Assistant,
            content: MessageContent::Blocks(blocks),
        }
    }

    pub fn tool_result(tool_use_id: &str, content: &str, is_error: bool) -> Self {
        Self {
            role: Role::User,
            content: MessageContent::Blocks(vec![ContentBlock::ToolResult {
                tool_use_id: tool_use_id.to_string(),
                content: content.to_string(),
                is_error,
            }]),
        }
    }

    /// Extract text from assistant message content blocks.
    pub fn text(&self) -> String {
        match &self.content {
            MessageContent::Text(t) => t.clone(),
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
        }
    }
}

/// Why the model stopped generating.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
}

/// Tool definition for the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    #[serde(default)]
    pub webview_only: bool,
    /// Consumer-owned approval policy synced from WebView.
    /// "always_allow" | "always_ask" | "always_ask_biometric"
    #[serde(default)]
    pub approval_policy: Option<String>,
}

/// A tool call from the LLM response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// In-memory state for the current interactive session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_key: String,
    pub agent_id: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub system_prompt: String,
    pub max_turns: Option<u32>,
    pub allowed_tools_json: Option<String>,
    pub messages: Vec<Message>,
}

impl SessionState {
    pub fn to_params(&self, prompt: String) -> SendMessageParams {
        SendMessageParams {
            prompt,
            session_key: self.session_key.clone(),
            model: self.model.clone(),
            provider: self.provider.clone(),
            system_prompt: self.system_prompt.clone(),
            max_turns: self.max_turns,
            allowed_tools_json: self.allowed_tools_json.clone(),
            prior_messages_json: None,
        }
    }
}

/// Response payload for a pending tool approval request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub tool_call_id: String,
    pub approved: bool,
    pub reason: Option<String>,
}

/// Result payload returned from a JS-hosted MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    pub result_json: String,
    pub is_error: bool,
}

/// Per-skill execution state tracked by the native handle.
#[derive(Debug, Clone)]
pub struct SkillSession {
    pub session_key: String,
    pub abort_flag: Arc<Mutex<bool>>,
}

pub type SkillSessions = HashMap<String, SkillSession>;

// ── Display types (provider-agnostic, UI-facing contract) ──

/// A tool call in the canonical display format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// A tool result in the canonical display format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayToolResult {
    pub tool_call_id: String,
    pub output: String,
    #[serde(default)]
    pub is_error: bool,
}

/// Provider-agnostic message for UI rendering and caching.
///
/// Every LLM driver (Anthropic, OpenAI, Gemini, etc.) converts its native
/// response into this flat format. Everything downstream — bridge events,
/// JS composables, SQLite cache — only ever sees `DisplayMessage`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayMessage {
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<DisplayToolCall>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_results: Vec<DisplayToolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    pub timestamp: i64,
    pub sequence: u32,
}

impl DisplayMessage {
    /// Convert internal `Message` array (provider-specific) into canonical `DisplayMessage` array.
    pub fn from_messages(
        msgs: &[Message],
        model: Option<&str>,
        usage: Option<&TokenUsage>,
        base_timestamp: i64,
    ) -> Vec<Self> {
        let mut result = Vec::with_capacity(msgs.len());
        let now = base_timestamp;

        for (i, msg) in msgs.iter().enumerate() {
            let role = match msg.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::System => continue, // system messages are not displayed
            };

            match &msg.content {
                MessageContent::Text(t) => {
                    result.push(DisplayMessage {
                        role: role.to_string(),
                        text: t.clone(),
                        tool_calls: Vec::new(),
                        tool_results: Vec::new(),
                        model: if msg.role == Role::Assistant { model.map(|s| s.to_string()) } else { None },
                        usage: if msg.role == Role::Assistant { usage.cloned() } else { None },
                        timestamp: now,
                        sequence: i as u32,
                    });
                }
                MessageContent::Blocks(blocks) => {
                    let text: String = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("");

                    let tool_calls: Vec<DisplayToolCall> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolUse { id, name, input } => Some(DisplayToolCall {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                            }),
                            _ => None,
                        })
                        .collect();

                    let tool_results: Vec<DisplayToolResult> = blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolResult {
                                tool_use_id,
                                content,
                                is_error,
                            } => Some(DisplayToolResult {
                                tool_call_id: tool_use_id.clone(),
                                output: content.clone(),
                                is_error: *is_error,
                            }),
                            _ => None,
                        })
                        .collect();

                    result.push(DisplayMessage {
                        role: role.to_string(),
                        text,
                        tool_calls,
                        tool_results,
                        model: if msg.role == Role::Assistant { model.map(|s| s.to_string()) } else { None },
                        usage: if msg.role == Role::Assistant { usage.cloned() } else { None },
                        timestamp: now,
                        sequence: i as u32,
                    });
                }
            }
        }

        result
    }
}

#[cfg(test)]
mod round_trip_tests {
    use super::*;

    /// Messages are persisted as JSON and reloaded on resume. If a block type
    /// fails to round-trip, `load_session_messages_raw` silently falls back to
    /// stuffing the raw JSON into a Text block — the transcript is then
    /// corrupt AND the API rejects it (unmatched tool_use). Every variant must
    /// survive a save/load cycle intact.
    #[test]
    fn every_content_block_survives_a_json_round_trip() {
        let blocks = vec![
            ContentBlock::Text { text: "hello আমি 🇧🇩".into() },
            ContentBlock::ToolUse {
                id: "toolu_1".into(),
                name: "read_file".into(),
                input: serde_json::json!({"path": "a.txt", "n": 3}),
            },
            ContentBlock::ToolResult {
                tool_use_id: "toolu_1".into(),
                content: "file body".into(),
                is_error: false,
            },
            ContentBlock::Thinking { thinking: "reasoning".into() },
            ContentBlock::ServerToolUse {
                id: "srv_1".into(),
                name: "web_search".into(),
                input: serde_json::json!({"query": "x"}),
            },
            ContentBlock::WebSearchToolResult {
                tool_use_id: "srv_1".into(),
                content: serde_json::json!([{"title": "t"}]),
            },
        ];

        for block in blocks {
            let json = serde_json::to_string(&block).unwrap();
            let back: ContentBlock = serde_json::from_str(&json)
                .unwrap_or_else(|e| panic!("{json} failed to round-trip: {e}"));
            assert_eq!(
                serde_json::to_string(&back).unwrap(),
                json,
                "re-serialising must be stable"
            );
        }
    }

    /// `MessageContent` is `#[serde(untagged)]`, which picks the first variant
    /// that deserialises. A Blocks payload must NOT be mistaken for Text and
    /// vice versa — that is exactly how a tool call turns into garbage text.
    #[test]
    fn message_content_variants_do_not_collide() {
        let text = MessageContent::Text("plain".into());
        let json = serde_json::to_string(&text).unwrap();
        assert!(
            matches!(
                serde_json::from_str::<MessageContent>(&json).unwrap(),
                MessageContent::Text(t) if t == "plain"
            ),
            "text must stay text"
        );

        let blocks = MessageContent::Blocks(vec![ContentBlock::ToolUse {
            id: "toolu_9".into(),
            name: "bash".into(),
            input: serde_json::json!({}),
        }]);
        let json = serde_json::to_string(&blocks).unwrap();
        match serde_json::from_str::<MessageContent>(&json).unwrap() {
            MessageContent::Blocks(b) => {
                assert_eq!(b.len(), 1);
                assert!(matches!(&b[0], ContentBlock::ToolUse { id, .. } if id == "toolu_9"));
            }
            MessageContent::Text(t) => {
                panic!("blocks were misparsed as text — history would be corrupted: {t}")
            }
        }
    }

    /// A full assistant turn (thinking + tool_use) must survive persistence,
    /// because resume replays it to the provider verbatim.
    #[test]
    fn a_full_assistant_turn_round_trips() {
        let msg = Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(vec![
                ContentBlock::Text { text: "I will read it".into() },
                ContentBlock::ToolUse {
                    id: "toolu_a".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({"path": "x"}),
                },
            ]),
        };
        let json = serde_json::to_string(&msg.content).unwrap();
        let back: MessageContent = serde_json::from_str(&json).unwrap();
        let restored = Message { role: Role::Assistant, content: back };

        // The tool_use id must still be there — this is what the API pairs
        // against tool_result.
        let ids: Vec<String> = match &restored.content {
            MessageContent::Blocks(b) => b
                .iter()
                .filter_map(|x| match x {
                    ContentBlock::ToolUse { id, .. } => Some(id.clone()),
                    _ => None,
                })
                .collect(),
            _ => vec![],
        };
        assert_eq!(ids, vec!["toolu_a".to_string()]);
        assert_eq!(restored.text(), "I will read it");
    }

    #[test]
    fn roles_serialise_lowercase_as_the_db_expects() {
        // load_session_messages_raw matches on "user"/"assistant"/"system";
        // any other spelling silently DROPS the message.
        for (role, want) in [
            (Role::User, "\"user\""),
            (Role::Assistant, "\"assistant\""),
            (Role::System, "\"system\""),
        ] {
            assert_eq!(serde_json::to_string(&role).unwrap(), want);
        }
    }
}
