//! Provider registry, protocol selection, and live model discovery.
//!
//! This is deliberately provider-aware rather than treating every URL as an
//! OpenAI-compatible server. Model capability is tri-state: absent metadata is
//! `None`, never silently promoted to tool support.

use crate::runtime_config::AgentRuntimeConfig;
use crate::NativeAgentError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    AnthropicMessages,
    OpenAiChatCompletions,
    OpenAiResponses,
    GeminiGenerateContent,
    WebLlmChatCompletions,
}

impl ProviderProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AnthropicMessages => "anthropic_messages",
            Self::OpenAiChatCompletions => "openai_chat_completions",
            Self::OpenAiResponses => "openai_responses",
            Self::GeminiGenerateContent => "gemini_generate_content",
            Self::WebLlmChatCompletions => "webllm_chat_completions",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "anthropic_messages" => Some(Self::AnthropicMessages),
            "openai_chat_completions" => Some(Self::OpenAiChatCompletions),
            "openai_responses" => Some(Self::OpenAiResponses),
            "gemini_generate_content" => Some(Self::GeminiGenerateContent),
            "webllm_chat_completions" => Some(Self::WebLlmChatCompletions),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    Bearer,
    AnthropicApiKey,
    GoogleApiKey,
    None,
}

#[derive(Debug, Clone, Copy)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub default_protocol: ProviderProtocol,
    pub auth_scheme: AuthScheme,
    pub chat_requires_auth: bool,
    pub models_require_auth: bool,
    pub models_path: Option<&'static str>,
    /// `Some(false)` means the provider API itself has no tools field (AI Horde
    /// OpenAI shim); `None` means each model needs separate evidence.
    pub tools_supported_by_api: Option<bool>,
    pub default_model: Option<&'static str>,
}

const PROVIDERS: [ProviderSpec; 11] = [
    ProviderSpec {
        id: "anthropic",
        name: "Anthropic",
        base_url: "https://api.anthropic.com",
        default_protocol: ProviderProtocol::AnthropicMessages,
        auth_scheme: AuthScheme::AnthropicApiKey,
        chat_requires_auth: true,
        models_require_auth: true,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: Some("claude-sonnet-5-5"),
    },
    ProviderSpec {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        chat_requires_auth: true,
        models_require_auth: true,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: Some("gpt-6.1-sol"),
    },
    ProviderSpec {
        id: "gemini",
        name: "Google Gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta",
        default_protocol: ProviderProtocol::GeminiGenerateContent,
        auth_scheme: AuthScheme::GoogleApiKey,
        chat_requires_auth: true,
        models_require_auth: true,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: Some("gemini-3.8-flash"),
    },
    ProviderSpec {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        chat_requires_auth: true,
        models_require_auth: false,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: Some("anthropic/claude-sonnet-5.5"),
    },
    ProviderSpec {
        id: "ovhcloud",
        name: "OVHcloud AI Endpoints",
        base_url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        chat_requires_auth: false,
        models_require_auth: false,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        // The prior Mistral Nemo default is now marked unavailable in OVH's live
        // catalog. gpt-oss-20b is currently live and has documented Responses
        // API function calling support.
        default_model: Some("gpt-oss-20b"),
    },
    ProviderSpec {
        id: "aihorde",
        name: "AI Horde (OpenAI API shim)",
        base_url: "https://oai.aihorde.net/v1",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        chat_requires_auth: false,
        models_require_auth: false,
        models_path: Some("models"),
        tools_supported_by_api: Some(false),
        default_model: None,
    },
    ProviderSpec {
        id: "llm7",
        name: "LLM7",
        base_url: "https://api.llm7.io/v1",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        chat_requires_auth: true,
        models_require_auth: false,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: None,
    },
    ProviderSpec {
        id: "opencode_zen",
        name: "OpenCode Zen",
        base_url: "https://opencode.ai/zen/v1",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        chat_requires_auth: true,
        models_require_auth: false,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: Some("claude-sonnet-5-5"),
    },
    ProviderSpec {
        id: "kilo",
        name: "Kilo Gateway",
        base_url: "https://api.kilo.ai/api/gateway",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        // The default `kilo-auto/efficient` tier requires an account key. The
        // live catalog marks anonymous `isFree` entries, which are overridden
        // per-model through `providerModelAuthRequirements`.
        chat_requires_auth: true,
        models_require_auth: false,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: Some("kilo-auto/efficient"),
    },
    ProviderSpec {
        id: "pollinations",
        name: "Pollinations",
        // Current unified API root. OpenAiDriver appends `/chat/completions`
        // and the public model catalog appends `/models`.
        base_url: "https://gen.pollinations.ai/v1",
        default_protocol: ProviderProtocol::OpenAiChatCompletions,
        auth_scheme: AuthScheme::Bearer,
        chat_requires_auth: true,
        models_require_auth: false,
        models_path: Some("models"),
        tools_supported_by_api: Some(true),
        default_model: None,
    },
    ProviderSpec {
        id: "webllm",
        name: "WebLLM (local WebGPU)",
        base_url: "",
        default_protocol: ProviderProtocol::WebLlmChatCompletions,
        auth_scheme: AuthScheme::None,
        chat_requires_auth: false,
        models_require_auth: false,
        models_path: None,
        tools_supported_by_api: None,
        default_model: Some("Llama-3.2-1B-Instruct-q4f16_1-MLC"),
    },
];

pub fn provider_ids() -> &'static [&'static str] {
    &["anthropic", "openai", "gemini", "openrouter", "ovhcloud", "aihorde", "llm7", "opencode_zen", "kilo", "pollinations", "webllm"]
}

pub fn protocol_supported_for_provider(provider: &str, protocol: ProviderProtocol) -> bool {
    match provider {
        "anthropic" => protocol == ProviderProtocol::AnthropicMessages,
        "openai" => matches!(protocol, ProviderProtocol::OpenAiChatCompletions | ProviderProtocol::OpenAiResponses),
        "gemini" => protocol == ProviderProtocol::GeminiGenerateContent,
        "openrouter" | "aihorde" | "llm7" | "kilo" | "pollinations" => protocol == ProviderProtocol::OpenAiChatCompletions,
        "ovhcloud" => matches!(protocol, ProviderProtocol::OpenAiChatCompletions | ProviderProtocol::OpenAiResponses),
        "opencode_zen" => matches!(protocol, ProviderProtocol::AnthropicMessages | ProviderProtocol::OpenAiChatCompletions | ProviderProtocol::OpenAiResponses | ProviderProtocol::GeminiGenerateContent),
        "webllm" => protocol == ProviderProtocol::WebLlmChatCompletions,
        _ => false,
    }
}

pub fn provider_spec(provider: &str) -> Option<&'static ProviderSpec> {
    PROVIDERS.iter().find(|profile| profile.id == provider)
}

pub fn default_model(provider: &str) -> Option<&'static str> {
    provider_spec(provider).and_then(|profile| profile.default_model)
}

pub fn resolved_base_url(provider: &str, runtime: &AgentRuntimeConfig, workspace_path: &str) -> Option<String> {
    let spec = provider_spec(provider)?;
    if let Some(url) = runtime.provider_base_urls.get(provider) {
        if let Some(url) = crate::runtime_config::normalize_provider_base_url(url) {
            return Some(url);
        }
    }
    if let Some(url) = crate::workspace::provider_base_url(workspace_path, provider) {
        return Some(url);
    }
    if spec.base_url.is_empty() { None } else { Some(spec.base_url.to_string()) }
}

pub fn protocol_for_model(provider: &str, model: &str, runtime: &AgentRuntimeConfig) -> Option<ProviderProtocol> {
    if let Some(protocol) = runtime.provider_model_protocols.get(provider).and_then(|models| models.get(model)) {
        return Some(*protocol);
    }
    match provider {
        "opencode_zen" => zen_protocol_for_model(model),
        "openai" if is_openai_responses_model(model) => Some(ProviderProtocol::OpenAiResponses),
        "ovhcloud" if is_ovh_responses_model(model) => Some(ProviderProtocol::OpenAiResponses),
        "webllm" => Some(ProviderProtocol::WebLlmChatCompletions),
        _ => provider_spec(provider).map(|profile| profile.default_protocol),
    }
}

pub fn zen_protocol_for_model(model: &str) -> Option<ProviderProtocol> {
    let id = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    if id.starts_with("claude-")
        || matches!(id.as_str(), "qwen3.8-flash" | "qwen3.7-max" | "qwen3.7-plus" | "qwen3.6-plus" | "qwen3.5-plus")
    {
        return Some(ProviderProtocol::AnthropicMessages);
    }
    if id.starts_with("gemini-") {
        return Some(ProviderProtocol::GeminiGenerateContent);
    }
    if id.starts_with("gpt-") || id.starts_with("grok-") || id.starts_with("muse-spark-") {
        return Some(ProviderProtocol::OpenAiResponses);
    }
    if matches!(
        id.as_str(),
        "qwen3.8-max"
            | "big-pickle"
            | "exo-free"
            | "mimo-v2.6-flash-free"
            | "space-bunny-free"
            | "longcat-2.5-preview-free"
            | "ling-3.0-flash-fin-free"
            | "ling-3.1-flash-free"
            | "nemotron-3-ultra-free"
            | "nemotron-3.5-lightning-free"
            | "fledge-alpha-free"
    ) || id.starts_with("deepseek-")
        || id.starts_with("minimax-")
        || id.starts_with("mistral-")
        || id.starts_with("glm-")
        || id.starts_with("kimi-")
    {
        return Some(ProviderProtocol::OpenAiChatCompletions);
    }
    // Jev is documented as a separate System One decision protocol, not chat
    // completions. Deliberately return None until a dedicated adapter exists.
    None
}

fn is_openai_responses_model(model: &str) -> bool {
    let id = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    id.starts_with("gpt-5") || id.starts_with("gpt-6") || id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4")
}

fn is_ovh_responses_model(model: &str) -> bool {
    let id = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    id.starts_with("gpt-oss-")
}

pub fn tool_capability(provider: &str, model: &str, runtime: &AgentRuntimeConfig) -> (Option<bool>, &'static str) {
    if let Some(value) = runtime.provider_tool_capabilities.get(provider).and_then(|models| models.get(model)) {
        return (Some(*value), "user_or_catalog_config");
    }
    let spec = match provider_spec(provider) {
        Some(spec) => spec,
        None => return (None, "unknown_provider"),
    };
    if spec.tools_supported_by_api == Some(false) {
        return (Some(false), "provider_api_schema");
    }
    let id = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    let documented = match provider {
        "anthropic" => id.starts_with("claude-"),
        "openai" => is_openai_tool_model(&id),
        "gemini" => is_gemini_tool_model(&id),
        "ovhcloud" => is_ovh_tool_model(&id),
        // Zen's listed Claude, Gemini, and OpenAI families use their vendor's
        // native tool-call protocol. Keep the rest unknown until the gateway
        // exposes per-model tool metadata or the user confirms it.
        "opencode_zen" if id.starts_with("claude-") => true,
        "opencode_zen" if id.starts_with("gemini-") => is_gemini_tool_model(&id),
        "opencode_zen" if is_openai_tool_model(&id) => true,
        _ => false,
    };
    if documented {
        (Some(true), "vendor_documentation")
    } else {
        (None, "not_reported")
    }
}

fn is_openai_tool_model(id: &str) -> bool {
    ["gpt-4o", "gpt-4.1", "gpt-5", "gpt-6", "o1", "o3", "o4"]
        .iter()
        .any(|prefix| id == *prefix || id.starts_with(&format!("{}-", prefix)))
}

fn is_gemini_tool_model(id: &str) -> bool {
    // The official model guide documents function calling for Gemini content
    // generation models. Exclude media, embedding, and live-only variants; a
    // `generateContent` listing alone is not enough for an arbitrary family.
    let supported_family = ["gemini-2.5-", "gemini-3."]
        .iter()
        .any(|prefix| id.starts_with(prefix));
    supported_family
        && !["-image", "-tts", "-live", "-embedding", "-audio"]
            .iter()
            .any(|suffix| id.contains(suffix))
}

fn is_ovh_tool_model(id: &str) -> bool {
    matches!(
        id,
        "mistral-nemo-instruct-2407"
            | "meta-llama-3_3-70b-instruct"
            | "gpt-oss-20b"
            | "gpt-oss-120b"
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub is_default: bool,
    /// `None` means the live catalog/vendor documentation does not say.
    pub tool_calling: Option<bool>,
    pub tool_calling_source: String,
    /// Catalog tier-specific key requirement; provider defaults are conservative.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_requirement_source: Option<String>,
    /// Model/provider streaming capability; false routes through a buffered completion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming_supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming_capability_source: Option<String>,
    /// Kilo catalog flag; true means prompts may be logged or used for training.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub may_train_on_your_prompts: Option<bool>,
    /// Zen is model-specific; unknown Zen models intentionally have no route.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProviderProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<String>,
}

/// Resolve chat authentication at model granularity where a provider's catalog
/// exposes tiers (Kilo `isFree`, LLM7 `tier`). Unknown models retain the
/// provider's conservative default rather than accidentally attempting a paid
/// endpoint without credentials.
pub fn model_auth_required(provider: &str, model: &str, runtime: &AgentRuntimeConfig) -> bool {
    runtime.provider_model_auth_requirements.get(provider)
        .and_then(|models| models.get(model)).copied()
        .or_else(|| provider_spec(provider).map(|spec| spec.chat_requires_auth))
        .unwrap_or(true)
}

/// Resolve model streaming support from saved per-model metadata, falling back
/// to the provider API contract (AI Horde's published shim has no SSE).
pub fn model_streaming_supported(provider: &str, model: &str, runtime: &AgentRuntimeConfig) -> bool {
    runtime.provider_model_streaming_capabilities.get(provider)
        .and_then(|models| models.get(model)).copied()
        .unwrap_or(provider != "aihorde")
}

fn catalog_auth_requirement(provider: &str, entry: &Value) -> Option<bool> {
    match provider {
        "kilo" => entry.get("isFree").and_then(Value::as_bool).map(|is_free| !is_free),
        "llm7" => match entry.get("tier").and_then(Value::as_str) {
            Some("turbo") => Some(false),
            Some("pro") => Some(true),
            _ => None,
        },
        _ => None,
    }
}

fn catalog_stream_requirement(provider: &str, entry: &Value) -> Option<bool> {
    match provider {
        "llm7" => entry.get("stream").and_then(Value::as_bool),
        // Gemini's model catalog advertises `generateContent`; streaming is the
        // same generation method with the documented `streamGenerateContent`
        // transport. Live-only models are filtered from this driver.
        "gemini" => entry.get("supportedGenerationMethods").and_then(Value::as_array).map(|methods| {
            methods.iter().any(|method| method.as_str() == Some("streamGenerateContent"))
                || methods.iter().any(|method| method.as_str() == Some("generateContent"))
        }),
        "aihorde" => Some(false),
        "ovhcloud" => entry.pointer("/metadata/model_specs/capabilities/streaming").and_then(Value::as_bool),
        _ => None,
    }
}

fn model_may_train_on_your_prompts(provider: &str, model: &str, entry: &Value) -> Option<bool> {
    if let Some(value) = entry.get("mayTrainOnYourPrompts").and_then(Value::as_bool) {
        return Some(value);
    }
    if provider != "opencode_zen" {
        return None;
    }
    // OpenCode Zen's privacy page identifies these limited-time/free tiers as
    // allowing prompt collection or use to improve/train models. The model API
    // itself returns IDs only, so preserve this vendor-documented warning here.
    let id = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    const ZEN_PROMPT_DATA_USE_EXCEPTIONS: &[&str] = &[
        "big-pickle",
        "exo-free",
        "fledge-alpha-free",
        "mimo-v2.5-free",
        "mimo-v2.6-flash-free",
        "ling-3.0-flash-fin-free",
        "ling-3.1-flash-free",
        "nemotron-3-ultra-free",
        "nemotron-3.5-lightning-free",
        "muse-spark-1.3-contributor-free",
    ];
    if ZEN_PROMPT_DATA_USE_EXCEPTIONS.contains(&id.as_str()) {
        return Some(true);
    }
    // These tiers are explicitly described as zero-retention/no-training in
    // the same vendor policy. Retention for other upstream providers may differ.
    const ZEN_NO_TRAINING_CONFIRMED: &[&str] = &[
        "space-bunny-free",
        "longcat-2.5-preview-free",
        "jev-1.13-free",
    ];
    ZEN_NO_TRAINING_CONFIRMED.contains(&id.as_str()).then_some(false)
}

fn model_entries(root: &Value) -> Vec<&Value> {
    if let Some(entries) = root.as_array() {
        return entries.iter().collect();
    }
    for key in ["data", "models"] {
        if let Some(entries) = root.get(key).and_then(Value::as_array) {
            return entries.iter().collect();
        }
    }
    Vec::new()
}

fn model_id(entry: &Value) -> Option<String> {
    let raw = entry.get("id").or_else(|| entry.get("name"))?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.strip_prefix("models/").unwrap_or(raw).to_string())
}

fn explicit_tools(entry: &Value) -> Option<bool> {
    if let Some(value) = entry.pointer("/metadata/model_specs/capabilities/function_calling").and_then(Value::as_bool) {
        return Some(value);
    }
    for field in ["tools_calling", "tools", "function_calling"] {
        if let Some(value) = entry.get(field).and_then(Value::as_bool) {
            return Some(value);
        }
    }
    for field in ["capabilities", "supported_features"] {
        let Some(capabilities) = entry.get(field) else { continue; };
        if let Some(value) = capabilities.get("tools").and_then(Value::as_bool) {
            return Some(value);
        }
        if let Some(value) = capabilities.get("tool_calling").and_then(Value::as_bool) {
            return Some(value);
        }
        if let Some(items) = capabilities.as_array() {
            if items.iter().any(|v| matches!(v.as_str(), Some("tool_calling" | "function_calling" | "tools"))) {
                return Some(true);
            }
        }
    }
    if let Some(parameters) = entry.get("supported_parameters").and_then(Value::as_array) {
        return Some(parameters.iter().any(|v| v.as_str() == Some("tools")));
    }
    None
}

fn is_text_model(provider: &str, entry: &Value) -> bool {
    if provider == "ovhcloud" {
        // The runtime `/v1/models` response contains canonical API IDs but no
        // category metadata. It is cross-checked against the public OVH Catalog
        // API in `enrich_ovh_model_capabilities` before being returned. When
        // parsing the Catalog API itself, apply its availability/capabilities.
        if entry.get("available").is_none() && entry.pointer("/metadata/model_specs/capabilities").is_none() {
            return true;
        }
        if entry.get("available").and_then(Value::as_bool) != Some(true) {
            return false;
        }
        let category = entry.get("category").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        let category_v2 = entry.get("category_v2").and_then(Value::as_str).unwrap_or("");
        let capabilities = entry.pointer("/metadata/model_specs/capabilities");
        let input_text = capabilities.and_then(|value| value.get("input_modality"))
            .and_then(Value::as_array).map(|items| items.iter().any(|item| item.as_str() == Some("text"))).unwrap_or(false);
        let output_text = capabilities.and_then(|value| value.get("output_modality"))
            .and_then(Value::as_array).map(|items| items.iter().any(|item| item.as_str() == Some("text"))).unwrap_or(false);
        return output_text && input_text && (category.contains("llm") || category_v2 == "Text Generation");
    }
    if provider == "openai" {
        let id = model_id(entry).unwrap_or_default().to_ascii_lowercase();
        // OpenAI's /models resource also contains embeddings, moderation,
        // audio, images, and realtime models. This agent currently issues
        // text-only chat/Responses requests, so never present those as routes.
        let non_chat_prefixes = ["text-embedding-", "whisper-", "tts-", "dall-e", "gpt-image", "omni-moderation", "text-moderation", "audio-", "transcribe-"];
        if non_chat_prefixes.iter().any(|prefix| id.starts_with(prefix))
            || id.contains("moderation") || id.contains("realtime") || id.contains("transcribe")
            || id.starts_with("gpt-4o-audio") || id.starts_with("gpt-audio")
        {
            return false;
        }
    }
    if provider == "gemini" {
        return entry.get("supportedGenerationMethods")
            .and_then(Value::as_array)
            .map(|items| items.iter().any(|v| v.as_str() == Some("generateContent")))
            .unwrap_or(false);
    }
    if provider == "llm7" {
        // This adapter sends OpenAI Chat Completions. The live LLM7 catalog can
        // list Anthropic-only schema routes as well, so do not expose those to
        // an OpenAI-wire driver.
        if let Some(endpoints) = entry.get("schema_endpoints").and_then(Value::as_array) {
            if !endpoints.iter().any(|value| value.as_str() == Some("openai")) {
                return false;
            }
        }
    }
    if let Some(category) = entry.get("category").and_then(Value::as_str) {
        if category != "text" && category != "chat" {
            return false;
        }
    }
    if let Some(model_type) = entry.get("model_type").and_then(Value::as_str) {
        if model_type != "chat" {
            return false;
        }
    }
    let input_modalities = entry.pointer("/architecture/input_modalities").and_then(Value::as_array)
        .or_else(|| entry.pointer("/modalities/input").and_then(Value::as_array));
    if let Some(modalities) = input_modalities {
        if !modalities.iter().any(|value| value.as_str() == Some("text")) {
            return false;
        }
    }
    let output_modalities = entry.pointer("/architecture/output_modalities").and_then(Value::as_array)
        .or_else(|| entry.pointer("/modalities/output").and_then(Value::as_array));
    if let Some(modalities) = output_modalities {
        if !modalities.iter().any(|value| value.as_str() == Some("text")) {
            return false;
        }
    }
    if let Some(modality) = entry.pointer("/architecture/modality").and_then(Value::as_str) {
        if let Some((inputs, outputs)) = modality.split_once("->") {
            if !inputs.to_ascii_lowercase().contains("text") || !outputs.to_ascii_lowercase().contains("text") {
                return false;
            }
        }
    }
    true
}

fn protocol_source(provider: &str, model: &str, protocol: Option<ProviderProtocol>, runtime: &AgentRuntimeConfig) -> Option<String> {
    protocol?;
    if runtime.provider_model_protocols.get(provider).and_then(|m| m.get(model)).is_some() {
        return Some("runtime_config".into());
    }
    if provider == "opencode_zen" || (provider == "openai" && is_openai_responses_model(model)) || (provider == "ovhcloud" && is_ovh_responses_model(model)) {
        return Some("vendor_documentation".into());
    }
    Some("provider_default".into())
}

fn model_context_length(entry: &Value) -> Option<u64> {
    entry.get("context_length").and_then(Value::as_u64)
        .or_else(|| entry.pointer("/context_window/tokens").and_then(Value::as_u64))
        .or_else(|| entry.pointer("/top_provider/context_length").and_then(Value::as_u64))
        .or_else(|| entry.get("inputTokenLimit").and_then(Value::as_u64))
}

pub fn parse_model_catalog(provider: &str, root: &Value, runtime: &AgentRuntimeConfig) -> Vec<ProviderModelInfo> {
    let spec = match provider_spec(provider) { Some(s) => s, None => return Vec::new() };
    let mut result = Vec::new();
    for entry in model_entries(root) {
        if !is_text_model(provider, entry) { continue; }
        let Some(id) = model_id(entry) else { continue; };
        let capability = explicit_tools(entry).map(|value| (Some(value), "provider_catalog".to_string()))
            .unwrap_or_else(|| {
                let (value, source) = tool_capability(provider, &id, runtime);
                (value, source.to_string())
            });
        let protocol = protocol_for_model(provider, &id, runtime);
        let auth_requirement = catalog_auth_requirement(provider, entry)
            .map(|value| (value, "provider_catalog".to_string()))
            .or_else(|| runtime.provider_model_auth_requirements.get(provider)
                .and_then(|models| models.get(&id)).copied().map(|value| (value, "runtime_config".to_string())))
            .unwrap_or((spec.chat_requires_auth, "provider_default".to_string()));
        let streaming_requirement = catalog_stream_requirement(provider, entry)
            .map(|value| (value, "provider_catalog".to_string()))
            .or_else(|| runtime.provider_model_streaming_capabilities.get(provider)
                .and_then(|models| models.get(&id)).copied().map(|value| (value, "runtime_config".to_string())))
            .unwrap_or((provider != "aihorde", "provider_default".to_string()));
        let may_train_on_your_prompts = model_may_train_on_your_prompts(provider, &id, entry);
        let name = entry.get("name").and_then(Value::as_str)
            .or_else(|| entry.get("title").and_then(Value::as_str))
            .or_else(|| entry.get("display_name").and_then(Value::as_str))
            .unwrap_or(&id).to_string();
        let description = entry.get("description").and_then(Value::as_str)
            .filter(|text| !text.is_empty()).map(|text| text.to_string());
        let health = entry.pointer("/health/status").and_then(Value::as_str)
            .or_else(|| entry.get("status").and_then(Value::as_str)).map(str::to_string);
        result.push(ProviderModelInfo {
            is_default: runtime.default_models.get(provider).map(|m| m == &id)
                .unwrap_or_else(|| spec.default_model == Some(id.as_str())),
            id: id.clone(),
            name,
            description,
            tool_calling: capability.0,
            tool_calling_source: capability.1,
            auth_required: Some(auth_requirement.0),
            auth_requirement_source: Some(auth_requirement.1),
            streaming_supported: Some(streaming_requirement.0),
            streaming_capability_source: Some(streaming_requirement.1),
            may_train_on_your_prompts,
            protocol_source: protocol_source(provider, &id, protocol, runtime),
            protocol,
            context_length: model_context_length(entry),
            health,
        });
    }
    result.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    result
}

fn webllm_models(runtime: &AgentRuntimeConfig) -> Vec<ProviderModelInfo> {
    let ids = [
        "SmolLM2-360M-Instruct-q4f16_1-MLC",
        "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
        "Llama-3.2-1B-Instruct-q4f16_1-MLC",
        "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
        "gemma-2-2b-it-q4f16_1-MLC",
        "Phi-3.5-mini-instruct-q4f16_1-MLC",
        "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    ];
    ids.iter().map(|id| {
        let (tools, source) = tool_capability("webllm", id, runtime);
        ProviderModelInfo {
            id: (*id).to_string(), name: (*id).to_string(), description: Some("Local WebGPU model; model weights download on first use.".into()),
            is_default: runtime.default_models.get("webllm").map(|m| m == id).unwrap_or(Some(*id) == default_model("webllm")),
            tool_calling: tools, tool_calling_source: source.to_string(),
            auth_required: Some(false), auth_requirement_source: Some("provider_default".into()),
            streaming_supported: Some(true), streaming_capability_source: Some("provider_default".into()),
            may_train_on_your_prompts: None,
            protocol: Some(ProviderProtocol::WebLlmChatCompletions), protocol_source: Some("webllm_runtime".into()),
            context_length: None, health: None,
        }
    }).collect()
}

fn provider_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

fn models_url(provider: &str, base: &str, spec: &ProviderSpec) -> Option<String> {
    let path = spec.models_path?;
    if provider == "anthropic" && !base.trim_end_matches('/').ends_with("/v1") {
        Some(provider_url(base, &format!("v1/{path}")))
    } else {
        Some(provider_url(base, path))
    }
}

fn apply_auth(builder: reqwest::RequestBuilder, spec: &ProviderSpec, api_key: Option<&str>) -> reqwest::RequestBuilder {
    let key = match (spec.id, api_key.filter(|value| !value.trim().is_empty())) {
        ("aihorde", None) => Some("0000000000"),
        (_, value) => value,
    };
    match (spec.auth_scheme, key) {
        (AuthScheme::Bearer, Some(key)) => builder.bearer_auth(key),
        (AuthScheme::AnthropicApiKey, Some(key)) => builder.header("x-api-key", key).header("anthropic-version", "2023-06-01"),
        (AuthScheme::GoogleApiKey, Some(key)) => builder.header("x-goog-api-key", key),
        _ => builder,
    }
}

async fn enrich_ovh_model_capabilities(mut models: Vec<ProviderModelInfo>) -> Result<Vec<ProviderModelInfo>, NativeAgentError> {
    // OVHcloud's OpenAI-compatible /v1/models endpoint carries exact model
    // IDs but not tool-capability flags. Their separate public Catalog API is
    // the source of truth for availability and function_calling metadata.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| NativeAgentError::Llm { msg: format!("Could not create OVHcloud catalog client: {e}") })?;
    let response = client.get("https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2").send().await
        .map_err(|_| NativeAgentError::Llm { msg: "OVHcloud capability catalog request failed (network or timeout)".into() })?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(NativeAgentError::Llm { msg: format!("OVHcloud capability catalog returned HTTP {status}") });
    }
    let bytes = response.bytes().await.map_err(|_| NativeAgentError::Llm { msg: "OVHcloud capability catalog response could not be read".into() })?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(NativeAgentError::Llm { msg: "OVHcloud capability catalog exceeded the 16 MiB safety limit".into() });
    }
    let catalog: Value = serde_json::from_slice(&bytes)
        .map_err(|e| NativeAgentError::Llm { msg: format!("OVHcloud capability catalog JSON is invalid: {e}") })?;
    let entries = catalog.as_array().ok_or_else(|| NativeAgentError::Llm {
        msg: "OVHcloud capability catalog did not return a model array".into(),
    })?;
    let mut enriched = Vec::with_capacity(models.len());
    for mut model in models.drain(..) {
        let matched = entries.iter().find(|entry| {
            let id_matches = entry.get("id").and_then(Value::as_str)
                .map(|id| id.eq_ignore_ascii_case(&model.id)).unwrap_or(false);
            let alias_matches = entry.pointer("/metadata/aliases").and_then(Value::as_array)
                .map(|aliases| aliases.iter().filter_map(Value::as_str).any(|alias| alias.eq_ignore_ascii_case(&model.id)))
                .unwrap_or(false);
            (id_matches || alias_matches) && entry.get("available").and_then(Value::as_bool) == Some(true)
        });
        if let Some(entry) = matched {
            if let Some(capability) = explicit_tools(entry) {
                model.tool_calling = Some(capability);
                model.tool_calling_source = "ovhcloud_catalog_api".into();
            }
            if let Some(streaming) = catalog_stream_requirement("ovhcloud", entry) {
                model.streaming_supported = Some(streaming);
                model.streaming_capability_source = Some("ovhcloud_catalog_api".into());
            }
            model.description = entry.get("description").and_then(Value::as_str)
                .filter(|value| !value.is_empty()).map(str::to_string).or_else(|| model.description.clone());
            enriched.push(model);
        }
        // Models absent from the current catalog or marked unavailable are
        // dropped; `/v1/models` alone is not enough to verify deployability.
    }
    Ok(enriched)
}

/// Fetch a provider's current text/chat model catalog. API keys are read from
/// the native auth store by the FFI facade; this module never persists secrets.
pub async fn list_models(
    provider: &str,
    api_key: Option<&str>,
    runtime: &AgentRuntimeConfig,
    workspace_path: &str,
) -> Result<Vec<ProviderModelInfo>, NativeAgentError> {
    let spec = provider_spec(provider).ok_or_else(|| NativeAgentError::Agent { msg: format!("Unsupported provider '{provider}'") })?;
    if provider == "webllm" {
        return Ok(webllm_models(runtime));
    }
    if spec.models_require_auth && api_key.filter(|key| !key.trim().is_empty()).is_none() {
        return Err(NativeAgentError::Auth { msg: format!("A {} key is required to list models", spec.name) });
    }
    let base = resolved_base_url(provider, runtime, workspace_path)
        .ok_or_else(|| NativeAgentError::Agent { msg: format!("No HTTP endpoint is configured for {}", spec.name) })?;
    let url = models_url(provider, &base, spec)
        .ok_or_else(|| NativeAgentError::Agent { msg: format!("{} does not expose a remote model catalog", spec.name) })?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| NativeAgentError::Llm { msg: format!("Could not create model-catalog client: {e}") })?;
    let response = apply_auth(client.get(&url), spec, api_key).send().await
        .map_err(|_| NativeAgentError::Llm { msg: format!("{} model catalog request failed (network or timeout)", spec.name) })?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let retry_after = response.headers().get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()).unwrap_or("").to_string();
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body).ok()
            .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| crate::llm_driver::safe_excerpt(&body, 240).to_string());
        return Err(NativeAgentError::Llm { msg: format!("{} model catalog returned HTTP {status}: {}{}", spec.name, detail, if retry_after.is_empty() { String::new() } else { format!(" (Retry-After: {retry_after})") }) });
    }
    let bytes = response.bytes().await.map_err(|_| NativeAgentError::Llm { msg: format!("{} model catalog response could not be read", spec.name) })?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(NativeAgentError::Llm { msg: format!("{} model catalog exceeded the 16 MiB safety limit", spec.name) });
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|e| NativeAgentError::Llm { msg: format!("{} model catalog JSON is invalid: {e}", spec.name) })?;
    let mut models = parse_model_catalog(provider, &body, runtime);
    if provider == "ovhcloud" {
        models = enrich_ovh_model_capabilities(models).await?;
    }
    if models.is_empty() {
        return Err(NativeAgentError::Llm { msg: format!("{} returned no text-generation models in its current catalog", spec.name) });
    }
    Ok(models)
}

pub fn list_models_json(models: &[ProviderModelInfo]) -> String {
    serde_json::to_string(models).unwrap_or_else(|_| "[]".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_party_and_gateway_defaults_match_current_api_model_ids() {
        assert_eq!(default_model("anthropic"), Some("claude-sonnet-5-5"));
        assert_eq!(default_model("openai"), Some("gpt-6.1-sol"));
        assert_eq!(default_model("gemini"), Some("gemini-3.8-flash"));
        assert_eq!(default_model("ovhcloud"), Some("gpt-oss-20b"));
        assert_eq!(default_model("openrouter"), Some("anthropic/claude-sonnet-5.5"));
        assert_eq!(default_model("opencode_zen"), Some("claude-sonnet-5-5"));
    }

    #[test]
    fn pollinations_model_catalog_uses_the_new_unified_v1_root() {
        let spec = provider_spec("pollinations").unwrap();
        assert_eq!(spec.base_url, "https://gen.pollinations.ai/v1");
        assert_eq!(
            models_url("pollinations", spec.base_url, spec).as_deref(),
            Some("https://gen.pollinations.ai/v1/models")
        );
    }

    #[test]
    fn zen_routes_known_model_families_to_the_documented_wire_protocol() {
        assert_eq!(zen_protocol_for_model("gpt-5.5"), Some(ProviderProtocol::OpenAiResponses));
        assert_eq!(zen_protocol_for_model("claude-sonnet-4-6"), Some(ProviderProtocol::AnthropicMessages));
        assert_eq!(zen_protocol_for_model("gemini-3.8-flash"), Some(ProviderProtocol::GeminiGenerateContent));
        assert_eq!(zen_protocol_for_model("qwen3.8-max"), Some(ProviderProtocol::OpenAiChatCompletions));
        assert_eq!(zen_protocol_for_model("big-pickle"), Some(ProviderProtocol::OpenAiChatCompletions));
        assert_eq!(zen_protocol_for_model("space-bunny-free"), Some(ProviderProtocol::OpenAiChatCompletions));
        assert_eq!(zen_protocol_for_model("muse-spark-1.3-contributor-free"), Some(ProviderProtocol::OpenAiResponses));
        assert_eq!(zen_protocol_for_model("jev-1.13-free"), None);
        assert_eq!(zen_protocol_for_model("a-new-unknown-model"), None);
    }

    #[test]
    fn tool_capability_is_model_specific_and_unknown_is_not_true() {
        let config = AgentRuntimeConfig::default();
        assert_eq!(tool_capability("anthropic", "claude-sonnet-4-6", &config).0, Some(true));
        assert_eq!(tool_capability("ovhcloud", "gpt-oss-20b", &config).0, Some(true));
        assert_eq!(protocol_for_model("ovhcloud", "gpt-oss-20b", &config), Some(ProviderProtocol::OpenAiResponses));
        assert_eq!(tool_capability("aihorde", "llama", &config).0, Some(false));
        assert_eq!(tool_capability("opencode_zen", "claude-sonnet-5-5", &config).0, Some(true));
        assert_eq!(tool_capability("opencode_zen", "gemini-3.8-flash", &config).0, Some(true));
        assert_eq!(tool_capability("opencode_zen", "new-model", &config).0, None);
    }

    #[test]
    fn live_catalogs_preserve_model_auth_stream_tool_and_privacy_metadata() {
        let runtime = AgentRuntimeConfig::default();
        let llm7 = serde_json::json!([
            {"id":"llm7-pro","model_type":"chat","schema_endpoints":["openai"],"tier":"pro","stream":false,"tools_calling":false,"context_window":{"tokens":100000}},
            {"id":"llm7-turbo","model_type":"chat","schema_endpoints":["anthropic","openai"],"tier":"turbo","stream":true,"tools_calling":true},
            {"id":"llm7-anthropic-only","model_type":"chat","schema_endpoints":["anthropic"],"tier":"turbo","stream":true,"tools_calling":true},
            {"id":"llm7-audio","model_type":"audio_to_text","schema_endpoints":["openai"],"tier":"pro","stream":false}
        ]);
        let models = parse_model_catalog("llm7", &llm7, &runtime);
        assert_eq!(models.len(), 2);
        let pro = models.iter().find(|model| model.id == "llm7-pro").unwrap();
        assert_eq!(pro.auth_required, Some(true));
        assert_eq!(pro.streaming_supported, Some(false));
        assert_eq!(pro.tool_calling, Some(false));
        assert_eq!(pro.context_length, Some(100_000));
        assert!(!models.iter().any(|model| model.id == "llm7-anthropic-only"));
        let turbo = models.iter().find(|model| model.id == "llm7-turbo").unwrap();
        assert_eq!(turbo.auth_required, Some(false));
        assert_eq!(turbo.streaming_supported, Some(true));
        assert_eq!(turbo.tool_calling, Some(true));
        assert!(model_auth_required("llm7", "llm7-pro", &runtime));

        let kilo = serde_json::json!([
            {"id":"kilo-auto/efficient","name":"Auto Efficient","isFree":false,"architecture":{"output_modalities":["text"]},"supported_parameters":["tools"]},
            {"id":"kilo-auto/free","name":"Auto Free","isFree":true,"mayTrainOnYourPrompts":true,"architecture":{"input_modalities":["text"],"output_modalities":["text"]},"supported_parameters":["tools"]},
            {"id":"kilo-audio","name":"Audio transcription","isFree":false,"architecture":{"modality":"audio->text","input_modalities":["audio"],"output_modalities":["text"]},"supported_parameters":["tools"]}
        ]);
        let models = parse_model_catalog("kilo", &kilo, &runtime);
        assert_eq!(models.len(), 2);
        let efficient = models.iter().find(|model| model.id == "kilo-auto/efficient").unwrap();
        assert_eq!(efficient.auth_required, Some(true));
        assert_eq!(efficient.tool_calling, Some(true));
        let free = models.iter().find(|model| model.id == "kilo-auto/free").unwrap();
        assert_eq!(free.auth_required, Some(false));
        assert_eq!(free.tool_calling, Some(true));
        assert_eq!(free.may_train_on_your_prompts, Some(true));

        let gemini = serde_json::json!([
            {"name":"models/gemini-3.8-flash","supportedGenerationMethods":["generateContent"]}
        ]);
        let models = parse_model_catalog("gemini", &gemini, &runtime);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-3.8-flash");
        assert_eq!(models[0].streaming_supported, Some(true));
        assert_eq!(models[0].streaming_capability_source.as_deref(), Some("provider_catalog"));

        let mut configured = runtime.clone();
        configured.provider_model_auth_requirements.entry("kilo".into()).or_default()
            .insert("custom-model".into(), false);
        configured.provider_model_streaming_capabilities.entry("aihorde".into()).or_default()
            .insert("custom-model".into(), true);
        assert!(!model_auth_required("kilo", "custom-model", &configured));
        assert!(model_streaming_supported("aihorde", "custom-model", &configured));
        assert!(!model_streaming_supported("aihorde", "other-model", &runtime));
    }

    #[test]
    fn ovh_catalog_filters_unavailable_and_reads_function_calling_metadata() {
        let runtime = AgentRuntimeConfig::default();
        let root = serde_json::json!([
            {
                "id":"gpt-oss-20b",
                "name":"GPT-OSS 20B",
                "available":true,
                "category":"Reasoning LLM",
                "category_v2":"Text Generation",
                "metadata":{"model_specs":{"capabilities":{
                    "input_modality":["text"],"output_modality":["text"],"function_calling":true,"streaming":true
                }}}
            },
            {
                "id":"mistral-nemo-instruct-2407","name":"Mistral Nemo","available":false,
                "category":"Large Language Models (LLM)","category_v2":"Text Generation",
                "metadata":{"model_specs":{"capabilities":{
                    "input_modality":["text"],"output_modality":["text"],"function_calling":true,"streaming":true
                }}}
            },
            {
                "id":"not-ready","name":"Not ready","available":false,
                "category":"Large Language Models (LLM)","category_v2":"Text Generation"
            },
            {
                "id":"embedding","name":"Embedding","available":true,
                "category":"Embeddings","category_v2":"Embeddings"
            }
        ]);
        let models = parse_model_catalog("ovhcloud", &root, &runtime);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-oss-20b");
        assert_eq!(models[0].tool_calling, Some(true));
        assert_eq!(models[0].tool_calling_source, "provider_catalog");
        assert_eq!(models[0].streaming_supported, Some(true));
        assert_eq!(models[0].streaming_capability_source.as_deref(), Some("provider_catalog"));
    }

    #[test]
    fn zen_catalog_applies_documented_prompt_data_use_warning() {
        let runtime = AgentRuntimeConfig::default();
        let root = serde_json::json!({"data":[
            {"id":"muse-spark-1.3-contributor-free"},
            {"id":"muse-spark-1.2-contributor-free"},
            {"id":"space-bunny-free"},
            {"id":"claude-sonnet-5-5"},
            {"id":"some-future-model"}
        ]});
        let models = parse_model_catalog("opencode_zen", &root, &runtime);
        assert_eq!(models.iter().find(|model| model.id == "muse-spark-1.3-contributor-free").unwrap().may_train_on_your_prompts, Some(true));
        assert_eq!(models.iter().find(|model| model.id == "space-bunny-free").unwrap().may_train_on_your_prompts, Some(false));
        assert_eq!(models.iter().find(|model| model.id == "muse-spark-1.2-contributor-free").unwrap().may_train_on_your_prompts, None);
        assert_eq!(models.iter().find(|model| model.id == "claude-sonnet-5-5").unwrap().may_train_on_your_prompts, None);
        assert_eq!(models.iter().find(|model| model.id == "some-future-model").unwrap().may_train_on_your_prompts, None);
    }

    #[test]
    fn catalog_metadata_keeps_false_and_unknown_distinct() {
        let runtime = AgentRuntimeConfig::default();
        let root = serde_json::json!({"data":[
            {"id":"with-tools","tools_calling":true},
            {"id":"without-tools","tools_calling":false},
            {"id":"unreported"}
        ]});
        let models = parse_model_catalog("llm7", &root, &runtime);
        assert_eq!(models.iter().find(|m| m.id == "with-tools").unwrap().tool_calling, Some(true));
        assert_eq!(models.iter().find(|m| m.id == "without-tools").unwrap().tool_calling, Some(false));
        assert_eq!(models.iter().find(|m| m.id == "unreported").unwrap().tool_calling, None);
    }
}
