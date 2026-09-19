//! LLM driver — Anthropic Messages API with streaming and OAuth support.
//!
//! Adapted from openfang's anthropic driver, stripped to essentials.

use crate::types::{
    ContentBlock, Message, MessageContent, Role, StopReason, TokenUsage, ToolCall, ToolDefinition,
};
use async_trait::async_trait;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

// ── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("API error ({status}): {message}")]
    Api { status: u16, message: String },
    #[error("Rate limited, retry after {retry_after_ms}ms")]
    RateLimited { retry_after_ms: u64 },
    #[error("Model overloaded, retry after {retry_after_ms}ms")]
    Overloaded { retry_after_ms: u64 },
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Missing API key: {0}")]
    MissingApiKey(String),
}

impl LlmError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            LlmError::RateLimited { .. } | LlmError::Overloaded { .. }
        ) || self.to_string().to_lowercase().contains("rate limit")
            || self.to_string().to_lowercase().contains("overloaded")
            || self.to_string().to_lowercase().contains("timeout")
    }

    pub fn status_code(&self) -> Option<u16> {
        match self {
            LlmError::Api { status, .. } => Some(*status),
            LlmError::RateLimited { .. } => Some(429),
            LlmError::Overloaded { .. } => Some(529),
            _ => None,
        }
    }
}

// ── Request / Response ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    pub max_tokens: u32,
    pub temperature: f32,
    pub system: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompletionResponse {
    pub content: Vec<ContentBlock>,
    pub stop_reason: StopReason,
    pub tool_calls: Vec<ToolCall>,
    pub usage: TokenUsage,
}

impl CompletionResponse {
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

// ── Stream events (for callback dispatch) ───────────────────────────────────

#[derive(Debug, Clone)]
pub enum StreamEvent {
    TextDelta(String),
    ThinkingDelta(String),
    ToolUseStart {
        id: String,
        name: String,
    },
    ToolUseEnd {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    WebSearchStart {
        query: String,
    },
    WebSearchComplete {
        results_count: u32,
    },
    MessageDone(CompletionResponse),
}

// ── Driver trait ────────────────────────────────────────────────────────────

#[async_trait]
pub trait LlmDriver: Send + Sync {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, LlmError>;

    async fn stream(
        &self,
        req: &CompletionRequest,
        on_event: &(dyn Fn(StreamEvent) + Send + Sync),
    ) -> Result<CompletionResponse, LlmError>;
}

// ── Anthropic Driver ────────────────────────────────────────────────────────

pub struct AnthropicDriver {
    api_key: String,
    is_oauth: bool,
    base_url: String,
    client: reqwest::Client,
}

impl AnthropicDriver {
    pub fn new(api_key: String, base_url: Option<String>) -> Self {
        let is_oauth = api_key.starts_with("sk-ant-oat");
        Self {
            api_key,
            is_oauth,
            base_url: base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string()),
            client: reqwest::Client::new(),
        }
    }

    fn build_request(&self, req: &CompletionRequest, stream: bool) -> reqwest::RequestBuilder {
        let url = format!("{}/v1/messages", self.base_url);
        let mut builder = self.client.post(&url);

        // OAuth: full Claude Code identity (must match pi-ai/anthropic.ts exactly)
        if self.is_oauth {
            builder = builder
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("anthropic-beta", "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14")
                .header("user-agent", "claude-cli/2.1.75")
                .header("x-app", "cli")
                .header("accept", "application/json")
                .header("anthropic-dangerous-direct-browser-access", "true");
        } else {
            builder = builder.header("x-api-key", &self.api_key);
        }

        builder = builder
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");

        let mut api_tools: Vec<ApiToolEntry> = req
            .tools
            .iter()
            .map(|t| {
                ApiToolEntry::ClientTool(ApiTool {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    input_schema: t.input_schema.clone(),
                })
            })
            .collect();

        // Inject web_search server tool when using OAuth
        if self.is_oauth {
            // Remove any client-side tool named "web_search" to avoid duplicate name error
            api_tools.retain(|t| match t {
                ApiToolEntry::ClientTool(ct) => ct.name != "web_search",
                _ => true,
            });
            api_tools.push(ApiToolEntry::ServerTool(serde_json::json!({
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 8
            })));
        }

        // OAuth: system prompt must be array of {type:"text",text:...} objects
        // with Claude Code identity as first element (matches pi-ai/anthropic.ts)
        let system_value = if self.is_oauth {
            let mut blocks = vec![
                serde_json::json!({"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}),
            ];
            if let Some(s) = &req.system {
                if !s.is_empty() {
                    blocks.push(serde_json::json!({"type": "text", "text": s}));
                }
            }
            Some(serde_json::json!(blocks))
        } else {
            req.system.as_ref().map(|s| serde_json::json!(s))
        };

        let body = ApiRequest {
            model: req.model.clone(),
            max_tokens: req.max_tokens,
            system: system_value,
            messages: req
                .messages
                .iter()
                .filter(|m| m.role != Role::System)
                .map(convert_message)
                .collect(),
            tools: api_tools,
            temperature: if req.temperature > 0.0 {
                Some(req.temperature)
            } else {
                None
            },
            stream,
        };

        builder.json(&body)
    }

    async fn handle_error_response(&self, status: u16, body: &str) -> LlmError {
        if status == 429 {
            return LlmError::RateLimited {
                retry_after_ms: 5000,
            };
        }
        if status == 529 {
            return LlmError::Overloaded {
                retry_after_ms: 5000,
            };
        }
        let message = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| body.to_string());
        LlmError::Api { status, message }
    }
}

#[async_trait]
impl LlmDriver for AnthropicDriver {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let resp = self
            .build_request(req, false)
            .send()
            .await
            .map_err(|e| LlmError::Http(e.to_string()))?;

        let status = resp.status().as_u16();
        let body = resp
            .text()
            .await
            .map_err(|e| LlmError::Http(e.to_string()))?;

        if status != 200 {
            return Err(self.handle_error_response(status, &body).await);
        }

        let api_resp: ApiResponse = serde_json::from_str(&body)
            .map_err(|e| LlmError::Parse(format!("{}: {}", e, &body[..200.min(body.len())])))?;

        Ok(parse_api_response(api_resp))
    }

    async fn stream(
        &self,
        req: &CompletionRequest,
        on_event: &(dyn Fn(StreamEvent) + Send + Sync),
    ) -> Result<CompletionResponse, LlmError> {
        let resp = self
            .build_request(req, true)
            .send()
            .await
            .map_err(|e| LlmError::Http(e.to_string()))?;

        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp
                .text()
                .await
                .map_err(|e| LlmError::Http(e.to_string()))?;
            return Err(self.handle_error_response(status, &body).await);
        }

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut accum = StreamAccumulator::new();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| LlmError::Http(e.to_string()))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));

            // Process complete SSE lines
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();

                for line in frame.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            continue;
                        }
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                            accum.process_sse(&json, on_event);
                        }
                    }
                }
            }
        }

        let response = accum.finish();
        on_event(StreamEvent::MessageDone(response.clone()));
        Ok(response)
    }
}

// ── SSE stream accumulator ──────────────────────────────────────────────────

enum BlockAccum {
    Text(String),
    ToolUse {
        id: String,
        name: String,
        input_json: String,
    },
    Thinking(String),
    ServerToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
        input_json: String,
    },
    WebSearchResult {
        tool_use_id: String,
        content: serde_json::Value,
    },
}

struct StreamAccumulator {
    blocks: Vec<BlockAccum>,
    current_block: Option<BlockAccum>,
    stop_reason: StopReason,
    input_tokens: u32,
    output_tokens: u32,
}

impl StreamAccumulator {
    fn new() -> Self {
        Self {
            blocks: vec![],
            current_block: None,
            stop_reason: StopReason::EndTurn,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    fn process_sse(
        &mut self,
        json: &serde_json::Value,
        on_event: &(dyn Fn(StreamEvent) + Send + Sync),
    ) {
        let event_type = json["type"].as_str().unwrap_or("");

        match event_type {
            "message_start" => {
                self.input_tokens = json["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0) as u32;
            }

            "content_block_start" => {
                let block = &json["content_block"];
                let block_type = block["type"].as_str().unwrap_or("");
                self.current_block = match block_type {
                    "text" => Some(BlockAccum::Text(String::new())),
                    "tool_use" => {
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        let name = block["name"].as_str().unwrap_or("").to_string();
                        on_event(StreamEvent::ToolUseStart {
                            id: id.clone(),
                            name: name.clone(),
                        });
                        Some(BlockAccum::ToolUse {
                            id,
                            name,
                            input_json: String::new(),
                        })
                    }
                    "thinking" => Some(BlockAccum::Thinking(String::new())),
                    "server_tool_use" => {
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        let name = block["name"].as_str().unwrap_or("").to_string();
                        let input = block["input"].clone();
                        Some(BlockAccum::ServerToolUse { id, name, input, input_json: String::new() })
                    }
                    "web_search_tool_result" => {
                        let tool_use_id = block["tool_use_id"].as_str().unwrap_or("").to_string();
                        let content = block["content"].clone();
                        Some(BlockAccum::WebSearchResult {
                            tool_use_id,
                            content,
                        })
                    }
                    _ => None,
                };
            }

            "content_block_delta" => {
                let delta = &json["delta"];
                let delta_type = delta["type"].as_str().unwrap_or("");
                match (&mut self.current_block, delta_type) {
                    (Some(BlockAccum::Text(ref mut text)), "text_delta") => {
                        let d = delta["text"].as_str().unwrap_or("");
                        text.push_str(d);
                        on_event(StreamEvent::TextDelta(d.to_string()));
                    }
                    (
                        Some(BlockAccum::ToolUse {
                            ref mut input_json, ..
                        }),
                        "input_json_delta",
                    ) => {
                        let d = delta["partial_json"].as_str().unwrap_or("");
                        input_json.push_str(d);
                    }
                    (
                        Some(BlockAccum::ServerToolUse {
                            ref mut input_json, ..
                        }),
                        "input_json_delta",
                    ) => {
                        let d = delta["partial_json"].as_str().unwrap_or("");
                        input_json.push_str(d);
                    }
                    (Some(BlockAccum::Thinking(ref mut text)), "thinking_delta") => {
                        let d = delta["thinking"].as_str().unwrap_or("");
                        text.push_str(d);
                        on_event(StreamEvent::ThinkingDelta(d.to_string()));
                    }
                    _ => {}
                }
            }

            "content_block_stop" => {
                if let Some(block) = self.current_block.take() {
                    match &block {
                        BlockAccum::ToolUse {
                            id,
                            name,
                            input_json,
                        } => {
                            let input: serde_json::Value =
                                serde_json::from_str(input_json).unwrap_or_else(|_| serde_json::json!({}));
                            on_event(StreamEvent::ToolUseEnd {
                                id: id.clone(),
                                name: name.clone(),
                                input: input.clone(),
                            });
                        }
                        BlockAccum::ServerToolUse { input, input_json, .. } => {
                            // Merge streamed input_json with initial input (which may be {})
                            let final_input = if !input_json.is_empty() {
                                serde_json::from_str::<serde_json::Value>(input_json).unwrap_or_else(|_| input.clone())
                            } else {
                                input.clone()
                            };
                            // Emit WebSearchStart now that we have the full input
                            if let Some(query) = final_input.get("query").and_then(|q| q.as_str()) {
                                on_event(StreamEvent::WebSearchStart {
                                    query: query.to_string(),
                                });
                            }
                        }
                        BlockAccum::WebSearchResult { content, .. } => {
                            let results_count = content
                                .as_array()
                                .map(|a| a.len() as u32)
                                .unwrap_or(0);
                            on_event(StreamEvent::WebSearchComplete { results_count });
                        }
                        _ => {}
                    }
                    self.blocks.push(block);
                }
            }

            "message_delta" => {
                if let Some(sr) = json["delta"]["stop_reason"].as_str() {
                    self.stop_reason = parse_stop_reason(sr);
                }
                self.output_tokens += json["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32;
            }

            _ => {} // ignore ping, message_stop, etc.
        }
    }

    fn finish(self) -> CompletionResponse {
        let mut content = vec![];
        let mut tool_calls = vec![];

        for block in self.blocks {
            match block {
                BlockAccum::Text(text) => {
                    content.push(ContentBlock::Text { text });
                }
                BlockAccum::ToolUse {
                    id,
                    name,
                    input_json,
                } => {
                    let input: serde_json::Value =
                        serde_json::from_str(&input_json).unwrap_or_default();
                    content.push(ContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                    tool_calls.push(ToolCall { id, name, input });
                }
                BlockAccum::Thinking(text) => {
                    content.push(ContentBlock::Thinking { thinking: text });
                }
                BlockAccum::ServerToolUse { id, name, input, input_json } => {
                    // Merge streamed input_json with initial input
                    let final_input = if !input_json.is_empty() {
                        serde_json::from_str::<serde_json::Value>(&input_json).unwrap_or(input)
                    } else {
                        input
                    };
                    // Server-executed tool — add to content for conversation history
                    // but NOT to tool_calls (no local execution needed)
                    content.push(ContentBlock::ServerToolUse { id, name, input: final_input });
                }
                BlockAccum::WebSearchResult {
                    tool_use_id,
                    content: result_content,
                } => {
                    // Encrypted search results — must preserve for multi-turn citations
                    content.push(ContentBlock::WebSearchToolResult {
                        tool_use_id,
                        content: result_content,
                    });
                }
            }
        }

        CompletionResponse {
            content,
            stop_reason: self.stop_reason,
            tool_calls,
            usage: TokenUsage {
                input_tokens: self.input_tokens,
                output_tokens: self.output_tokens,
                total_tokens: self.input_tokens + self.output_tokens,
            },
        }
    }
}

// ── API types (serde) ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(untagged)]
enum ApiToolEntry {
    ClientTool(ApiTool),
    ServerTool(serde_json::Value),
}

#[derive(Serialize)]
struct ApiRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<serde_json::Value>,
    messages: Vec<ApiMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tools: Vec<ApiToolEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stream: bool,
}

#[derive(Serialize)]
struct ApiMessage {
    role: String,
    content: ApiContent,
}

#[derive(Serialize)]
#[serde(untagged)]
enum ApiContent {
    Text(String),
    Blocks(Vec<serde_json::Value>),
}

#[derive(Serialize)]
struct ApiTool {
    name: String,
    description: String,
    input_schema: serde_json::Value,
}

// ── Response parsing ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ApiResponse {
    content: Vec<ApiResponseBlock>,
    stop_reason: Option<String>,
    usage: ApiUsage,
}

#[derive(Deserialize)]
struct ApiUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ApiResponseBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
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
        content: serde_json::Value,
    },
}

fn convert_message(msg: &Message) -> ApiMessage {
    let role = match msg.role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "user",
    };

    let content = match &msg.content {
        MessageContent::Text(t) => ApiContent::Text(t.clone()),
        MessageContent::Blocks(blocks) => ApiContent::Blocks(
            blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(serde_json::json!({
                        "type": "text",
                        "text": text,
                    })),
                    ContentBlock::ToolUse { id, name, input } => {
                        // API requires input to be a dict — normalize null/non-object to {}
                        let safe_input = if input.is_object() { input.clone() } else { serde_json::json!({}) };
                        Some(serde_json::json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": safe_input,
                        }))
                    }
                    ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => {
                        let mut obj = serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": content,
                        });
                        if *is_error {
                            obj["is_error"] = serde_json::json!(true);
                        }
                        Some(obj)
                    }
                    ContentBlock::Thinking { .. } => None, // strip thinking blocks from requests
                    ContentBlock::ServerToolUse { id, name, input } => {
                        // Preserve server_tool_use in conversation history for multi-turn
                        Some(serde_json::json!({
                            "type": "server_tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }))
                    }
                    ContentBlock::WebSearchToolResult {
                        tool_use_id,
                        content,
                    } => {
                        // Encrypted content must be preserved for multi-turn citations
                        Some(serde_json::json!({
                            "type": "web_search_tool_result",
                            "tool_use_id": tool_use_id,
                            "content": content,
                        }))
                    }
                })
                .collect(),
        ),
    };

    ApiMessage {
        role: role.to_string(),
        content,
    }
}

fn parse_stop_reason(s: &str) -> StopReason {
    match s {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        _ => StopReason::EndTurn,
    }
}

fn parse_api_response(resp: ApiResponse) -> CompletionResponse {
    let mut content = vec![];
    let mut tool_calls = vec![];

    for block in resp.content {
        match block {
            ApiResponseBlock::Text { text } => {
                content.push(ContentBlock::Text { text });
            }
            ApiResponseBlock::ToolUse { id, name, input } => {
                content.push(ContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
                tool_calls.push(ToolCall { id, name, input });
            }
            ApiResponseBlock::Thinking { thinking } => {
                content.push(ContentBlock::Thinking { thinking });
            }
            ApiResponseBlock::ServerToolUse { id, name, input } => {
                // Server-executed tool — add to content but NOT to tool_calls
                content.push(ContentBlock::ServerToolUse { id, name, input });
            }
            ApiResponseBlock::WebSearchToolResult {
                tool_use_id,
                content: result_content,
            } => {
                // Encrypted search results — preserve for multi-turn citations
                content.push(ContentBlock::WebSearchToolResult {
                    tool_use_id,
                    content: result_content,
                });
            }
        }
    }

    let stop_reason = resp
        .stop_reason
        .as_deref()
        .map(parse_stop_reason)
        .unwrap_or(StopReason::EndTurn);

    CompletionResponse {
        content,
        stop_reason,
        tool_calls,
        usage: TokenUsage {
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
            total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
        },
    }
}
