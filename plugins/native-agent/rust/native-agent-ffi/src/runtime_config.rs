//! Persisted, app-owned runtime tunables for the native agent.
//!
//! The file lives next to `.native-agent-config.json`, outside the agent's
//! workspace sandbox. Native Capacitor APIs validate and atomically write it;
//! this module re-validates on every load so malformed/manual edits fall back
//! to safe defaults instead of breaking the agent or widening permissions.

use crate::provider_catalog::{protocol_supported_for_provider, provider_ids, ProviderProtocol};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = ".native-agent-runtime.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRuntimeConfig {
    /// Sampling temperature accepted by the configured provider (0–2).
    pub temperature: f64,
    /// Maximum output tokens per completion request.
    pub max_tokens: u32,
    /// Default interactive turn count; a per-message/skill value takes priority.
    pub default_max_turns: u32,
    /// Approximate whole-request character budget. System/tools/output reserve
    /// is subtracted before transcript compaction.
    pub context_char_budget: usize,
    /// Maximum wait for a WebView-hosted MCP tool response.
    pub mcp_tool_timeout_ms: u64,
    /// Number of retries after the first LLM request attempt.
    pub max_retries: u32,
    /// Initial client-side exponential backoff (provider Retry-After is honoured).
    pub base_retry_delay_ms: u64,
    /// Ceiling for client-side exponential backoff.
    pub max_retry_delay_ms: u64,
    /// Default tool-loop limit for cron jobs without a skill override.
    pub default_cron_max_turns: u32,
    /// Default tool-loop limit for heartbeat runs without a skill override.
    pub default_heartbeat_max_turns: u32,
    /// Default wall-clock budget for an ordinary cron run.
    pub default_cron_timeout_ms: u64,
    /// Default wall-clock budget for a heartbeat run.
    pub default_heartbeat_timeout_ms: u64,
    /// Default provider for messages that do not select one explicitly.
    pub default_provider: String,
    /// Per-provider model defaults; per-message and skill values take priority.
    pub default_models: HashMap<String, String>,
    /// Per-provider API base URL overrides. Secrets are never stored here.
    pub provider_base_urls: HashMap<String, String>,
    /// Explicit protocol overrides for models whose gateway protocol is model-specific.
    pub provider_model_protocols: HashMap<String, HashMap<String, ProviderProtocol>>,
    /// Model-level tool capability confirmations/catalog metadata. Unknown is absent.
    pub provider_tool_capabilities: HashMap<String, HashMap<String, bool>>,
    /// Per-model authentication requirements from live catalogs (e.g. free-tier gateways).
    pub provider_model_auth_requirements: HashMap<String, HashMap<String, bool>>,
    /// Per-model streaming capability from the provider catalog. Absent uses provider defaults.
    pub provider_model_streaming_capabilities: HashMap<String, HashMap<String, bool>>,
    /// Free-only cross-provider order and transient-only fallback controls for
    /// `defaultProvider: auto`. Automatic routing rejects any model that is not
    /// a provider-documented free route, even if this list was manually edited.
    pub auto_routing: AutoRoutingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoRoutingConfig {
    pub provider_order: Vec<String>,
    pub failover_on_transient: bool,
    pub max_fallbacks: u32,
}

impl Default for AutoRoutingConfig {
    fn default() -> Self {
        Self {
            // `auto` is the Free Router. Keep its order deliberately short and
            // model-specific: both virtual routers are provider-maintained
            // free-only sets, so a stale paid catalog default can never leak
            // into an automatic fallback.
            provider_order: vec!["kilo".into(), "openrouter".into()],
            failover_on_transient: true,
            max_fallbacks: 3,
        }
    }
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            temperature: 0.0,
            max_tokens: 8_192,
            default_max_turns: 25,
            context_char_budget: 150_000,
            mcp_tool_timeout_ms: 30_000,
            max_retries: 2,
            base_retry_delay_ms: 2_000,
            max_retry_delay_ms: 30_000,
            default_cron_max_turns: 10,
            default_heartbeat_max_turns: 5,
            default_cron_timeout_ms: 25_000,
            default_heartbeat_timeout_ms: 25_000,
            // A new workspace starts on the no-cost router. Paid providers are
            // still available only when the user selects one explicitly.
            default_provider: "auto".into(),
            default_models: HashMap::from([
                ("kilo".into(), "kilo-auto/free".into()),
                ("openrouter".into(), "openrouter/free".into()),
            ]),
            provider_base_urls: HashMap::new(),
            provider_model_protocols: HashMap::new(),
            provider_tool_capabilities: HashMap::new(),
            provider_model_auth_requirements: HashMap::new(),
            provider_model_streaming_capabilities: HashMap::new(),
            auto_routing: AutoRoutingConfig::default(),
        }
    }
}

impl AgentRuntimeConfig {
    /// Validate the complete stored settings object, including values written
    /// outside the Capacitor setter (e.g. an interrupted/manual file edit).
    pub fn validate(mut self) -> Result<Self, String> {
        if !self.temperature.is_finite() || !(0.0..=2.0).contains(&self.temperature) {
            return Err("temperature must be finite and between 0 and 2".into());
        }
        if !(1..=200_000).contains(&self.max_tokens) {
            return Err("maxTokens must be between 1 and 200000".into());
        }
        if !(1..=100).contains(&self.default_max_turns) {
            return Err("defaultMaxTurns must be between 1 and 100".into());
        }
        if !(10_000..=1_000_000).contains(&self.context_char_budget) {
            return Err("contextCharBudget must be between 10000 and 1000000".into());
        }
        if !(1_000..=300_000).contains(&self.mcp_tool_timeout_ms) {
            return Err("mcpToolTimeoutMs must be between 1000 and 300000".into());
        }
        if self.max_retries > 5 {
            return Err("maxRetries must be between 0 and 5".into());
        }
        if self.base_retry_delay_ms > 30_000 {
            return Err("baseRetryDelayMs must be between 0 and 30000".into());
        }
        if self.max_retry_delay_ms < self.base_retry_delay_ms || self.max_retry_delay_ms > 120_000 {
            return Err("maxRetryDelayMs must be at least baseRetryDelayMs and at most 120000".into());
        }
        if !(1..=100).contains(&self.default_cron_max_turns) {
            return Err("defaultCronMaxTurns must be between 1 and 100".into());
        }
        if !(1..=100).contains(&self.default_heartbeat_max_turns) {
            return Err("defaultHeartbeatMaxTurns must be between 1 and 100".into());
        }
        if !(1_000..=120_000).contains(&self.default_cron_timeout_ms) {
            return Err("defaultCronTimeoutMs must be between 1000 and 120000".into());
        }
        if !(1_000..=120_000).contains(&self.default_heartbeat_timeout_ms) {
            return Err("defaultHeartbeatTimeoutMs must be between 1000 and 120000".into());
        }
        let providers = provider_ids();
        if self.default_provider != "auto" && !providers.contains(&self.default_provider.as_str()) {
            return Err("defaultProvider must be auto or one of the configured provider ids".into());
        }
        if self.default_models.len() > providers.len() {
            return Err("defaultModels accepts at most the configured provider count".into());
        }
        for (provider, model) in &mut self.default_models {
            if !providers.contains(&provider.as_str()) {
                return Err(format!("unsupported defaultModels key '{provider}'"));
            }
            let normalized_model = model.trim();
            if normalized_model.is_empty() || normalized_model.len() > 512 {
                return Err(format!("defaultModels.{provider} must contain 1–512 bytes"));
            }
            *model = normalized_model.to_string();
        }
        if self.provider_base_urls.len() > providers.len() {
            return Err("providerBaseUrls accepts at most the configured provider count".into());
        }
        for (provider, raw_url) in &self.provider_base_urls {
            if !providers.contains(&provider.as_str()) || provider == "webllm" {
                return Err(format!("unsupported providerBaseUrls key '{provider}'"));
            }
            let url = normalize_provider_base_url(raw_url)
                .ok_or_else(|| format!("providerBaseUrls.{provider} must be a credential-free HTTP(S) URL with a host"))?;
            if url.len() > 2_048 {
                return Err(format!("providerBaseUrls.{provider} exceeds the 2048 byte limit"));
            }
        }

        if self.auto_routing.provider_order.len() > providers.len() {
            return Err("autoRouting.providerOrder has too many providers".into());
        }
        if self.default_provider == "auto" && self.auto_routing.provider_order.is_empty() {
            return Err("autoRouting.providerOrder cannot be empty when defaultProvider is auto".into());
        }
        if self.auto_routing.max_fallbacks > 10 {
            return Err("autoRouting.maxFallbacks must be between 0 and 10".into());
        }
        let mut seen = std::collections::HashSet::new();
        for provider in &self.auto_routing.provider_order {
            if !providers.contains(&provider.as_str()) {
                return Err(format!("unsupported autoRouting provider '{provider}'"));
            }
            if !seen.insert(provider.as_str()) {
                return Err(format!("autoRouting.providerOrder contains duplicate '{provider}'"));
            }
        }

        validate_model_map(&self.provider_model_protocols, "providerModelProtocols", providers, |provider, model, protocol| {
            if !protocol_supported_for_provider(provider, *protocol) {
                return Err(format!("providerModelProtocols.{provider}.{model} uses an incompatible protocol '{}'", protocol.as_str()));
            }
            Ok(())
        })?;
        validate_model_map(&self.provider_tool_capabilities, "providerToolCapabilities", providers, |provider, model, supported| {
            if provider == "aihorde" && *supported {
                return Err(format!("providerToolCapabilities.{provider}.{model}: AI Horde's published OpenAI shim schema has no tools field"));
            }
            Ok(())
        })?;
        validate_model_map(&self.provider_model_auth_requirements, "providerModelAuthRequirements", providers, |_, _, _| Ok(()))?;
        validate_model_map(&self.provider_model_streaming_capabilities, "providerModelStreamingCapabilities", providers, |_, _, _| Ok(()))?;
        Ok(self)
    }
}

fn validate_model_map<T, F>(
    map: &HashMap<String, HashMap<String, T>>,
    field: &str,
    providers: &[&str],
    mut validate_value: F,
) -> Result<(), String>
where
    F: FnMut(&str, &str, &T) -> Result<(), String>,
{
    if map.len() > providers.len() {
        return Err(format!("{field} accepts at most the configured provider count"));
    }
    for (provider, models) in map {
        if !providers.contains(&provider.as_str()) {
            return Err(format!("unsupported {field} key '{provider}'"));
        }
        if models.len() > 256 {
            return Err(format!("{field}.{provider} accepts at most 256 models"));
        }
        for (model, value) in models {
            if model.trim().is_empty() || model.len() > 512 {
                return Err(format!("{field}.{provider} model id must contain 1–512 bytes"));
            }
            validate_value(provider, model, value)?;
        }
    }
    Ok(())
}

/// Match `workspace::provider_base_url`'s endpoint safety rules and strip a
/// trailing slash so provider paths are appended exactly once.
pub fn normalize_provider_base_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

pub fn runtime_config_path(workspace_path: &str) -> PathBuf {
    let workspace = Path::new(workspace_path);
    workspace
        .parent()
        .unwrap_or(workspace)
        .join(FILE_NAME)
}

/// Read settings for a foreground or background run. Missing or invalid files
/// resolve to defaults; this file is tuning, not a prerequisite for startup.
pub fn load_agent_runtime_config(workspace_path: &str) -> AgentRuntimeConfig {
    let path = runtime_config_path(workspace_path);
    match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<AgentRuntimeConfig>(&bytes) {
            Ok(config) => match config.validate() {
                Ok(config) => config,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "invalid native-agent runtime config; using defaults");
                    AgentRuntimeConfig::default()
                }
            },
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "could not parse native-agent runtime config; using defaults");
                AgentRuntimeConfig::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => AgentRuntimeConfig::default(),
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "could not read native-agent runtime config; using defaults");
            AgentRuntimeConfig::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_provider_base_url, runtime_config_path, AgentRuntimeConfig};
    use std::path::Path;

    #[test]
    fn defaults_match_the_pinned_agent_generation() {
        let config = AgentRuntimeConfig::default();
        assert_eq!(config.temperature, 0.0);
        assert_eq!(config.max_tokens, 8_192);
        assert_eq!(config.default_max_turns, 25);
        assert_eq!(config.context_char_budget, 150_000);
        assert_eq!(config.mcp_tool_timeout_ms, 30_000);
        assert_eq!(config.max_retries, 2);
        assert_eq!(config.base_retry_delay_ms, 2_000);
        assert_eq!(config.max_retry_delay_ms, 30_000);
        assert_eq!(config.default_cron_max_turns, 10);
        assert_eq!(config.default_heartbeat_max_turns, 5);
        assert_eq!(config.default_provider, "anthropic");
        assert!(config.default_models.is_empty());
        assert_eq!(config.auto_routing.provider_order.first().map(String::as_str), Some("anthropic"));
    }

    #[test]
    fn validates_and_normalizes_provider_and_model_defaults() {
        let mut config = AgentRuntimeConfig::default();
        config.default_provider = "openai".into();
        config.default_models.insert("openai".into(), "  gpt-example  ".into());
        let normalized = config.validate().unwrap();
        assert_eq!(normalized.default_provider, "openai");
        assert_eq!(normalized.default_models.get("openai").map(String::as_str), Some("gpt-example"));

        let mut config = AgentRuntimeConfig::default();
        config.default_provider = "custom".into();
        assert!(config.validate().is_err());

        let mut config = AgentRuntimeConfig::default();
        config.default_models.insert("custom".into(), "model".into());
        assert!(config.validate().is_err());
    }

    #[test]
    fn validates_model_auth_and_streaming_metadata_maps() {
        let mut config = AgentRuntimeConfig::default();
        config.provider_model_auth_requirements.entry("llm7".into()).or_default()
            .insert("model-pro".into(), true);
        config.provider_model_streaming_capabilities.entry("llm7".into()).or_default()
            .insert("model-pro".into(), false);
        assert!(config.clone().validate().is_ok());

        config.provider_model_auth_requirements.insert("unlisted".into(), Default::default());
        assert!(config.validate().is_err());
    }

    #[test]
    fn rejects_out_of_range_or_non_finite_tunables() {
        let mut config = AgentRuntimeConfig::default();
        config.temperature = f64::NAN;
        assert!(config.validate().is_err());
        let mut config = AgentRuntimeConfig::default();
        config.max_tokens = 0;
        assert!(config.validate().is_err());
        let mut config = AgentRuntimeConfig::default();
        config.base_retry_delay_ms = 5_000;
        config.max_retry_delay_ms = 4_999;
        assert!(config.validate().is_err());
    }

    #[test]
    fn only_safe_provider_endpoint_forms_are_accepted() {
        assert_eq!(
            normalize_provider_base_url("https://gateway.example/v1/"),
            Some("https://gateway.example/v1".into())
        );
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:secret@example.com",
            "https://example.com/?token=secret",
            "https://example.com/#fragment",
        ] {
            assert!(normalize_provider_base_url(bad).is_none(), "accepted {bad}");
        }
    }

    #[test]
    fn config_file_is_outside_the_agent_workspace() {
        let path = runtime_config_path("/app/files/agent/workspace");
        assert_eq!(path, Path::new("/app/files/agent/.native-agent-runtime.json"));
    }
}
