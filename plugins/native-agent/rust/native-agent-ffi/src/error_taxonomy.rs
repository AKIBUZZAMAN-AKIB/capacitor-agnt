//! Error classification for `agent.error` events.
//!
//! The UI used to guess a category from the human text with a broad regex, so
//! words such as "context" or "parse" in an unrelated sentence were reported
//! as a context-limit or stream fault, and an unknown error lost its real
//! message. The category is now decided here, next to the code that produces
//! the message:
//!
//! * `LlmError` renders through fixed templates ("Rate limited, retry after …",
//!   "API error (401): …", "Parse error: …"), so the patterns below match the
//!   exact prefixes the crate itself emits, not free-form prose.
//! * The message sent to the UI is redacted (bearer tokens, `key=value`
//!   secrets, provider key shapes) and capped in length.

use std::sync::OnceLock;

use regex::Regex;

use crate::NativeAgentError;

/// Longest error text forwarded to the UI. Provider bodies can be large and
/// echo request fragments; the UI only needs enough to act on.
pub(crate) const MAX_MESSAGE_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ErrorCategory {
    Cancelled,
    Auth,
    RateLimit,
    Overloaded,
    ContextLimit,
    StreamProtocol,
    Timeout,
    Network,
    Tool,
    Config,
    Provider,
    Internal,
}

impl ErrorCategory {
    /// Stable machine-readable code. The UI maps these to Bangla advice.
    pub(crate) fn code(self) -> &'static str {
        match self {
            ErrorCategory::Cancelled => "cancelled",
            ErrorCategory::Auth => "auth",
            ErrorCategory::RateLimit => "rate_limit",
            ErrorCategory::Overloaded => "overloaded",
            ErrorCategory::ContextLimit => "context_limit",
            ErrorCategory::StreamProtocol => "stream_protocol",
            ErrorCategory::Timeout => "timeout",
            ErrorCategory::Network => "network",
            ErrorCategory::Tool => "tool",
            ErrorCategory::Config => "config",
            ErrorCategory::Provider => "provider_error",
            ErrorCategory::Internal => "internal",
        }
    }
}

/// Category plus the redacted, capped text that goes to the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ErrorReport {
    pub category: ErrorCategory,
    pub message: String,
}

pub(crate) fn report(err: &NativeAgentError) -> ErrorReport {
    let (category, raw) = match err {
        NativeAgentError::Cancelled => (ErrorCategory::Cancelled, err.to_string()),
        NativeAgentError::Auth { msg } => (ErrorCategory::Auth, msg.clone()),
        NativeAgentError::Tool { msg } => (ErrorCategory::Tool, msg.clone()),
        NativeAgentError::Database { msg } | NativeAgentError::Io { msg } => {
            (ErrorCategory::Internal, msg.clone())
        }
        NativeAgentError::Llm { msg } => (classify_text(msg).unwrap_or(ErrorCategory::Provider), msg.clone()),
        NativeAgentError::Agent { msg } => (classify_text(msg).unwrap_or(ErrorCategory::Internal), msg.clone()),
    };
    ErrorReport { category, message: redact_and_cap(&raw, MAX_MESSAGE_CHARS) }
}

/// Matches the `LlmError` and provider-catalog message templates. Order matters:
/// the first rule that fits wins, so the more specific shapes come first.
pub(crate) fn classify_text(text: &str) -> Option<ErrorCategory> {
    static RULES: OnceLock<Vec<(ErrorCategory, Regex)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        let rule = |category, pattern: &str| {
            (category, Regex::new(pattern).expect("static error pattern is valid"))
        };
        vec![
            rule(ErrorCategory::RateLimit, r"(?i)rate limited|too many requests|\brate[ _-]?limit|quota (?:exceeded|exhausted)|\bAPI error \(429\)"),
            rule(ErrorCategory::Overloaded, r"(?i)model overloaded|\bAPI error \((?:503|529)\)|\boverloaded\b"),
            rule(ErrorCategory::Auth, r"(?i)\bAPI error \((?:401|403)\)|\bunauthori[sz]ed\b|\bforbidden\b|missing api key|invalid[ _-]*api[ _-]*key|authentication (?:failed|error)"),
            rule(ErrorCategory::ContextLimit, r"(?i)context (?:window|length)|maximum context|too many tokens|prompt is too long|input (?:is )?too (?:large|long)|max(?:imum)?[ _-]+(?:input[ _-]+)?tokens"),
            rule(ErrorCategory::StreamProtocol, r"(?i)\bParse error\b|invalid json in provider sse|\bmalformed\b.*\b(?:sse|stream|frame|json)\b|\bstream (?:ended|error)\b|\bSSE\b"),
            rule(ErrorCategory::Timeout, r"(?i)timed? ?out|deadline exceeded"),
            rule(ErrorCategory::Network, r"(?i)Network connection error|connection (?:refused|reset|closed)|\bdns\b|\bsocket\b|fetch failed|\bHTTP error\b"),
            rule(ErrorCategory::Config, r"(?i)no provider|unknown provider|provider .{0,40}not (?:found|configured)|no route"),
            rule(ErrorCategory::Tool, r"(?i)tool .{0,40}(?:failed|error)|permission denied|approval (?:denied|required)"),
        ]
    });
    rules.iter().find(|(_, pattern)| pattern.is_match(text)).map(|(category, _)| *category)
}

/// Removes credentials that may appear in provider text, then caps the length
/// on a character boundary.
pub(crate) fn redact_and_cap(text: &str, max_chars: usize) -> String {
    static SECRETS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = SECRETS.get_or_init(|| {
        vec![
            (Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+").unwrap(), "Bearer [redacted]"),
            (
                Regex::new(r#"(?i)((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|authorization)"?\s*[:=]\s*"?)[^\s,;"'}]+"#).unwrap(),
                "$1[redacted]",
            ),
            (Regex::new(r"\b(?:sk|pk|rk|gsk|xai|or|hf)[-_][A-Za-z0-9_-]{12,}").unwrap(), "[redacted]"),
        ]
    });
    let mut out = text.to_string();
    for (pattern, replacement) in patterns {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    let trimmed = out.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut capped: String = trimmed.chars().take(max_chars).collect();
    capped.push('…');
    capped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_templates_map_to_their_real_category() {
        assert_eq!(classify_text("Rate limited, retry after 5000ms"), Some(ErrorCategory::RateLimit));
        assert_eq!(classify_text("Model overloaded, retry after 1000ms"), Some(ErrorCategory::Overloaded));
        assert_eq!(classify_text("API error (401): invalid x-api-key"), Some(ErrorCategory::Auth));
        assert_eq!(classify_text("Missing API key: openrouter"), Some(ErrorCategory::Auth));
        assert_eq!(classify_text("Parse error: invalid JSON in provider SSE event"), Some(ErrorCategory::StreamProtocol));
        assert_eq!(classify_text("HTTP request timed out: deadline"), Some(ErrorCategory::Timeout));
        assert_eq!(classify_text("Network connection error: connection reset by peer"), Some(ErrorCategory::Network));
        assert_eq!(classify_text("API error (400): maximum context length is 8192 tokens"), Some(ErrorCategory::ContextLimit));
    }

    #[test]
    fn incidental_words_do_not_pick_a_category() {
        // Regression: the old UI regex called these "context" / "parse" faults.
        assert_eq!(classify_text("the user asked about the parsing of a CSV file"), None);
        assert_eq!(classify_text("Please write a short poem about the sea"), None);
        assert_eq!(classify_text("quota of ideas is high"), None);
    }

    #[test]
    fn unknown_llm_text_keeps_a_provider_category_and_its_message() {
        let err = NativeAgentError::Llm { msg: "something odd happened upstream".into() };
        let r = report(&err);
        assert_eq!(r.category, ErrorCategory::Provider);
        assert_eq!(r.message, "something odd happened upstream");
    }

    #[test]
    fn cancelled_is_typed_by_variant_not_text() {
        let r = report(&NativeAgentError::Cancelled);
        assert_eq!(r.category, ErrorCategory::Cancelled);
    }

    #[test]
    fn secrets_are_redacted_before_they_reach_the_ui() {
        let raw = "API error (401): Authorization: Bearer abc.def-123 token=sk-or-v1-0123456789abcdef api_key: \"hunter2\"";
        let cleaned = redact_and_cap(raw, 500);
        assert!(!cleaned.contains("abc.def-123"), "{cleaned}");
        assert!(!cleaned.contains("0123456789abcdef"), "{cleaned}");
        assert!(!cleaned.contains("hunter2"), "{cleaned}");
        assert!(cleaned.contains("[redacted]"), "{cleaned}");
        // The surrounding diagnosis survives redaction.
        assert!(cleaned.contains("API error (401)"), "{cleaned}");
    }

    #[test]
    fn long_messages_are_capped_on_a_char_boundary() {
        let raw = "ত".repeat(MAX_MESSAGE_CHARS + 50);
        let capped = redact_and_cap(&raw, MAX_MESSAGE_CHARS);
        assert_eq!(capped.chars().count(), MAX_MESSAGE_CHARS + 1); // + ellipsis
        assert!(capped.ends_with('…'));
    }
}
