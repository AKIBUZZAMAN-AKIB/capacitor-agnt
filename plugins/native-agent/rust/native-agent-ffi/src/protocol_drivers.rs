//! Native protocol adapters that cannot be represented as plain Chat Completions.
//!
//! OpenAI Responses, Google Gemini generateContent, and WebLLM do not share the
//! same tool-call lifecycle. Each adapter owns its wire-format translation and
//! validates tool arguments before they are handed to the agent loop.

use crate::llm_driver::{
    find_frame_end_bytes, map_transport_error, parse_retry_after_ms, safe_excerpt,
    emit_buffered_response, CompletionRequest, CompletionResponse, LlmDriver, LlmError,
    OpenAiDriver, StreamEvent, MAX_SSE_BUFFER_BYTES,
};
use crate::types::{
    ContentBlock, MessageContent, Role, StopReason, TokenUsage, ToolCall,
};
use async_trait::async_trait;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::time::Duration;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'))
}

fn api_error(status: u16, body: &str, retry_after: Option<u64>) -> LlmError {
    if status == 429 {
        return LlmError::RateLimited { retry_after_ms: retry_after.unwrap_or(5_000) };
    }
    if status == 529 || status == 503 {
        return LlmError::Overloaded { retry_after_ms: retry_after.unwrap_or(5_000) };
    }
    let message = serde_json::from_str::<Value>(body).ok()
        .and_then(|v| v.pointer("/error/message").or_else(|| v.pointer("/error"))
            .and_then(|e| e.as_str().map(str::to_string).or_else(|| Some(e.to_string()))))
        .unwrap_or_else(|| safe_excerpt(body, 400).to_string());
    LlmError::Api { status, message }
}

fn parse_sse_frame(frame: &str) -> Result<Option<Value>, LlmError> {
    let mut data_lines = Vec::new();
    for raw in frame.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.strip_prefix(' ').unwrap_or(data));
        }
    }
    if data_lines.is_empty() {
        return Ok(None);
    }
    let data = data_lines.join("\n");
    if data.trim() == "[DONE]" {
        return Ok(None);
    }
    serde_json::from_str(&data)
        .map(Some)
        .map_err(|e| LlmError::Parse(format!("Invalid JSON in provider SSE frame: {e}")))
}

async fn for_each_sse_json<F>(response: reqwest::Response, mut on_json: F) -> Result<(), LlmError>
where
    F: FnMut(Value) -> Result<(), LlmError>,
{
    let mut stream = response.bytes_stream();
    let mut buf = Vec::<u8>::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(map_transport_error)?);
        while let Some((pos, sep_len)) = find_frame_end_bytes(&buf) {
            let frame = String::from_utf8_lossy(&buf[..pos]).into_owned();
            buf.drain(..pos + sep_len);
            if let Some(json) = parse_sse_frame(&frame)? {
                on_json(json)?;
            }
        }
        if buf.len() > MAX_SSE_BUFFER_BYTES {
            return Err(LlmError::Http(format!("SSE buffer exceeded {MAX_SSE_BUFFER_BYTES} bytes without a complete frame")));
        }
    }
    if !buf.is_empty() {
        let frame = String::from_utf8_lossy(&buf).into_owned();
        if let Some(json) = parse_sse_frame(&frame)? {
            on_json(json)?;
        }
    }
    Ok(())
}

fn json_args(raw: &Value, provider: &str, tool_name: &str) -> Result<Value, LlmError> {
    let args = if let Some(encoded) = raw.as_str() {
        serde_json::from_str::<Value>(encoded)
            .map_err(|e| LlmError::Parse(format!("Invalid {provider} JSON arguments for '{tool_name}': {e}")))?
    } else if raw.is_object() {
        raw.clone()
    } else {
        return Err(LlmError::Parse(format!("{provider} arguments for '{tool_name}' must be a JSON object")));
    };
    if !args.is_object() {
        return Err(LlmError::Parse(format!("{provider} arguments for '{tool_name}' must decode to a JSON object")));
    }
    Ok(args)
}

fn response_usage(value: &Value) -> TokenUsage {
    let input = value.get("input_tokens").and_then(Value::as_u64).unwrap_or(0) as u32;
    let output = value.get("output_tokens").and_then(Value::as_u64).unwrap_or(0) as u32;
    let total = value.get("total_tokens").and_then(Value::as_u64).unwrap_or((input + output) as u64) as u32;
    TokenUsage { input_tokens: input, output_tokens: output, total_tokens: total }
}

// ── OpenAI Responses API ────────────────────────────────────────────────────

pub struct OpenAiResponsesDriver {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
    streaming_supported: bool,
    // Some OpenAI-compatible Responses gateways reject this field outright.
    // Keep sequential calls where supported, but omit it for those gateways.
    parallel_tool_calls_supported: bool,
}

impl OpenAiResponsesDriver {
    pub fn new(api_key: String, base_url: String) -> Self {
        Self { api_key, base_url, client: client(), streaming_supported: true, parallel_tool_calls_supported: true }
    }

    pub fn with_streaming_support(mut self, supported: bool) -> Self {
        self.streaming_supported = supported;
        self
    }

    pub fn without_parallel_tool_calls(mut self) -> Self {
        self.parallel_tool_calls_supported = false;
        self
    }

    fn input_items(req: &CompletionRequest) -> (Vec<Value>, String) {
        let mut input = Vec::new();
        let mut instructions = req.system.clone().unwrap_or_default();
        for message in &req.messages {
            if message.role == Role::System {
                let extra = match &message.content {
                    MessageContent::Text(text) => text.clone(),
                    MessageContent::Blocks(blocks) => blocks.iter().filter_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.as_str()), _ => None,
                    }).collect::<String>(),
                };
                if !extra.is_empty() {
                    if !instructions.is_empty() { instructions.push('\n'); }
                    instructions.push_str(&extra);
                }
                continue;
            }
            match &message.content {
                MessageContent::Text(text) => {
                    input.push(json!({"type":"message","role":if message.role == Role::Assistant {"assistant"} else {"user"},"content":[{"type":if message.role == Role::Assistant {"output_text"} else {"input_text"},"text":text}]}));
                }
                MessageContent::Blocks(blocks) => {
                    let role = if message.role == Role::Assistant { "assistant" } else { "user" };
                    let mut text_parts = Vec::new();
                    let mut function_items = Vec::new();
                    for block in blocks {
                        match block {
                            ContentBlock::Text { text } => text_parts.push(text.clone()),
                            ContentBlock::ToolUse { id, name, input, .. } if role == "assistant" => {
                                function_items.push(json!({"type":"function_call","call_id":id,"name":name,"arguments":input.to_string()}));
                            }
                            ContentBlock::ToolResult { tool_use_id, content, .. } => {
                                function_items.push(json!({"type":"function_call_output","call_id":tool_use_id,"output":content}));
                            }
                            ContentBlock::Thinking { .. } | ContentBlock::ServerToolUse { .. } | ContentBlock::WebSearchToolResult { .. } | ContentBlock::ToolUse { .. } => {}
                        }
                    }
                    if !text_parts.is_empty() {
                        input.push(json!({"type":"message","role":role,"content":[{"type":if role == "assistant" {"output_text"} else {"input_text"},"text":text_parts.join("")}]}));
                    }
                    input.extend(function_items);
                }
            }
        }
        (input, instructions)
    }

    fn build_body(&self, req: &CompletionRequest, stream: bool) -> Value {
        let (input, instructions) = Self::input_items(req);
        let tools: Vec<Value> = req.tools.iter().map(|tool| json!({
            "type":"function",
            "name":tool.name,
            "description":tool.description,
            "parameters":tool.input_schema,
            "strict":false,
        })).collect();
        let mut body = json!({
            "model":req.model,
            "input":input,
            "max_output_tokens":req.max_tokens,
            "stream":stream,
            "store":false,
        });
        if self.parallel_tool_calls_supported { body["parallel_tool_calls"] = json!(false); }
        if !instructions.is_empty() { body["instructions"] = json!(instructions); }
        if !tools.is_empty() {
            body["tools"] = json!(tools);
            body["tool_choice"] = json!("auto");
        }
        if !crate::llm_driver::OpenAiDriver::is_reasoning_model(&req.model) {
            body["temperature"] = json!(req.temperature);
        }
        body
    }

    fn request(&self, req: &CompletionRequest, stream: bool) -> reqwest::RequestBuilder {
        let mut builder = self.client.post(endpoint(&self.base_url, "responses"))
            .header("content-type", "application/json");
        if !self.api_key.is_empty() {
            builder = builder.bearer_auth(&self.api_key);
        }
        builder.json(&self.build_body(req, stream))
    }
}

fn response_tool_call(item: &Value) -> Result<ToolCall, LlmError> {
    let call_id = item.get("call_id").and_then(Value::as_str).filter(|s| !s.is_empty())
        .ok_or_else(|| LlmError::Parse("Responses function_call is missing call_id".into()))?;
    let name = item.get("name").and_then(Value::as_str).filter(|s| !s.is_empty())
        .ok_or_else(|| LlmError::Parse(format!("Responses function_call {call_id} is missing name")))?;
    let raw = item.get("arguments").ok_or_else(|| LlmError::Parse(format!("Responses function_call {call_id} is missing arguments")))?;
    let input = json_args(raw, "OpenAI Responses", name)?;
    Ok(ToolCall { id: call_id.to_string(), name: name.to_string(), input })
}

fn parse_responses_payload(value: &Value) -> Result<CompletionResponse, LlmError> {
    if let Some(error) = value.get("error") {
        return Err(LlmError::Api { status: 200, message: error.get("message").and_then(Value::as_str).unwrap_or("Responses API returned an error object").to_string() });
    }
    let output = value.get("output").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in output {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => {
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if matches!(part.get("type").and_then(Value::as_str), Some("output_text" | "text")) {
                            if let Some(piece) = part.get("text").and_then(Value::as_str) { text.push_str(piece); }
                        }
                    }
                }
            }
            "function_call" => calls.push(response_tool_call(&item)?),
            _ => {}
        }
    }
    if text.is_empty() {
        if let Some(output_text) = value.get("output_text").and_then(Value::as_str) { text = output_text.to_string(); }
    }
    let status = value.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "incomplete" && !calls.is_empty() {
        return Err(LlmError::Parse("Responses API ended an incomplete function call".into()));
    }
    let stop = if !calls.is_empty() {
        StopReason::ToolUse
    } else if status == "incomplete" || value.pointer("/incomplete_details/reason").and_then(Value::as_str) == Some("max_output_tokens") {
        StopReason::MaxTokens
    } else {
        StopReason::EndTurn
    };
    let usage = response_usage(value.get("usage").unwrap_or(&Value::Null));
    let mut content = Vec::new();
    if !text.is_empty() { content.push(ContentBlock::Text { text }); }
    for call in &calls {
        content.push(ContentBlock::ToolUse { id:call.id.clone(), name:call.name.clone(), input:call.input.clone(), provider_metadata:None });
    }
    Ok(CompletionResponse { content, stop_reason:stop, tool_calls:calls, usage })
}

#[derive(Default)]
struct ResponseCallAccum {
    id: String,
    name: String,
    arguments: String,
    has_arguments: bool,
}

#[async_trait]
impl LlmDriver for OpenAiResponsesDriver {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let response = self.request(req, false).send().await.map_err(map_transport_error)?;
        let status = response.status().as_u16();
        let retry_after = parse_retry_after_ms(response.headers());
        let body = response.text().await.map_err(map_transport_error)?;
        if status != 200 { return Err(api_error(status, &body, retry_after)); }
        let json: Value = serde_json::from_str(&body).map_err(|e| LlmError::Parse(format!("Invalid Responses JSON: {e}: {}", safe_excerpt(&body, 200))))?;
        parse_responses_payload(&json)
    }

    async fn stream(&self, req: &CompletionRequest, on_event: &(dyn Fn(StreamEvent) + Send + Sync)) -> Result<CompletionResponse, LlmError> {
        if !self.streaming_supported {
            let response = self.complete(req).await?;
            emit_buffered_response(&response, on_event);
            return Ok(response);
        }
        let response = self.request(req, true).send().await.map_err(map_transport_error)?;
        let status = response.status().as_u16();
        if status != 200 {
            let retry_after = parse_retry_after_ms(response.headers());
            let body = response.text().await.map_err(map_transport_error)?;
            return Err(api_error(status, &body, retry_after));
        }
        let mut text = String::new();
        let mut calls: BTreeMap<String, ResponseCallAccum> = BTreeMap::new();
        let mut final_response: Option<Value> = None;
        let on_json = |event: Value, text: &mut String, calls: &mut BTreeMap<String, ResponseCallAccum>, final_response: &mut Option<Value>| -> Result<(), LlmError> {
            let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
            match kind {
                "response.output_text.delta" => {
                    let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                    if !delta.is_empty() { text.push_str(delta); on_event(StreamEvent::TextDelta(delta.to_string())); }
                }
                "response.output_item.added" | "response.output_item.done" => {
                    let item = event.get("item").unwrap_or(&Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("function_call") {
                        let key = item.get("id").and_then(Value::as_str).or_else(|| event.get("item_id").and_then(Value::as_str)).unwrap_or("response-call").to_string();
                        let entry = calls.entry(key.clone()).or_default();
                        if let Some(id) = item.get("call_id").and_then(Value::as_str) { entry.id = id.to_string(); }
                        if let Some(name) = item.get("name").and_then(Value::as_str) { entry.name = name.to_string(); }
                        if let Some(args) = item.get("arguments") {
                            entry.arguments = args.as_str().map(str::to_string).unwrap_or_else(|| args.to_string());
                            entry.has_arguments = true;
                        }
                        if kind == "response.output_item.added" && !entry.id.is_empty() && !entry.name.is_empty() {
                            on_event(StreamEvent::ToolUseStart { id:entry.id.clone(), name:entry.name.clone() });
                        }
                    }
                }
                "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                    let key = if let Some(item_id) = event.get("item_id").and_then(Value::as_str) {
                        item_id.to_string()
                    } else if let Some(index) = event.get("output_index").and_then(Value::as_u64) {
                        format!("output-{index}")
                    } else {
                        "response-call".to_string()
                    };
                    let entry = calls.entry(key).or_default();
                    if let Some(id) = event.get("call_id").and_then(Value::as_str) { entry.id = id.to_string(); }
                    if let Some(name) = event.get("name").and_then(Value::as_str) { entry.name = name.to_string(); }
                    if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                        if kind.ends_with(".delta") { entry.arguments.push_str(delta); entry.has_arguments = true; }
                    }
                    if kind.ends_with(".done") {
                        if let Some(args) = event.get("arguments").and_then(Value::as_str) { entry.arguments = args.to_string(); entry.has_arguments = true; }
                    }
                }
                "response.completed" => { *final_response = event.get("response").cloned(); }
                "response.failed" | "error" => {
                    let message = event.pointer("/response/error/message").or_else(|| event.pointer("/error/message")).and_then(Value::as_str).unwrap_or("Responses stream failed");
                    return Err(LlmError::Api { status:500, message:message.to_string() });
                }
                _ => {}
            }
            Ok(())
        };
        for_each_sse_json(response, |event| on_json(event, &mut text, &mut calls, &mut final_response)).await?;
        let mut completion = if let Some(value) = final_response {
            parse_responses_payload(&value)?
        } else {
            let mut tool_calls = Vec::new();
            for (_, partial) in calls {
                if partial.id.is_empty() || partial.name.is_empty() || !partial.has_arguments {
                    return Err(LlmError::Parse("Responses stream ended with an incomplete function_call".into()));
                }
                let input = json_args(&Value::String(partial.arguments), "OpenAI Responses", &partial.name)?;
                tool_calls.push(ToolCall { id:partial.id, name:partial.name, input });
            }
            let stop = if !tool_calls.is_empty() { StopReason::ToolUse } else { StopReason::EndTurn };
            let mut content = Vec::new();
            if !text.is_empty() { content.push(ContentBlock::Text { text:text.clone() }); }
            for call in &tool_calls { content.push(ContentBlock::ToolUse { id:call.id.clone(), name:call.name.clone(), input:call.input.clone(), provider_metadata:None }); }
            CompletionResponse { content, stop_reason:stop, tool_calls, usage:TokenUsage::default() }
        };
        // The final response is authoritative, but text deltas remain the user
        // visible stream. If a gateway omitted text from the completed object,
        // preserve exactly what was streamed.
        if completion.text().is_empty() && !text.is_empty() {
            completion.content.insert(0, ContentBlock::Text { text });
        }
        for call in &completion.tool_calls {
            on_event(StreamEvent::ToolUseEnd { id:call.id.clone(), name:call.name.clone(), input:call.input.clone() });
        }
        on_event(StreamEvent::MessageDone(completion.clone()));
        Ok(completion)
    }
}

// ── Google Gemini generateContent ───────────────────────────────────────────

pub struct GeminiDriver {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
    streaming_supported: bool,
}

impl GeminiDriver {
    pub fn new(api_key: String, base_url: String) -> Self {
        Self { api_key, base_url, client:client(), streaming_supported: true }
    }

    pub fn with_streaming_support(mut self, supported: bool) -> Self {
        self.streaming_supported = supported;
        self
    }

    fn model_url(&self, model: &str, stream: bool) -> String {
        let model = model.strip_prefix("models/").unwrap_or(model);
        let safe_model: String = model.bytes().map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._".contains(&byte) { (byte as char).to_string() }
            else { format!("%{byte:02X}") }
        }).collect();
        let method = if stream { "streamGenerateContent?alt=sse" } else { "generateContent" };
        endpoint(&self.base_url, &format!("models/{safe_model}:{method}"))
    }

    fn request(&self, req: &CompletionRequest, stream: bool) -> reqwest::RequestBuilder {
        self.client.post(self.model_url(&req.model, stream))
            .header("x-goog-api-key", &self.api_key)
            .header("content-type", "application/json")
            .json(&Self::build_body(req))
    }

    fn build_body(req: &CompletionRequest) -> Value {
        let mut system = req.system.clone().unwrap_or_default();
        let mut contents = Vec::new();
        let mut call_names: std::collections::HashMap<String, (String, Option<String>)> = std::collections::HashMap::new();
        for message in &req.messages {
            if message.role == Role::System {
                let extra = content_text(&message.content);
                if !extra.is_empty() { if !system.is_empty() { system.push('\n'); } system.push_str(&extra); }
                continue;
            }
            let role = if message.role == Role::Assistant { "model" } else { "user" };
            let mut parts = Vec::new();
            match &message.content {
                MessageContent::Text(text) if !text.is_empty() => parts.push(json!({"text":text})),
                MessageContent::Text(_) => {}
                MessageContent::Blocks(blocks) => {
                    for block in blocks {
                        match block {
                            ContentBlock::Text { text } if !text.is_empty() => parts.push(json!({"text":text})),
                            ContentBlock::Text { .. } => {}
                            ContentBlock::ToolUse { id, name, input, provider_metadata } if role == "model" => {
                                let metadata = provider_metadata.as_ref();
                                let provider_call_id = metadata.and_then(|m| m.get("functionCallId")).and_then(Value::as_str).map(str::to_string);
                                call_names.insert(id.clone(), (name.clone(), provider_call_id.clone()));
                                let mut part = json!({"functionCall":{"name":name,"args":if input.is_object(){input.clone()}else{json!({})}}});
                                if let Some(call_id) = provider_call_id { part["functionCall"]["id"] = json!(call_id); }
                                if let Some(signature) = metadata.and_then(|m| m.get("thoughtSignature")).and_then(Value::as_str) { part["thoughtSignature"] = json!(signature); }
                                parts.push(part);
                            }
                            ContentBlock::ToolResult { tool_use_id, content, is_error } => {
                                let (name, provider_id) = call_names.get(tool_use_id).cloned().unwrap_or_else(|| ("unknown_tool".to_string(), None));
                                let mut response = if !*is_error {
                                    serde_json::from_str::<Value>(content).ok().filter(Value::is_object).unwrap_or_else(|| json!({"result":content}))
                                } else { json!({"error":content}) };
                                if !response.is_object() { response = json!({"result":response}); }
                                let mut function_response = json!({"name":name,"response":response});
                                if let Some(provider_id) = provider_id { function_response["id"] = json!(provider_id); }
                                parts.push(json!({"functionResponse":function_response}));
                            }
                            ContentBlock::Thinking { .. } | ContentBlock::ServerToolUse { .. } | ContentBlock::WebSearchToolResult { .. } | ContentBlock::ToolUse { .. } => {}
                        }
                    }
                }
            }
            if !parts.is_empty() { contents.push(json!({"role":role,"parts":parts})); }
        }
        let declarations: Vec<Value> = req.tools.iter().map(|tool| json!({
            "name":tool.name,
            "description":tool.description,
            "parameters":sanitize_gemini_schema(&tool.input_schema, 0),
        })).collect();
        let mut body = json!({"contents":contents,"generationConfig":{"maxOutputTokens":req.max_tokens,"temperature":req.temperature}});
        if !system.is_empty() { body["systemInstruction"] = json!({"parts":[{"text":system}]}); }
        if !declarations.is_empty() {
            body["tools"] = json!([{"functionDeclarations":declarations}]);
            body["toolConfig"] = json!({"functionCallingConfig":{"mode":"AUTO"}});
        }
        body
    }
}

fn content_text(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Blocks(blocks) => blocks.iter().filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()), _ => None,
        }).collect(),
    }
}

fn sanitize_gemini_schema(schema: &Value, depth: usize) -> Value {
    if depth > 24 || !schema.is_object() { return json!({"type":"object"}); }
    let mut out = Map::new();
    for key in ["type", "description", "format", "nullable", "enum", "required", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] {
        if let Some(value) = schema.get(key) { out.insert(key.to_string(), value.clone()); }
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        let mut safe = Map::new();
        for (key, value) in properties { safe.insert(key.clone(), sanitize_gemini_schema(value, depth + 1)); }
        out.insert("properties".into(), Value::Object(safe));
    }
    if let Some(items) = schema.get("items") { out.insert("items".into(), sanitize_gemini_schema(items, depth + 1)); }
    if !out.contains_key("type") { out.insert("type".into(), json!("object")); }
    Value::Object(out)
}

fn merge_json(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge_json(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target, source) => *target = source.clone(),
    }
}

#[derive(Default)]
struct GeminiCallAccum {
    id: String,
    provider_id: Option<String>,
    name: String,
    args: Value,
    thought_signature: Option<String>,
}

fn gemini_usage(value: &Value) -> TokenUsage {
    let input = value.get("promptTokenCount").and_then(Value::as_u64).unwrap_or(0) as u32;
    let output = value.get("candidatesTokenCount").and_then(Value::as_u64).unwrap_or(0) as u32;
    let total = value.get("totalTokenCount").and_then(Value::as_u64).unwrap_or((input + output) as u64) as u32;
    TokenUsage { input_tokens:input, output_tokens:output, total_tokens:total }
}

fn gemini_finish_reason(raw: Option<&str>, has_tools: bool) -> StopReason {
    match raw {
        Some("MAX_TOKENS") => StopReason::MaxTokens,
        Some("STOP") if has_tools => StopReason::ToolUse,
        Some("STOP") | Some("SAFETY") | Some("RECITATION") | Some("BLOCKLIST") | Some("PROHIBITED_CONTENT") => StopReason::EndTurn,
        _ if has_tools => StopReason::ToolUse,
        _ => StopReason::EndTurn,
    }
}

fn add_gemini_parts(value: &Value, text: &mut String, calls: &mut BTreeMap<String, GeminiCallAccum>, on_event: Option<&(dyn Fn(StreamEvent) + Send + Sync)>) -> Result<(), LlmError> {
    let candidates = value.get("candidates").and_then(Value::as_array).cloned().unwrap_or_default();
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        let parts = candidate.pointer("/content/parts").and_then(Value::as_array).cloned().unwrap_or_default();
        for (part_index, part) in parts.iter().enumerate() {
            if part.get("thought").and_then(Value::as_bool) == Some(true) { continue; }
            if let Some(piece) = part.get("text").and_then(Value::as_str) {
                if !piece.is_empty() {
                    text.push_str(piece);
                    if let Some(callback) = on_event { callback(StreamEvent::TextDelta(piece.to_string())); }
                }
            }
            if let Some(call) = part.get("functionCall") {
                let name = call.get("name").and_then(Value::as_str).filter(|v| !v.is_empty())
                    .ok_or_else(|| LlmError::Parse("Gemini functionCall is missing its name".into()))?.to_string();
                let provider_id = call.get("id").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
                let key = provider_id.clone().unwrap_or_else(|| format!("{candidate_index}:{part_index}:{name}"));
                let entry = calls.entry(key).or_default();
                if entry.id.is_empty() { entry.id = provider_id.clone().unwrap_or_else(|| format!("gemini-{}", uuid::Uuid::new_v4())); }
                if entry.provider_id.is_none() { entry.provider_id = provider_id; }
                entry.name = name;
                if let Some(args) = call.get("args") {
                    if !args.is_object() { return Err(LlmError::Parse(format!("Gemini arguments for '{}' must be an object", entry.name))); }
                    if !entry.args.is_object() { entry.args = json!({}); }
                    merge_json(&mut entry.args, args);
                }
                if let Some(signature) = part.get("thoughtSignature").and_then(Value::as_str) { entry.thought_signature = Some(signature.to_string()); }
            }
        }
    }
    Ok(())
}

fn build_gemini_completion(text: String, calls: BTreeMap<String, GeminiCallAccum>, finish: Option<&str>, usage: TokenUsage) -> Result<CompletionResponse, LlmError> {
    let mut tool_calls = Vec::new();
    let mut content = Vec::new();
    if !text.is_empty() { content.push(ContentBlock::Text { text }); }
    for (_, call) in calls {
        if call.id.is_empty() || call.name.is_empty() || !call.args.is_object() {
            return Err(LlmError::Parse("Gemini stream ended with an incomplete functionCall".into()));
        }
        let mut metadata = Map::new();
        if let Some(id) = call.provider_id { metadata.insert("functionCallId".into(), json!(id)); }
        if let Some(signature) = call.thought_signature { metadata.insert("thoughtSignature".into(), json!(signature)); }
        content.push(ContentBlock::ToolUse { id:call.id.clone(), name:call.name.clone(), input:call.args.clone(), provider_metadata:if metadata.is_empty(){None}else{Some(Value::Object(metadata))} });
        tool_calls.push(ToolCall { id:call.id, name:call.name, input:call.args });
    }
    if matches!(finish, Some("MAX_TOKENS")) && !tool_calls.is_empty() {
        return Err(LlmError::Parse("Gemini ended with MAX_TOKENS while emitting a functionCall".into()));
    }
    let stop_reason = gemini_finish_reason(finish, !tool_calls.is_empty());
    Ok(CompletionResponse { content, stop_reason, tool_calls, usage })
}

#[async_trait]
impl LlmDriver for GeminiDriver {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        let response = self.request(req, false).send().await.map_err(map_transport_error)?;
        let status = response.status().as_u16();
        let retry_after = parse_retry_after_ms(response.headers());
        let body = response.text().await.map_err(map_transport_error)?;
        if status != 200 { return Err(api_error(status, &body, retry_after)); }
        let value: Value = serde_json::from_str(&body).map_err(|e| LlmError::Parse(format!("Invalid Gemini JSON: {e}: {}", safe_excerpt(&body, 200))))?;
        if let Some(prompt_block) = value.pointer("/promptFeedback/blockReason").and_then(Value::as_str) {
            return Err(LlmError::Api { status:400, message:format!("Gemini blocked the prompt: {prompt_block}") });
        }
        let mut text = String::new();
        let mut calls = BTreeMap::new();
        add_gemini_parts(&value, &mut text, &mut calls, None)?;
        let finish = value.pointer("/candidates/0/finishReason").and_then(Value::as_str);
        build_gemini_completion(text, calls, finish, gemini_usage(value.get("usageMetadata").unwrap_or(&Value::Null)))
    }

    async fn stream(&self, req: &CompletionRequest, on_event: &(dyn Fn(StreamEvent) + Send + Sync)) -> Result<CompletionResponse, LlmError> {
        if !self.streaming_supported {
            let response = self.complete(req).await?;
            emit_buffered_response(&response, on_event);
            return Ok(response);
        }
        let response = self.request(req, true).send().await.map_err(map_transport_error)?;
        let status = response.status().as_u16();
        if status != 200 {
            let retry_after = parse_retry_after_ms(response.headers());
            let body = response.text().await.map_err(map_transport_error)?;
            return Err(api_error(status, &body, retry_after));
        }
        let mut text = String::new();
        let mut calls = BTreeMap::new();
        let mut finish: Option<String> = None;
        let mut usage = TokenUsage::default();
        for_each_sse_json(response, |value| {
            if let Some(block_reason) = value.pointer("/promptFeedback/blockReason").and_then(Value::as_str) {
                return Err(LlmError::Api { status:400, message:format!("Gemini blocked the prompt: {block_reason}") });
            }
            add_gemini_parts(&value, &mut text, &mut calls, Some(on_event))?;
            if let Some(reason) = value.pointer("/candidates/0/finishReason").and_then(Value::as_str) { finish = Some(reason.to_string()); }
            if let Some(metadata) = value.get("usageMetadata") { usage = gemini_usage(metadata); }
            Ok(())
        }).await?;
        let response = build_gemini_completion(text, calls, finish.as_deref(), usage)?;
        for call in &response.tool_calls { on_event(StreamEvent::ToolUseEnd { id:call.id.clone(), name:call.name.clone(), input:call.input.clone() }); }
        on_event(StreamEvent::MessageDone(response.clone()));
        Ok(response)
    }
}

// ── WebLLM browser/WebGPU bridge ────────────────────────────────────────────

/// One message from the WebView-hosted WebLLM runtime to the native agent.
#[derive(Debug, Clone)]
pub struct WebLlmBridgeMessage {
    pub response_json: String,
    pub is_final: bool,
    pub is_error: bool,
}

/// Pending request channels shared by the native FFI handle and WebLLM driver.
pub type WebLlmPending = Arc<std::sync::Mutex<HashMap<String, mpsc::UnboundedSender<WebLlmBridgeMessage>>>>;

pub fn new_webllm_pending() -> WebLlmPending {
    Arc::new(std::sync::Mutex::new(HashMap::new()))
}

struct PendingWebLlmRequest {
    request_id: String,
    pending: WebLlmPending,
}

impl Drop for PendingWebLlmRequest {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.request_id);
        }
    }
}

pub struct WebLlmDriver {
    callback: Option<Arc<dyn crate::NativeEventCallback>>,
    pending: WebLlmPending,
    session_key: String,
}

impl WebLlmDriver {
    pub fn new(
        callback: Option<Arc<dyn crate::NativeEventCallback>>,
        pending: WebLlmPending,
        session_key: String,
    ) -> Self {
        Self { callback, pending, session_key }
    }

    async fn run(
        &self,
        req: &CompletionRequest,
        on_event: &(dyn Fn(StreamEvent) + Send + Sync),
    ) -> Result<CompletionResponse, LlmError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::unbounded_channel::<WebLlmBridgeMessage>();
        self.pending.lock()
            .map_err(|_| LlmError::Http("WebLLM bridge registry is unavailable".into()))?
            .insert(request_id.clone(), tx);
        let _guard = PendingWebLlmRequest { request_id: request_id.clone(), pending: self.pending.clone() };

        // Reuse the OpenAI-shaped Chat Completions request body the WebLLM JS
        // API implements. It remains local to the app; it is never sent over
        // HTTP by this Rust adapter.
        let body = OpenAiDriver::build_body(req, true, false, false);
        crate::event_bus::emit(self.callback.as_deref(), "provider.request", &json!({
            "requestId": request_id,
            "provider": "webllm",
            "model": req.model,
            "request": body,
            "sessionKey": self.session_key,
        }));

        let mut saw_delta = false;
        loop {
            let message = tokio::time::timeout(Duration::from_secs(600), rx.recv())
                .await
                .map_err(|_| LlmError::Timeout("Timed out waiting for the WebView/WebGPU bridge".into()))?
                .ok_or_else(|| LlmError::Http("WebLLM bridge closed the request channel".into()))?;
            if message.is_error {
                let detail = serde_json::from_str::<Value>(&message.response_json).ok()
                    .and_then(|value| value.get("error").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| safe_excerpt(&message.response_json, 500).to_string());
                return Err(LlmError::Api { status: 400, message: detail });
            }

            let payload: Value = serde_json::from_str(&message.response_json)
                .map_err(|error| LlmError::Parse(format!("Invalid WebLLM bridge JSON: {error}")))?;
            if message.is_final {
                let response = crate::llm_driver::parse_chat_completion(&payload)?;
                if !saw_delta {
                    for block in &response.content {
                        match block {
                            ContentBlock::Text { text } if !text.is_empty() => on_event(StreamEvent::TextDelta(text.clone())),
                            ContentBlock::ToolUse { id, name, input, .. } => {
                                on_event(StreamEvent::ToolUseStart { id: id.clone(), name: name.clone() });
                                on_event(StreamEvent::ToolUseEnd { id: id.clone(), name: name.clone(), input: input.clone() });
                            }
                            _ => {}
                        }
                    }
                }
                on_event(StreamEvent::MessageDone(response.clone()));
                return Ok(response);
            }

            match payload.get("type").and_then(Value::as_str).unwrap_or("") {
                "text_delta" => {
                    let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() { saw_delta = true; on_event(StreamEvent::TextDelta(text.to_string())); }
                }
                "thinking_delta" => {
                    let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.is_empty() { saw_delta = true; on_event(StreamEvent::ThinkingDelta(text.to_string())); }
                }
                "tool_use_start" => {
                    let id = payload.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())
                        .ok_or_else(|| LlmError::Parse("WebLLM tool start is missing id".into()))?;
                    let name = payload.get("name").and_then(Value::as_str).filter(|s| !s.is_empty())
                        .ok_or_else(|| LlmError::Parse("WebLLM tool start is missing name".into()))?;
                    saw_delta = true;
                    on_event(StreamEvent::ToolUseStart { id: id.to_string(), name: name.to_string() });
                }
                "tool_use_end" => {
                    let id = payload.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())
                        .ok_or_else(|| LlmError::Parse("WebLLM tool end is missing id".into()))?;
                    let name = payload.get("name").and_then(Value::as_str).filter(|s| !s.is_empty())
                        .ok_or_else(|| LlmError::Parse("WebLLM tool end is missing name".into()))?;
                    let input = payload.get("input").filter(|value| value.is_object()).cloned()
                        .ok_or_else(|| LlmError::Parse("WebLLM tool arguments must be a JSON object".into()))?;
                    saw_delta = true;
                    on_event(StreamEvent::ToolUseEnd { id: id.to_string(), name: name.to_string(), input });
                }
                other => return Err(LlmError::Parse(format!("Unknown WebLLM bridge event '{other}'"))),
            }
        }
    }
}

#[async_trait]
impl LlmDriver for WebLlmDriver {
    async fn complete(&self, req: &CompletionRequest) -> Result<CompletionResponse, LlmError> {
        self.run(req, &|_| {}).await
    }

    async fn stream(
        &self,
        req: &CompletionRequest,
        on_event: &(dyn Fn(StreamEvent) + Send + Sync),
    ) -> Result<CompletionResponse, LlmError> {
        self.run(req, on_event).await
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use crate::types::{Message, ToolDefinition};

    fn request(model: &str) -> CompletionRequest {
        CompletionRequest { model:model.into(), messages:vec![Message::user("hi")], tools:vec![ToolDefinition{name:"lookup".into(), description:"lookup".into(), input_schema:json!({"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false}), webview_only:false, approval_policy:None}], max_tokens:512, temperature:0.2, system:Some("system".into()) }
    }

    #[test]
    fn responses_driver_omits_authorization_for_anonymous_access() {
        let anonymous = OpenAiResponsesDriver::new(String::new(), "https://example.invalid/v1".into());
        let completion = request("gpt-5");
        let built = anonymous.request(&completion, false).build().unwrap();
        assert!(built.headers().get("authorization").is_none());
        assert_eq!(built.url().as_str(), "https://example.invalid/v1/responses");

        let authenticated = OpenAiResponsesDriver::new("secret".into(), "https://example.invalid/v1".into());
        let built = authenticated.request(&completion, false).build().unwrap();
        assert_eq!(built.headers().get("authorization").unwrap(), "Bearer secret");
    }

    #[test]
    fn responses_function_tools_use_flat_schema_and_no_chat_shape() {
        let body = OpenAiResponsesDriver::new("key".into(), "https://example.invalid/v1".into()).build_body(&request("gpt-5"), false);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "lookup");
        assert!(body["tools"][0].get("function").is_none());
        assert_eq!(body["max_output_tokens"], 512);
        assert_eq!(body["store"], false);
    }

    #[test]
    fn responses_gateway_can_omit_unsupported_parallel_tool_calls() {
        let body = OpenAiResponsesDriver::new("key".into(), "https://example.invalid/v1".into())
            .without_parallel_tool_calls()
            .build_body(&request("gpt-oss-20b"), false);
        assert!(body.get("parallel_tool_calls").is_none());
        assert_eq!(body["tools"][0]["type"], "function");
    }

    #[test]
    fn responses_tool_arguments_must_be_a_json_object() {
        assert!(response_tool_call(&json!({"type":"function_call","call_id":"c1","name":"x","arguments":"not-json"})).is_err());
        assert!(response_tool_call(&json!({"type":"function_call","call_id":"c1","name":"x","arguments":"[]"})).is_err());
        assert_eq!(response_tool_call(&json!({"type":"function_call","call_id":"c1","name":"x","arguments":"{}"})).unwrap().input, json!({}));
    }

    #[test]
    fn gemini_uses_function_declarations_and_native_function_response_parts() {
        let mut req = request("gemini-3.8-flash");
        let driver = GeminiDriver::new("key".into(), "https://generativelanguage.googleapis.com/v1beta".into());
        let body = GeminiDriver::build_body(&req);
        assert!(body["tools"][0].get("functionDeclarations").is_some());
        assert_eq!(body["contents"][0]["role"], "user");
        assert!(body["contents"][0]["parts"][0].get("text").is_some());
        let _ = &driver;
        req.messages.push(Message::assistant_blocks(vec![ContentBlock::ToolUse{id:"internal".into(),name:"lookup".into(),input:json!({"q":"x"}),provider_metadata:Some(json!({"functionCallId":"google-id","thoughtSignature":"sig"}))}]));
        req.messages.push(Message::tool_result("internal", "{\"found\":true}", false));
        let body = GeminiDriver::build_body(&req);
        assert_eq!(body["contents"][1]["parts"][0]["functionCall"]["id"], "google-id");
        assert_eq!(body["contents"][1]["parts"][0]["thoughtSignature"], "sig");
        assert_eq!(body["contents"][2]["parts"][0]["functionResponse"]["id"], "google-id");
    }
}
