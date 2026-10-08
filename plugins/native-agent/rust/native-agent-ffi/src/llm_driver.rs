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
    #[error("Network connection error: {0}")]
    Network(String),
    #[error("HTTP request timed out: {0}")]
    Timeout(String),
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
        match self {
            LlmError::RateLimited { .. } | LlmError::Overloaded { .. } | LlmError::Network(_) | LlmError::Timeout(_) => true,
            LlmError::Api { status, .. } => matches!(*status, 408 | 425 | 500 | 502 | 503 | 504 | 520..=599),
            LlmError::Http(message) => {
                let message = message.to_lowercase();
                message.contains("timeout") || message.contains("temporarily unavailable") || message.contains("connection reset")
            }
            _ => false,
        }
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

pub(crate) fn emit_buffered_response(
    response: &CompletionResponse,
    on_event: &(dyn Fn(StreamEvent) + Send + Sync),
) {
    let text = response.text();
    if !text.is_empty() { on_event(StreamEvent::TextDelta(text)); }
    for call in &response.tool_calls {
        on_event(StreamEvent::ToolUseStart { id: call.id.clone(), name: call.name.clone() });
        on_event(StreamEvent::ToolUseEnd {
            id: call.id.clone(), name: call.name.clone(), input: call.input.clone(),
        });
    }
    on_event(StreamEvent::MessageDone(response.clone()));
}

/// Take at most `max_bytes` from `s` without splitting a UTF-8 character.
/// `&s[..n]` panics when the cut lands mid-character, which any non-ASCII
/// error body can trigger.
pub(crate) fn safe_excerpt(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub(crate) fn map_transport_error(error: reqwest::Error) -> LlmError {
    let message = error.to_string();
    let lowered = message.to_ascii_lowercase();
    if error.is_timeout() {
        LlmError::Timeout(message)
    } else if error.is_connect()
        && !lowered.contains("certificate")
        && !lowered.contains("tls")
        && !lowered.contains("invalid peer")
    {
        // DNS/connect/reset failures are transient network failures. Do not
        // classify TLS certificate errors as retryable; that would conceal a
        // permanent trust/configuration error behind provider failover.
        LlmError::Network(message)
    } else {
        LlmError::Http(message)
    }
}

/// Parse a `Retry-After` header: either delta-seconds or an HTTP date.
pub(crate) fn parse_retry_after_ms(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    if let Ok(seconds) = raw.trim().parse::<u64>() {
        return Some(seconds.saturating_mul(1000).min(300_000));
    }
    let when = chrono::DateTime::parse_from_rfc2822(raw.trim()).ok()?;
    let delta = when.timestamp_millis() - chrono::Utc::now().timestamp_millis();
    if delta > 0 {
        Some((delta as u64).min(300_000))
    } else {
        None
    }
}


fn llm_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

// ── Anthropic Driver ────────────────────────────────────────────────────────

pub struct AnthropicDriver {
    api_key: String,
    is_oauth: bool,
    bearer_auth: bool,
    base_url: String,
    client: reqwest::Client,
    streaming_supported: bool,
}

fn collect_system_prompt(req: &CompletionRequest) -> (String, bool) {
    let mut system = req.system.clone().unwrap_or_default();
    let mut present = req.system.is_some();
    for message in req.messages.iter().filter(|message| message.role == Role::System) {
        let extra = match &message.content {
            MessageContent::Text(text) => text.clone(),
            MessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
        };
        if !extra.is_empty() {
            if !system.is_empty() {
                system.push('\n');
            }
            system.push_str(&extra);
            present = true;
        }
    }
    (system, present)
}

impl AnthropicDriver {
    pub fn new(api_key: String, base_url: Option<String>) -> Self {
        Self::with_bearer_auth(api_key, base_url, false)
    }

    pub fn with_bearer_auth(api_key: String, base_url: Option<String>, bearer_auth: bool) -> Self {
        let base_url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
        // The Claude-Code identity headers, the `anthropic-beta` flags and the
        // `web_search_20250305` *server* tool are Anthropic-first-party only.
        // This driver also serves OpenRouter, which rejects the unknown server
        // tool and the beta headers — so an OAuth-shaped key pointed at
        // OpenRouter failed every request. Gate the extras on the host, not just
        // on the key prefix.
        let is_anthropic_host = base_url.contains("api.anthropic.com");
        let is_oauth = api_key.starts_with("sk-ant-oat") && is_anthropic_host;
        Self {
            api_key,
            is_oauth,
            bearer_auth,
            base_url,
            client: llm_client(),
            streaming_supported: true,
        }
    }

    pub fn with_streaming_support(mut self, supported: bool) -> Self {
        self.streaming_supported = supported;
        self
    }

    fn build_request(&self, req: &CompletionRequest, stream: bool) -> reqwest::RequestBuilder {
        let url = if self.base_url.trim_end_matches('/').ends_with("/v1") {
            format!("{}/messages", self.base_url.trim_end_matches('/'))
        } else {
            format!("{}/v1/messages", self.base_url.trim_end_matches('/'))
        };
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
        } else if self.bearer_auth {
            if !self.api_key.trim().is_empty() {
                builder = builder.header("Authorization", format!("Bearer {}", self.api_key));
            }
        } else if !self.api_key.trim().is_empty() {
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

        // Role::System transcript items are also folded into Anthropic's
        // dedicated `system` field. This is required for persisted rolling
        // context summaries; Messages API has no system role in `messages`.
        let (system_text, has_system) = collect_system_prompt(req);
        // OAuth: system prompt must be an array of {type:"text",text:...}
        // objects with Claude Code identity first (matches pi-ai/anthropic.ts).
        let system_value = if self.is_oauth {
            let mut blocks = vec![
                serde_json::json!({"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}),
            ];
            if !system_text.is_empty() {
                blocks.push(serde_json::json!({"type": "text", "text": system_text}));
            }
            Some(serde_json::json!(blocks))
        } else if has_system {
            Some(serde_json::json!(system_text))
        } else {
            None
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

    /// `retry_after` comes from the response's `Retry-After` header when we have
    /// it. Previously this was hardcoded to 5 s, so a server asking for 60 s was
    /// hammered twelve times inside its own cool-off window — which on most
    /// providers extends the rate limit instead of clearing it.
    fn handle_error_response_with_retry_after(
        &self,
        status: u16,
        body: &str,
        retry_after: Option<u64>,
    ) -> LlmError {
        if status == 429 {
            return LlmError::RateLimited {
                retry_after_ms: retry_after.unwrap_or(5_000),
            };
        }
        if status == 529 {
            return LlmError::Overloaded {
                retry_after_ms: retry_after.unwrap_or(5_000),
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
            .map_err(map_transport_error)?;

        let status = resp.status().as_u16();
        let retry_after = parse_retry_after_ms(resp.headers());
        let body = resp
            .text()
            .await
            .map_err(map_transport_error)?;

        if status != 200 {
            return Err(self.handle_error_response_with_retry_after(status, &body, retry_after));
        }

        let api_resp: ApiResponse = serde_json::from_str(&body)
            .map_err(|e| LlmError::Parse(format!("{}: {}", e, safe_excerpt(&body, 200))))?;

        parse_api_response(api_resp)
    }

    async fn stream(
        &self,
        req: &CompletionRequest,
        on_event: &(dyn Fn(StreamEvent) + Send + Sync),
    ) -> Result<CompletionResponse, LlmError> {
        if !self.streaming_supported {
            let response = self.complete(req).await?;
            emit_buffered_response(&response, on_event);
            return Ok(response);
        }
        let resp = self
            .build_request(req, true)
            .send()
            .await
            .map_err(map_transport_error)?;

        let status = resp.status().as_u16();
        if status != 200 {
            let retry_after = parse_retry_after_ms(resp.headers());
            let body = resp
                .text()
                .await
                .map_err(map_transport_error)?;
            return Err(self.handle_error_response_with_retry_after(status, &body, retry_after));
        }

        let mut stream = resp.bytes_stream();
        // Raw bytes, not a String: a chunk may end mid-character (see
        // `find_frame_end_bytes`). Decode per complete frame instead.
        let mut buf: Vec<u8> = Vec::new();
        let mut accum = StreamAccumulator::new();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(map_transport_error)?;
            buf.extend_from_slice(&bytes);

            // Process complete SSE frames.
            //
            // The separator used to be hardcoded to "\n\n". Per the SSE spec a
            // frame may equally end with CRLF ("\r\n\r\n"), and plenty of
            // proxies/CDNs rewrite line endings — against such a stream no frame
            // ever matched, so the entire response was silently discarded while
            // `buf` grew without bound until the process ran out of memory.
            // Handle both terminators and cap the buffer.
            while let Some((pos, sep_len)) = find_frame_end_bytes(&buf) {
                // A complete frame always ends on a character boundary, so the
                // conversion here cannot split a character.
                let frame = String::from_utf8_lossy(&buf[..pos]).into_owned();
                buf.drain(..pos + sep_len);

                for line in frame.lines() {
                    // Tolerate "data:foo" as well as "data: foo" (the space is
                    // optional in the spec) and strip a trailing CR.
                    let line = line.strip_suffix('\r').unwrap_or(line);
                    let Some(rest) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = rest.strip_prefix(' ').unwrap_or(rest);
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                        accum.process_sse(&json, on_event)?;
                    }
                }
            }

            // Defensive cap: a server that never emits a frame separator must
            // not be able to exhaust memory on a phone.
            if buf.len() > MAX_SSE_BUFFER_BYTES {
                return Err(LlmError::Http(format!(
                    "SSE buffer exceeded {} bytes without a complete frame — malformed stream",
                    MAX_SSE_BUFFER_BYTES
                )));
            }
        }

        let response = accum.finish()?;
        on_event(StreamEvent::MessageDone(response.clone()));
        Ok(response)
    }
}


/// Largest amount of un-parsed SSE text we are willing to hold.
pub(crate) const MAX_SSE_BUFFER_BYTES: usize = 8 * 1024 * 1024;

/// Locate the end of the first complete SSE frame in a RAW BYTE buffer.
///
/// Why bytes and not `&str`: a chunk boundary can fall in the middle of a
/// multi-byte UTF-8 character. Decoding each chunk on its own with
/// `String::from_utf8_lossy` replaces the split halves with U+FFFD, so the
/// character is destroyed before it is ever parsed — verified: the Bangla word
/// "আমি" split after 2 bytes decodes to "\u{fffd}\u{fffd}মি". Every non-ASCII
/// script (Bangla, Arabic, CJK, and emoji) corrupts at random points in a
/// stream. Accumulating bytes and decoding only whole frames keeps characters
/// intact across chunk boundaries.
///
/// Returns the byte offset of the separator plus its length, handling both
/// "\n\n" (LF) and "\r\n\r\n" (CRLF) terminators.
pub(crate) fn find_frame_end_bytes(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n");
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(l), Some(c)) => {
            if c < l {
                Some((c, 4))
            } else {
                Some((l, 2))
            }
        }
        (Some(l), None) => Some((l, 2)),
        (None, Some(c)) => Some((c, 4)),
        (None, None) => None,
    }
}



// ── OpenAI Driver ───────────────────────────────────────────────────────────
//
// `create_driver` previously only knew "anthropic" and "openrouter", yet
// `default_model("openai")` returned "gpt-4o" and `workspace::get_models_json`
// advertised a full OpenAI model list. Selecting OpenAI in the UI therefore
// always died with "Unsupported provider: openai". This is a real
// implementation of the Chat Completions API, translating between the engine's
// Anthropic-shaped types and OpenAI's wire format.

pub struct OpenAiDriver {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
    use_max_completion_tokens: bool,
    include_stream_usage: bool,
    completion_path: String,
    streaming_supported: bool,
}

impl OpenAiDriver {
    /// First-party OpenAI defaults. Other Chat Completions gateways should use
    /// `with_compat_options`, since many only accept the standard `max_tokens`.
    pub fn new(api_key: String, base_url: Option<String>) -> Self {
        Self::with_compat_options(api_key, base_url, true, true)
    }

    pub fn with_compat_options(
        api_key: String,
        base_url: Option<String>,
        use_max_completion_tokens: bool,
        include_stream_usage: bool,
    ) -> Self {
        Self::with_endpoint_options(
            api_key,
            base_url,
            use_max_completion_tokens,
            include_stream_usage,
            "chat/completions",
        )
    }

    /// Configure the request path independently of the API root for an
    /// OpenAI-shaped gateway with a documented nonstandard completion path.
    pub fn with_endpoint_options(
        api_key: String,
        base_url: Option<String>,
        use_max_completion_tokens: bool,
        include_stream_usage: bool,
        completion_path: &str,
    ) -> Self {
        let completion_path = completion_path.trim_matches('/');
        Self {
            api_key,
            base_url: base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
            client: llm_client(),
            use_max_completion_tokens,
            include_stream_usage,
            completion_path: if completion_path.is_empty() { "chat/completions".into() } else { completion_path.into() },
            streaming_supported: true,
        }
    }

    /// Some OpenAI-shaped gateways implement only the non-streaming completion
    /// endpoint. Keep the request/response wire shape but emit its completed
    /// result as one final delta to the Native Agent event stream.
    pub fn with_streaming_support(mut self, supported: bool) -> Self {
        self.streaming_supported = supported;
        self
    }

    /// Translate the engine's Anthropic-style messages into OpenAI messages.
    ///
    /// The shapes differ in two important ways:
    ///  * tool *calls* live in `assistant.tool_calls`, not as content blocks;
    ///  * tool *results* are their own `role: "tool"` messages keyed by
    ///    `tool_call_id`, rather than user content blocks.
    fn convert_messages(req: &CompletionRequest) -> Vec<serde_json::Value> {
        let mut out: Vec<serde_json::Value> = Vec::new();

        if let Some(system) = req.system.as_ref().filter(|s| !s.is_empty()) {
            out.push(serde_json::json!({ "role": "system", "content": system }));
        }

        for message in &req.messages {
            let role = match message.role {
                Role::User | Role::Context => "user",
                Role::Assistant => "assistant",
                Role::System => "system",
            };

            match &message.content {
                MessageContent::Text(text) => {
                    out.push(serde_json::json!({ "role": role, "content": text }));
                }
                MessageContent::Blocks(blocks) => {
                    let mut text_parts: Vec<String> = Vec::new();
                    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
                    // Emitted after the assistant message they belong to.
                    let mut tool_messages: Vec<serde_json::Value> = Vec::new();

                    for block in blocks {
                        match block {
                            ContentBlock::Text { text } => text_parts.push(text.clone()),
                            ContentBlock::Thinking { .. } => {}
                            ContentBlock::ToolUse { id, name, input, .. } => {
                                tool_calls.push(serde_json::json!({
                                    "id": id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": input.to_string(),
                                    }
                                }));
                            }
                            ContentBlock::ToolResult {
                                tool_use_id,
                                content,
                                ..
                            } => {
                                tool_messages.push(serde_json::json!({
                                    "role": "tool",
                                    "tool_call_id": tool_use_id,
                                    "content": content,
                                }));
                            }
                            ContentBlock::ServerToolUse { .. }
                            | ContentBlock::WebSearchToolResult { .. } => {}
                        }
                    }

                    let has_text = !text_parts.is_empty();
                    if has_text || !tool_calls.is_empty() {
                        let mut msg = serde_json::Map::new();
                        msg.insert("role".into(), serde_json::json!(role));
                        msg.insert(
                            "content".into(),
                            if has_text {
                                serde_json::json!(text_parts.join(""))
                            } else {
                                serde_json::Value::Null
                            },
                        );
                        if !tool_calls.is_empty() {
                            msg.insert("tool_calls".into(), serde_json::json!(tool_calls));
                        }
                        out.push(serde_json::Value::Object(msg));
                    }
                    out.extend(tool_messages);
                }
            }
        }
        out
    }

    /// Families whose sampling parameters are fixed by the server.
    ///
    /// Matched as PREFIXES so dated builds (`o4-mini-2025-04-16`) and new
    /// members of a family are covered without a code change. Erring toward
    /// omission is deliberate: dropping `temperature` for a model that would
    /// have accepted it costs one setting, whereas sending it to a model that
    /// refuses it fails the whole request.
    pub(crate) fn is_reasoning_model(model: &str) -> bool {
        // Tolerate an `openai/` (OpenRouter-style) prefix on the model id.
        let name = model.rsplit('/').next().unwrap_or(model);
        const FIXED_SAMPLING_PREFIXES: [&str; 6] = ["o1", "o3", "o4", "gpt-5", "gpt-6", "gpt-6.1"];
        FIXED_SAMPLING_PREFIXES
            .iter()
            .any(|p| name == *p || name.starts_with(&format!("{}-", p)))
    }

    pub(crate) fn build_body(
        req: &CompletionRequest,
        stream: bool,
        use_max_completion_tokens: bool,
        include_stream_usage: bool,
    ) -> serde_json::Value {
        let tools: Vec<serde_json::Value> = req
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect();

        // Reasoning models (o1/o3/o4, gpt-5*) reject `temperature` outright with
        // HTTP 400 `unsupported_value` unless it is exactly the default of 1 —
        // and some endpoints reject the field's mere presence. Sending it would
        // fail EVERY request to `o4-mini`, which `get_models_json()` advertises.
        // Omit rather than rewrite: substituting 1.0 would silently invent a
        // value the caller never chose.
        let reasoning_model = Self::is_reasoning_model(&req.model);

        let mut body = serde_json::json!({
            "model": req.model,
            "messages": Self::convert_messages(req),
            "max_tokens": req.max_tokens,
            "stream": stream,
        });
        if use_max_completion_tokens {
            body.as_object_mut().unwrap().remove("max_tokens");
            body["max_completion_tokens"] = serde_json::json!(req.max_tokens);
        }
        if !reasoning_model {
            body["temperature"] = serde_json::json!(req.temperature);
        }
        if stream && include_stream_usage {
            body["stream_options"] = serde_json::json!({ "include_usage": true });
        }
        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
            body["tool_choice"] = serde_json::json!("auto");
        }
        body
    }

    fn build_request(&self, req: &CompletionRequest, stream: bool) -> reqwest::RequestBuilder {
        let mut builder = self.client
            .post(format!("{}/{}", self.base_url.trim_end_matches('/'), self.completion_path))
            .header("content-type", "application/json");
        if !self.api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", self.api_key));
        }
        builder.json(&Self::build_body(req, stream, self.use_max_completion_tokens, self.include_stream_usage))
    }

    fn error_from(status: u16, body: &str, retry_after: Option<u64>) -> LlmError {
        if status == 429 {
            return LlmError::RateLimited {
                retry_after_ms: retry_after.unwrap_or(5_000),
            };
        }
        if status == 503 || status == 529 {
            return LlmError::Overloaded {
                retry_after_ms: retry_after.unwrap_or(5_000),
            };
        }
        let message = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| body.to_string());
        LlmError::Api { status, message }
    }

    fn finish_reason_to_stop(reason: Option<&str>, has_tools: bool) -> StopReason {
        match reason {
            Some("tool_calls") | Some("function_call") => StopReason::ToolUse,
            Some("length") => StopReason::MaxTokens,
            Some("stop") if has_tools => StopReason::ToolUse,
            Some("stop") => StopReason::EndTurn,
            None if has_tools => StopReason::ToolUse,
            _ => StopReason::EndTurn,
        }
    }

    pub(crate) fn build_response(
        text: String,
        tool_calls: Vec<ToolCall>,
        finish_reason: Option<&str>,
        usage: TokenUsage,
    ) -> CompletionResponse {
        let mut content: Vec<ContentBlock> = Vec::new();
        if !text.is_empty() {
            content.push(ContentBlock::Text { text });
        }
        for call in &tool_calls {
            content.push(ContentBlock::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
                provider_metadata: None,
            });
        }
        CompletionResponse {
            stop_reason: Self::finish_reason_to_stop(finish_reason, !tool_calls.is_empty()),
            content,
            tool_calls,
            usage,
        }
    }

    fn usage_from(value: &serde_json::Value) -> TokenUsage {
        let input = value["prompt_tokens"].as_u64().unwrap_or(0) as u32;
        let output = value["completion_tokens"].as_u64().unwrap_or(0) as u32;
        TokenUsage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: value["total_tokens"]
                .as_u64()
                .map(|v| v as u32)
                .unwrap_or(input + output),
        }
    }
}

pub(crate) fn parse_openai_tool_call(call: &serde_json::Value) -> Result<ToolCall, LlmError> {
    let id = call["id"].as_str().filter(|s| !s.is_empty())
        .ok_or_else(|| LlmError::Parse("OpenAI tool call is missing its id".into()))?.to_string();
    let name = call["function"]["name"].as_str().filter(|s| !s.is_empty())
        .ok_or_else(|| LlmError::Parse(format!("OpenAI tool call {id} is missing its function name")))?.to_string();
    let raw = call.get("function").and_then(|f| f.get("arguments"))
        .ok_or_else(|| LlmError::Parse(format!("OpenAI tool call {id} is missing arguments")))?;
    let input = if let Some(encoded) = raw.as_str() {
        serde_json::from_str::<serde_json::Value>(encoded)
            .map_err(|e| LlmError::Parse(format!("Invalid JSON arguments for tool '{name}': {e}")))?
    } else if raw.is_object() {
        raw.clone()
    } else {
        return Err(LlmError::Parse(format!("Arguments for tool '{name}' must be a JSON object or encoded JSON object")));
    };
    if !input.is_object() {
        return Err(LlmError::Parse(format!("Arguments for tool '{name}' must decode to a JSON object")));
    }
    Ok(ToolCall { id, name, input })
}

pub(crate) fn parse_chat_completion(json: &serde_json::Value) -> Result<CompletionResponse, LlmError> {
    if let Some(error) = json.get("error") {
        return Err(LlmError::Api {
            status: 200,
            message: error.get("message").and_then(|v| v.as_str()).unwrap_or("provider returned an error object").to_string(),
        });
    }
    let choice = json.get("choices").and_then(|v| v.get(0))
        .filter(|v| !v.is_null())
        .ok_or_else(|| LlmError::Parse("Chat Completions response has no choices[0]".into()))?;
    let content = &choice["message"]["content"];
    let text = if let Some(text) = content.as_str() {
        text.to_string()
    } else if let Some(parts) = content.as_array() {
        parts.iter().filter_map(|part| part.get("text").and_then(|v| v.as_str())).collect::<String>()
    } else {
        String::new()
    };
    let mut tool_calls = Vec::new();
    if let Some(calls) = choice["message"]["tool_calls"].as_array() {
        for call in calls { tool_calls.push(parse_openai_tool_call(call)?); }
    } else if !choice["message"]["tool_calls"].is_null() {
        return Err(LlmError::Parse("Chat Completions message.tool_calls must be an array".into()));
    }
    let finish = choice["finish_reason"].as_str();
    if matches!(finish, Some("length" | "content_filter")) && !tool_calls.is_empty() {
        return Err(LlmError::Parse(format!("Provider ended with {finish:?} while emitting incomplete tool calls")));
    }
    Ok(OpenAiDriver::build_response(text, tool_calls, finish, OpenAiDriver::usage_from(&json["usage"])))
}

#[derive(Default)]
struct OpenAiCallAccum {
    id: String,
    name: String,
    arguments: String,
    has_arguments: bool,
    start_emitted: bool,
}

#[async_trait]
impl LlmDriver for OpenAiDriver {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let resp = self
            .build_request(req, false)
            .send()
            .await
            .map_err(map_transport_error)?;

        let status = resp.status().as_u16();
        let retry_after = parse_retry_after_ms(resp.headers());
        let body = resp
            .text()
            .await
            .map_err(map_transport_error)?;

        if status != 200 {
            return Err(Self::error_from(status, &body, retry_after));
        }

        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| LlmError::Parse(format!("{}: {}", e, safe_excerpt(&body, 200))))?;

        parse_chat_completion(&json)
    }

    async fn stream(
        &self,
        req: &CompletionRequest,
        on_event: &(dyn Fn(StreamEvent) + Send + Sync),
    ) -> Result<CompletionResponse, LlmError> {
        if !self.streaming_supported {
            let response = self.complete(req).await?;
            let text = response.text();
            if !text.is_empty() {
                on_event(StreamEvent::TextDelta(text));
            }
            for call in &response.tool_calls {
                on_event(StreamEvent::ToolUseStart { id: call.id.clone(), name: call.name.clone() });
                on_event(StreamEvent::ToolUseEnd {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: call.input.clone(),
                });
            }
            on_event(StreamEvent::MessageDone(response.clone()));
            return Ok(response);
        }

        let resp = self
            .build_request(req, true)
            .send()
            .await
            .map_err(map_transport_error)?;

        let status = resp.status().as_u16();
        if status != 200 {
            let retry_after = parse_retry_after_ms(resp.headers());
            let body = resp
                .text()
                .await
                .map_err(map_transport_error)?;
            return Err(Self::error_from(status, &body, retry_after));
        }

        let mut stream = resp.bytes_stream();
        // Raw bytes: a chunk may end mid-character (see find_frame_end_bytes).
        let mut buf: Vec<u8> = Vec::new();
        let mut text = String::new();
        // Tool-call argument strings arrive in deltas and must be validated only
        // after the complete JSON object has arrived.
        let mut partial_calls: std::collections::BTreeMap<u64, OpenAiCallAccum> =
            std::collections::BTreeMap::new();
        let mut finish_reason: Option<String> = None;
        let mut usage = TokenUsage {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
        };

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(map_transport_error)?;
            buf.extend_from_slice(&bytes);

            while let Some((pos, sep_len)) = find_frame_end_bytes(&buf) {
                // Whole frames end on a character boundary — safe to decode.
                let frame = String::from_utf8_lossy(&buf[..pos]).into_owned();
                buf.drain(..pos + sep_len);

                for line in frame.lines() {
                    let line = line.strip_suffix('\r').unwrap_or(line);
                    let Some(rest) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let data = rest.strip_prefix(' ').unwrap_or(rest);
                    if data == "[DONE]" {
                        continue;
                    }
                    let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                        continue;
                    };

                    if let Some(u) = json.get("usage").filter(|u| !u.is_null()) {
                        usage = Self::usage_from(u);
                    }

                    // With `stream_options.include_usage` the final chunk
                    // carries usage and an EMPTY `choices` array. Indexing
                    // `[0]` on it yields Null, so guard explicitly instead of
                    // reading fields off a non-existent choice.
                    let Some(choice) = json["choices"].get(0).filter(|c| !c.is_null())
                    else {
                        continue;
                    };
                    if let Some(reason) = choice["finish_reason"].as_str() {
                        finish_reason = Some(reason.to_string());
                    }
                    let delta = &choice["delta"];

                    if let Some(piece) = delta["content"].as_str() {
                        if !piece.is_empty() {
                            text.push_str(piece);
                            on_event(StreamEvent::TextDelta(piece.to_string()));
                        }
                    }

                    if let Some(calls) = delta["tool_calls"].as_array() {
                        for call in calls {
                            let index = call["index"].as_u64().unwrap_or(0);
                            let entry = partial_calls.entry(index).or_default();
                            if let Some(id) = call["id"].as_str() {
                                if !id.is_empty() { entry.id = id.to_string(); }
                            }
                            // Only the first delta normally carries the name/id;
                            // some gateways split those metadata fields across
                            // adjacent events, so announce only when both exist.
                            if let Some(name) = call["function"]["name"].as_str() {
                                if !name.is_empty() && entry.name.is_empty() { entry.name = name.to_string(); }
                            }
                            if let Some(args) = call["function"]["arguments"].as_str() {
                                entry.arguments.push_str(args);
                                entry.has_arguments = true;
                            }
                            if !entry.start_emitted && !entry.id.is_empty() && !entry.name.is_empty() {
                                on_event(StreamEvent::ToolUseStart { id: entry.id.clone(), name: entry.name.clone() });
                                entry.start_emitted = true;
                            }
                        }
                    }
                }
            }

            if buf.len() > MAX_SSE_BUFFER_BYTES {
                return Err(LlmError::Http(format!(
                    "SSE buffer exceeded {} bytes without a complete frame — malformed stream",
                    MAX_SSE_BUFFER_BYTES
                )));
            }
        }

        let mut tool_calls = Vec::new();
        for (_, partial) in partial_calls {
            if partial.id.is_empty() || partial.name.is_empty() || !partial.has_arguments {
                return Err(LlmError::Parse("OpenAI-compatible stream ended with an incomplete tool call (missing id, name, or arguments)".into()));
            }
            let input: serde_json::Value = serde_json::from_str(&partial.arguments)
                .map_err(|e| LlmError::Parse(format!("Invalid streamed JSON arguments for tool '{}': {e}", partial.name)))?;
            if !input.is_object() {
                return Err(LlmError::Parse(format!("Streamed arguments for tool '{}' must be a JSON object", partial.name)));
            }
            on_event(StreamEvent::ToolUseEnd {
                id: partial.id.clone(),
                name: partial.name.clone(),
                input: input.clone(),
            });
            tool_calls.push(ToolCall { id: partial.id, name: partial.name, input });
        }
        if matches!(finish_reason.as_deref(), Some("length" | "content_filter")) && !tool_calls.is_empty() {
            return Err(LlmError::Parse(format!("Provider ended with {:?} while emitting incomplete tool calls", finish_reason)));
        }

        let response = Self::build_response(text, tool_calls, finish_reason.as_deref(), usage);
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
        initial_input: serde_json::Value,
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
    ) -> Result<(), LlmError> {
        let event_type = json["type"].as_str().unwrap_or("");

        match event_type {
            "message_start" => {
                self.input_tokens = json["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0) as u32;
                // message_start carries a small seed for output_tokens. Take it
                // as a starting point so a stream that somehow ends without a
                // message_delta still reports something sane; the cumulative
                // message_delta value supersedes it via `max` above.
                self.output_tokens = json["message"]["usage"]["output_tokens"]
                    .as_u64()
                    .unwrap_or(0) as u32;
            }

            "content_block_start" => {
                let block = &json["content_block"];
                let block_type = block["type"].as_str().unwrap_or("");
                self.current_block = match block_type {
                    "text" => Some(BlockAccum::Text(String::new())),
                    "tool_use" => {
                        let id = block["id"].as_str().filter(|s| !s.is_empty())
                            .ok_or_else(|| LlmError::Parse("Anthropic tool_use block is missing its id".into()))?.to_string();
                        let name = block["name"].as_str().filter(|s| !s.is_empty())
                            .ok_or_else(|| LlmError::Parse(format!("Anthropic tool_use {id} is missing its name")))?.to_string();
                        let initial_input = block.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
                        on_event(StreamEvent::ToolUseStart {
                            id: id.clone(),
                            name: name.clone(),
                        });
                        Some(BlockAccum::ToolUse {
                            id,
                            name,
                            initial_input,
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
                        BlockAccum::ToolUse { id, name, initial_input, input_json } => {
                            let input: serde_json::Value = if input_json.trim().is_empty() {
                                initial_input.clone()
                            } else {
                                serde_json::from_str(input_json).map_err(|e| LlmError::Parse(format!("Invalid streamed JSON arguments for Anthropic tool '{name}': {e}")))?
                            };
                            if !input.is_object() {
                                return Err(LlmError::Parse(format!("Arguments for Anthropic tool '{name}' must be a JSON object")));
                            }
                            on_event(StreamEvent::ToolUseEnd { id: id.clone(), name: name.clone(), input });
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
                // Anthropic documents message_delta usage as CUMULATIVE: each
                // event repeats the running total, and the terminal one carries
                // the final count. Accumulating with `+=` therefore multiplied
                // the reported output tokens whenever more than one
                // message_delta arrived (and even a single one double-counted
                // the seed from message_start). Adopt the value instead.
                if let Some(tokens) = json["usage"]["output_tokens"].as_u64() {
                    self.output_tokens = self.output_tokens.max(tokens as u32);
                }
            }

            _ => {} // ignore ping, message_stop, etc.
        }
        Ok(())
    }

    fn finish(self) -> Result<CompletionResponse, LlmError> {
        if self.current_block.is_some() {
            return Err(LlmError::Parse("Anthropic stream ended before content_block_stop".into()));
        }
        let mut content = vec![];
        let mut tool_calls = vec![];

        for block in self.blocks {
            match block {
                BlockAccum::Text(text) => {
                    content.push(ContentBlock::Text { text });
                }
                BlockAccum::ToolUse { id, name, initial_input, input_json } => {
                    let input: serde_json::Value = if input_json.trim().is_empty() {
                        initial_input
                    } else {
                        serde_json::from_str(&input_json).map_err(|e| LlmError::Parse(format!("Invalid streamed JSON arguments for Anthropic tool '{name}': {e}")))?
                    };
                    if id.is_empty() || name.is_empty() || !input.is_object() {
                        return Err(LlmError::Parse("Anthropic stream contained an invalid tool-use block".into()));
                    }
                    content.push(ContentBlock::ToolUse {
                        id: id.clone(), name: name.clone(), input: input.clone(), provider_metadata: None,
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

        Ok(CompletionResponse {
            content,
            stop_reason: self.stop_reason,
            tool_calls,
            usage: TokenUsage {
                input_tokens: self.input_tokens,
                output_tokens: self.output_tokens,
                total_tokens: self.input_tokens + self.output_tokens,
            },
        })
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
        Role::User | Role::Context | Role::System => "user",
        Role::Assistant => "assistant",
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
                    ContentBlock::ToolUse { id, name, input, .. } => {
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
                    // Strip thinking blocks from outbound requests.
                    //
                    // DO NOT "improve" this by echoing them back: Anthropic
                    // signs each thinking block and validates the `signature`
                    // on replay. This accumulator never captures
                    // `signature_delta`, so a replayed block would carry an
                    // empty/absent signature and the API answers
                    // 400 "Invalid `signature` in `thinking` block" — which
                    // bricks the whole session, not just one turn. Omitting
                    // prior-turn thinking entirely is explicitly permitted and
                    // is the safe half of the documented either/or.
                    //
                    // Echoing them back would require capturing signature_delta
                    // (appending, never overwriting — it arrives in several
                    // chunks) and storing it on ContentBlock::Thinking. That is
                    // only needed if extended thinking is ever enabled together
                    // with tool use; this driver does not request thinking.
                    ContentBlock::Thinking { .. } => None,
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

fn parse_api_response(resp: ApiResponse) -> Result<CompletionResponse, LlmError> {
    let mut content = vec![];
    let mut tool_calls = vec![];

    for block in resp.content {
        match block {
            ApiResponseBlock::Text { text } => {
                content.push(ContentBlock::Text { text });
            }
            ApiResponseBlock::ToolUse { id, name, input } => {
                if id.is_empty() || name.is_empty() || !input.is_object() {
                    return Err(LlmError::Parse("Anthropic response contained a tool call with a missing id/name or non-object input".into()));
                }
                content.push(ContentBlock::ToolUse {
                    id: id.clone(), name: name.clone(), input: input.clone(), provider_metadata: None,
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

    let stop_reason = resp.stop_reason.as_deref().map(parse_stop_reason).unwrap_or(StopReason::EndTurn);
    if !tool_calls.is_empty() && stop_reason != StopReason::ToolUse {
        return Err(LlmError::Parse("Anthropic returned tool_use blocks without stop_reason=tool_use".into()));
    }

    Ok(CompletionResponse {
        content,
        stop_reason,
        tool_calls,
        usage: TokenUsage {
            input_tokens: resp.usage.input_tokens,
            output_tokens: resp.usage.output_tokens,
            total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
        },
    })
}

#[cfg(test)]
mod anthropic_stream_tests {
    use super::*;

    fn noop() -> impl Fn(StreamEvent) + Send + Sync {
        |_| {}
    }

    fn feed(accum: &mut StreamAccumulator, raw: &str) {
        let json: serde_json::Value = serde_json::from_str(raw).unwrap();
        accum.process_sse(&json, &noop()).unwrap();
    }

    /// Anthropic documents message_delta usage as cumulative. Summing it
    /// inflated the reported (and billed) output tokens.
    #[test]
    fn cumulative_output_tokens_are_adopted_not_summed() {
        let mut accum = StreamAccumulator::new();
        feed(
            &mut accum,
            r#"{"type":"message_start","message":{"usage":{"input_tokens":1000,"output_tokens":3}}}"#,
        );
        // Several message_delta events, each repeating the RUNNING TOTAL.
        feed(&mut accum, r#"{"type":"message_delta","usage":{"output_tokens":50}}"#);
        feed(&mut accum, r#"{"type":"message_delta","usage":{"output_tokens":120}}"#);
        feed(
            &mut accum,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":200}}"#,
        );

        let done = accum.finish().unwrap();
        assert_eq!(done.usage.input_tokens, 1000);
        // Correct: the final cumulative value. Old behaviour: 3+50+120+200=373.
        assert_eq!(
            done.usage.output_tokens, 200,
            "output tokens must be the cumulative total, not a sum of deltas"
        );
    }

    #[test]
    fn a_single_message_delta_does_not_double_count_the_seed() {
        let mut accum = StreamAccumulator::new();
        feed(
            &mut accum,
            r#"{"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}"#,
        );
        feed(
            &mut accum,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}"#,
        );
        // Old behaviour: 1 + 42 = 43.
        assert_eq!(accum.finish().unwrap().usage.output_tokens, 42);
    }

    /// Replaying a thinking block without its signature is a hard 400 that
    /// bricks the session, so they must not reach the request body.
    fn wire_blocks(blocks: Vec<ContentBlock>) -> serde_json::Value {
        let msg = Message {
            role: Role::Assistant,
            content: MessageContent::Blocks(blocks),
        };
        serde_json::to_value(convert_message(&msg)).unwrap()
    }

    #[test]
    fn system_transcript_messages_are_folded_into_anthropic_system_prompt() {
        let req = CompletionRequest {
            model: "claude-sonnet-5-5".into(),
            messages: vec![
                Message {
                    role: Role::System,
                    content: MessageContent::Text("Earlier context summary".into()),
                },
                Message::user("continue"),
            ],
            tools: vec![],
            max_tokens: 64,
            temperature: 0.0,
            system: Some("Workspace instructions".into()),
        };
        let (system, present) = collect_system_prompt(&req);
        assert!(present);
        assert_eq!(system, "Workspace instructions\nEarlier context summary");
    }

    #[test]
    fn internal_context_summary_is_sent_as_user_content_not_system_instruction() {
        let message = Message {
            role: Role::Context,
            content: MessageContent::Text("lossy session note".into()),
        };
        let wire = serde_json::to_value(convert_message(&message)).unwrap();
        assert_eq!(wire["role"], "user");
    }

    #[test]
    fn zen_anthropic_route_uses_x_api_key_and_omits_empty_auth() {
        let driver = AnthropicDriver::with_bearer_auth(
            String::new(),
            Some("https://opencode.ai/zen/v1".into()),
            false,
        );
        let req = CompletionRequest {
            model: "claude-sonnet-4-6".into(),
            messages: vec![Message::user("hi")],
            tools: vec![],
            max_tokens: 32,
            temperature: 0.0,
            system: None,
        };
        let built = driver.build_request(&req, false).build().unwrap();
        assert!(built.headers().get("authorization").is_none());
        assert!(built.headers().get("x-api-key").is_none());

        let authenticated = AnthropicDriver::with_bearer_auth(
            "zen-secret".into(),
            Some("https://opencode.ai/zen/v1".into()),
            false,
        );
        let built = authenticated.build_request(&req, false).build().unwrap();
        assert_eq!(built.headers().get("x-api-key").unwrap(), "zen-secret");
        assert!(built.headers().get("authorization").is_none());
    }

    /// Replaying a thinking block without its signature is a hard 400 that
    /// bricks the session, so they must not reach the request body.
    #[test]
    fn thinking_blocks_are_stripped_from_outbound_requests() {
        let wire = wire_blocks(vec![
            ContentBlock::Thinking {
                thinking: "internal reasoning".into(),
            },
            ContentBlock::Text {
                text: "the answer".into(),
            },
        ]);
        let blocks = wire["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1, "only the text block may survive");
        assert_eq!(blocks[0]["type"], "text");
        assert!(
            !serde_json::to_string(&wire).unwrap().contains("thinking"),
            "a thinking block without a signature must never be sent back"
        );
    }

    #[test]
    fn tool_use_round_trips_and_a_non_object_input_is_normalised() {
        let wire = wire_blocks(vec![ContentBlock::ToolUse {
            id: "toolu_1".into(),
            name: "read_file".into(),
            input: serde_json::json!({"path": "a.txt"}),
            provider_metadata: None,
        }]);
        let blocks = wire["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "tool_use");
        assert_eq!(blocks[0]["id"], "toolu_1");
        assert_eq!(blocks[0]["input"]["path"], "a.txt");

        // The API rejects a non-object `input`; null must become {}.
        let wire = wire_blocks(vec![ContentBlock::ToolUse {
            id: "toolu_2".into(),
            name: "noop".into(),
            input: serde_json::Value::Null,
            provider_metadata: None,
        }]);
        let blocks = wire["content"].as_array().unwrap();
        assert!(blocks[0]["input"].is_object());
    }
}

#[cfg(test)]
mod openai_wire_tests {
    use super::*;

    /// Regression: a chunk boundary inside a multi-byte character used to
    /// destroy it, because each chunk was decoded with from_utf8_lossy before
    /// being appended. Bangla/CJK/emoji text corrupted at random points.
    #[test]
    fn multibyte_text_survives_a_split_chunk_boundary() {
        let payload = b"data: {\"text\":\"\xe0\xa6\x86\xe0\xa6\xae\xe0\xa6\xbf\"}\n\n";
        // Byte 16 falls INSIDE the first Bangla character (e0 a6 86), which is
        // what makes the lossy-per-chunk decode destroy it. Splitting in the
        // ASCII prefix would not reproduce the bug.
        let (a, b) = payload.split_at(16);

        // Old behaviour: decode each chunk separately.
        let broken = format!("{}{}", String::from_utf8_lossy(a), String::from_utf8_lossy(b));
        assert!(broken.contains('\u{fffd}'), "old path should corrupt");

        // New behaviour: accumulate bytes, decode whole frames only.
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(a);
        assert!(find_frame_end_bytes(&buf).is_none(), "frame is incomplete yet");
        buf.extend_from_slice(b);
        let (pos, sep) = find_frame_end_bytes(&buf).expect("frame completes");
        let frame = String::from_utf8_lossy(&buf[..pos]).into_owned();
        buf.drain(..pos + sep);

        assert!(!frame.contains('\u{fffd}'), "no replacement chars");
        let json: serde_json::Value =
            serde_json::from_str(frame.strip_prefix("data: ").unwrap()).unwrap();
        assert_eq!(json["text"], "\u{986}\u{9ae}\u{9bf}");
        assert!(buf.is_empty());
    }

    #[test]
    fn frame_finder_handles_both_terminators() {
        assert_eq!(find_frame_end_bytes(b"data: a\n\nrest"), Some((7, 2)));
        assert_eq!(find_frame_end_bytes(b"data: a\r\n\r\nrest"), Some((7, 4)));
        assert_eq!(find_frame_end_bytes(b"data: incomplete"), None);
        // CRLF earlier than LF must win, and vice versa.
        assert_eq!(find_frame_end_bytes(b"a\r\n\r\nb\n\n"), Some((1, 4)));
    }

    fn req(model: &str) -> CompletionRequest {
        CompletionRequest {
            model: model.to_string(),
            messages: vec![Message::user("hi")],
            system: None,
            tools: vec![],
            max_tokens: 1024,
            temperature: 0.2,
        }
    }

    #[test]
    fn reasoning_models_are_detected_by_family_prefix() {
        for m in ["o1", "o1-mini", "o3", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini"] {
            assert!(OpenAiDriver::is_reasoning_model(m), "{m} should be reasoning");
        }
        // Prefix match must not catch a merely similar name.
        for m in ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o1x-turbo", "gpt-50-turbo"] {
            assert!(!OpenAiDriver::is_reasoning_model(m), "{m} should NOT be reasoning");
        }
        // OpenRouter-style ids carry a vendor prefix.
        assert!(OpenAiDriver::is_reasoning_model("openai/o4-mini"));
        assert!(!OpenAiDriver::is_reasoning_model("openai/gpt-4o"));
    }

    #[test]
    fn temperature_is_omitted_only_for_reasoning_models() {
        // Reasoning model: sending temperature is a hard 400.
        let body = OpenAiDriver::build_body(&req("o4-mini"), false, true, true);
        assert!(body.get("temperature").is_none());
        // Regular chat model keeps the caller's value.
        let body = OpenAiDriver::build_body(&req("gpt-4o"), false, true, true);
        assert_eq!(body["temperature"].as_f64().unwrap(), 0.2_f32 as f64);
    }

    #[test]
    fn token_limit_field_is_provider_specific() {
        for m in ["gpt-4o", "o4-mini"] {
            let body = OpenAiDriver::build_body(&req(m), false, true, true);
            assert_eq!(body["max_completion_tokens"], 1024);
            assert!(body.get("max_tokens").is_none());
        }
        let compatible = OpenAiDriver::build_body(&req("model"), false, false, false);
        assert_eq!(compatible["max_tokens"], 1024);
        assert!(compatible.get("max_completion_tokens").is_none());
    }

    #[tokio::test]
    async fn non_streaming_gateway_uses_json_completion_and_emits_one_final_delta() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 { break; }
                request.extend_from_slice(&chunk[..count]);
                let text = String::from_utf8_lossy(&request);
                if let Some(header_end) = text.find("\r\n\r\n") {
                    let content_length = text[..header_end].lines()
                        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok()))
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + content_length { break; }
                }
            }
            let text = String::from_utf8_lossy(&request);
            let header_end = text.find("\r\n\r\n").unwrap();
            let body: serde_json::Value = serde_json::from_str(&text[header_end + 4..]).unwrap();
            assert_eq!(body["stream"], false);
            assert!(body.get("stream_options").is_none());
            assert!(body.get("tools").is_none());

            let response = serde_json::json!({
                "choices": [{"message": {"role": "assistant", "content": "AI Horde response"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}
            }).to_string();
            let wire = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(), response,
            );
            socket.write_all(wire.as_bytes()).await.unwrap();
        });

        let driver = OpenAiDriver::with_compat_options(
            "0000000000".into(),
            Some(format!("http://{address}/v1")),
            false,
            false,
        ).with_streaming_support(false);
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let on_event = move |event: StreamEvent| sink.lock().unwrap().push(event);
        let response = driver.stream(&req("koboldcpp/Llama-3.2-1B-Instruct"), &on_event).await.unwrap();
        server.await.unwrap();

        assert_eq!(response.text(), "AI Horde response");
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], StreamEvent::TextDelta(text) if text == "AI Horde response"));
        assert!(matches!(&events[1], StreamEvent::MessageDone(_)));
    }

    #[test]
    fn pollinations_uses_the_current_v1_chat_completions_path() {
        let driver = OpenAiDriver::with_compat_options(
            "pollinations-key".into(),
            Some("https://gen.pollinations.ai/v1".into()),
            false,
            false,
        );
        let built = driver.build_request(&req("openai"), false).build().unwrap();
        assert_eq!(built.url().as_str(), "https://gen.pollinations.ai/v1/chat/completions");
    }

    #[test]
    fn streaming_requests_ask_for_usage() {
        let body = OpenAiDriver::build_body(&req("gpt-4o"), true, true, true);
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        // Non-streaming must not carry stream_options.
        let body = OpenAiDriver::build_body(&req("gpt-4o"), false, true, true);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn a_usage_only_chunk_has_no_choices() {
        // This is the exact shape of the final chunk when include_usage is set.
        let chunk: serde_json::Value = serde_json::from_str(
            r#"{"choices":[],"usage":{"prompt_tokens":41,"completion_tokens":17,"total_tokens":58}}"#,
        )
        .unwrap();
        // Guard used by the stream loop: `.get(0)` is None for an empty array,
        // whereas the old `["choices"][0]` silently produced Null.
        assert!(chunk["choices"].get(0).is_none());
        let usage = OpenAiDriver::usage_from(&chunk["usage"]);
        assert_eq!(usage.input_tokens, 41);
        assert_eq!(usage.output_tokens, 17);
    }
}


#[cfg(test)]
mod retry_classification_tests {
    use super::LlmError;

    #[tokio::test]
    async fn refused_connection_is_classified_as_retryable_network_failure() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_millis(500))
            .build()
            .unwrap();
        let error = client
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap_err();
        let mapped = super::map_transport_error(error);
        assert!(matches!(mapped, LlmError::Network(_)));
        assert!(mapped.is_retryable());
    }

    #[test]
    fn retries_transient_errors_but_not_auth_or_invalid_request_errors() {
        assert!(LlmError::Timeout("read timeout".into()).is_retryable());
        assert!(LlmError::Network("connection refused".into()).is_retryable());
        assert!(LlmError::RateLimited { retry_after_ms: 1_000 }.is_retryable());
        assert!(LlmError::Overloaded { retry_after_ms: 1_000 }.is_retryable());
        assert!(LlmError::Api { status: 503, message: "temporary".into() }.is_retryable());
        assert!(!LlmError::Api { status: 401, message: "bad key".into() }.is_retryable());
        assert!(!LlmError::Api { status: 400, message: "invalid request".into() }.is_retryable());
        assert!(!LlmError::Parse("invalid wire format".into()).is_retryable());
    }
}
