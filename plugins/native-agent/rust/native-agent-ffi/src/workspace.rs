use crate::tool_runner;
use crate::types::{InitConfig, ToolDefinition};
use crate::NativeAgentError;
use std::fs;
use std::path::{Path, PathBuf};

const AGENTS_MD: &str = r#"# AGENTS.md

This workspace is your continuity layer. Treat these files as operating context, not decoration.

## Every Session

Start from the workspace:
- Read SOUL.md for personality and tone
- Read IDENTITY.md for name and vibe
- Read USER.md for who you are helping
- Read TOOLS.md for local setup notes
- Read HEARTBEAT.md for periodic check tasks
- Read MEMORY.md for curated long-term context

Do not rely on "mental notes." If something should persist, write it down.

## Memory Rules

Use files as external memory:
- MEMORY.md holds stable long-term context, preferences, and decisions
- `memory/YYYY-MM-DD.md` can hold raw daily notes when useful
- USER.md holds facts about the user that improve future help
- TOOLS.md holds connected accounts, device quirks, and environment notes
- AGENTS.md can evolve when you learn better workflows or guardrails

Capture what matters. Skip secrets unless the user explicitly wants them stored.

## Scheduling

Use the cron tool for any delayed or recurring task:
- "in 2 minutes"
- "later today"
- "tomorrow at 9"
- "every weekday"
- "check this every hour"

When a user asks for a reminder or scheduled follow-up, create a cron job instead of pretending you will remember it.

Use HEARTBEAT.md for batched periodic checks when exact timing is not important.
Use cron when timing matters, when the task is one-shot, or when it should run on a precise schedule.

When scheduling a reminder, write the reminder text so it will read naturally when delivered later.

## Safety

Do not exfiltrate private data.
Ask before taking actions that leave the device, contact other people, spend money, or make destructive changes.
If a request is ambiguous and the action has meaningful downside, clarify first.

## Tool Style

Do not narrate routine tool calls.
Keep responses concise and mobile-friendly.
Give short progress updates only for multi-step work or when the user asks.
Read before editing. Prefer precise edits over full rewrites when possible.

## Workspace Hygiene

Do not create files unless they help the user or the agent operate better.
Keep HEARTBEAT.md short.
Keep MEMORY.md curated instead of turning it into a raw log.
Update these files as your understanding improves.
"#;

const SOUL_MD: &str = r#"# SOUL.md

You are a capable, resourceful personal agent that lives on the user's mobile device.

## Tone
- Direct
- Calm
- Warm without being gushy
- Brief on mobile, detailed on request

## Boundaries
- Accuracy over speed
- Do not bluff tool results
- Protect the user's privacy
- Prefer useful action over performative narration

## Working Style
- Understand before acting
- Surface tradeoffs when they matter
- Be proactive when asked to watch, track, or remember something
- Respect the workspace and leave it cleaner when helpful
"#;

const IDENTITY_MD: &str = r#"# IDENTITY.md

## Core
- Name: Claw
- Creature: Pocket claw
- Vibe: Capable, grounded, curious
- Emoji: (optional)

## Presence
- You live on the user's mobile device
- You help with files, code, research, reminders, and organization
- You are brief by default and expand when asked
"#;

const USER_MD: &str = r#"# USER.md - About Your Human

Learn about the person you are helping. Update this as you go.

- Name:
- What to call them:
- Pronouns: (optional)
- Timezone:
- Language:
- Notes:

## Context

What do they care about? What are they working on? What annoys them? What makes them laugh? Build this over time.

You are learning about a person, not building a dossier. Respect the difference.
"#;

const TOOLS_MD: &str = r#"# TOOLS.md - Local Notes

This is your cheat sheet for device-specific and account-specific details.

## Connected Accounts
- (none recorded yet)

## Device Info
- Platform: (record when known)
- Timezone: (record when known)
- Language: (record when known)

## Notes
- Add connected services, account state, environment quirks, aliases, and device-specific facts here.
- Keep this practical and local to this user's setup.
"#;

const HEARTBEAT_MD: &str = r#"# HEARTBEAT.md

Keep this file empty to skip heartbeat work.

Add short tasks below when the user wants periodic checks or background monitoring.
"#;

const MEMORY_MD: &str = r#"# MEMORY.md

Curated long-term context that should survive across sessions.

## User
- Name: (not recorded yet)
- Preferences: (none recorded yet)
- Timezone: (not recorded yet)

## Ongoing Context
- Fresh workspace, no project loaded yet

## Notes
- Add stable facts, decisions, and recurring preferences here.
- Use daily notes for raw logs; keep this file distilled.
"#;

const VAULT_ALIAS_PROMPT: &str = r#"## Vault Aliases

The user may provide sensitive information that has been replaced with vault aliases in the format `{{VAULT:<type>_<hash>}}`.
Examples: `{{VAULT:cc_4521}}`, `{{VAULT:ssn_a3f1}}`, `{{VAULT:email_c9d3}}`, `{{VAULT:pwd_b7e2}}`

These are SECURE REFERENCES to real values (credit cards, social security numbers, emails, passwords, API keys, etc.) stored in the device's hardware-encrypted vault (iOS Keychain / Android Keystore).

**How to use vault aliases:**
- When you need to use a vaulted value in a tool call, include the alias as-is in the tool arguments
- The system will automatically resolve aliases to real values before the tool executes, after the user authorizes biometrically
- Use aliases naturally in your responses: "I'll use your card {{VAULT:cc_4521}} for the payment"
- The user sees the original data on their end; the aliases are only visible to you

**What NOT to do:**
- Do not try to guess or infer what a vault alias contains
- Do not ask the user to re-enter sensitive data that was already vaulted
- Do not persist vault aliases to files or memory — they are ephemeral session references
- Do not attempt to decode, reverse, or manipulate the alias format
"#;

const DEFAULT_AUTH_PROFILES: &str = r#"{
  "version": 1,
  "profiles": {},
  "lastGood": {},
  "usageStats": {}
}
"#;

const DEFAULT_OPENCLAW_CONFIG: &str = r#"{
  "gateway": {
    "port": 18789
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-5"
      }
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  }
}
"#;

const WORKSPACE_PROMPT_FILES: [(&str, &str); 7] = [
    ("AGENTS.md", AGENTS_MD),
    ("SOUL.md", SOUL_MD),
    ("IDENTITY.md", IDENTITY_MD),
    ("USER.md", USER_MD),
    ("TOOLS.md", TOOLS_MD),
    ("HEARTBEAT.md", HEARTBEAT_MD),
    ("MEMORY.md", MEMORY_MD),
];

fn openclaw_root(workspace_path: &str) -> Result<PathBuf, NativeAgentError> {
    let root = Path::new(workspace_path)
        .parent()
        .ok_or_else(|| NativeAgentError::Io {
            msg: format!("Workspace path has no parent: {}", workspace_path),
        })?;
    Ok(root.to_path_buf())
}

fn write_if_missing(path: &Path, contents: &str) -> Result<(), NativeAgentError> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

pub fn ensure_workspace_dirs(config: &InitConfig) -> Result<(), NativeAgentError> {
    let root = openclaw_root(&config.workspace_path)?;
    let dirs = [
        root.clone(),
        root.join("agents/main/agent"),
        root.join("agents/main/sessions"),
        PathBuf::from(&config.workspace_path),
        PathBuf::from(&config.workspace_path).join(".openclaw"),
    ];

    for dir in dirs {
        fs::create_dir_all(dir)?;
    }

    Ok(())
}

pub fn init_default_files(config: &InitConfig) -> Result<(), NativeAgentError> {
    ensure_workspace_dirs(config)?;

    let workspace_root = PathBuf::from(&config.workspace_path);
    for (filename, contents) in WORKSPACE_PROMPT_FILES {
        write_if_missing(&workspace_root.join(filename), contents)?;
    }

    write_if_missing(Path::new(&config.auth_profiles_path), DEFAULT_AUTH_PROFILES)?;
    write_if_missing(
        &openclaw_root(&config.workspace_path)?.join("openclaw.json"),
        DEFAULT_OPENCLAW_CONFIG,
    )?;

    Ok(())
}

/// Generate the "Available Tools" section of the system prompt dynamically
/// from the actual tool definitions (builtin + MCP).
pub fn generate_tool_summaries(tools: &[ToolDefinition]) -> String {
    let mut builtin_lines = Vec::new();
    let mut account_lines = Vec::new();

    for tool in tools {
        let line = format!("- {}: {}", tool.name, tool.description);
        if tool_runner::is_builtin_tool(&tool.name) {
            builtin_lines.push(line);
        } else {
            account_lines.push(line);
        }
    }

    let mut out = String::from("## Available Tools\n");

    if !builtin_lines.is_empty() {
        out.push_str("\n### Built-in\n");
        for line in &builtin_lines {
            out.push_str(line);
            out.push('\n');
        }
    }

    if !account_lines.is_empty() {
        out.push_str("\n### Connected Accounts\n");
        for line in &account_lines {
            out.push_str(line);
            out.push('\n');
        }
    }

    out.push_str("\nTool call style: do not narrate routine tool calls. Call tools directly. Narrate only for multi-step work or when the user asks.");
    out
}

pub fn load_system_prompt(
    workspace_path: &str,
    tools: &[ToolDefinition],
) -> Result<String, NativeAgentError> {
    let workspace_root = PathBuf::from(workspace_path);
    let mut sections = vec!["# Project Context".to_string()];

    for (filename, fallback) in WORKSPACE_PROMPT_FILES {
        let path = workspace_root.join(filename);
        let content = match fs::read_to_string(&path) {
            Ok(text) if !text.trim().is_empty() => text.trim().to_string(),
            _ => fallback.trim().to_string(),
        };
        sections.push(format!("## {}\n\n{}", filename, content));
    }

    sections.push(VAULT_ALIAS_PROMPT.trim().to_string());
    sections.push(generate_tool_summaries(tools));

    Ok(format!("{}\n", sections.join("\n\n")))
}

pub fn get_models_json(provider: &str) -> String {
    let models = match provider {
        "anthropic" => serde_json::json!([
            {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "description": "Fast and capable", "isDefault": true},
            {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "description": "Quick and lightweight", "isDefault": false},
            {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "description": "Most capable", "isDefault": false}
        ]),
        "openrouter" => serde_json::json!([
            {"id": "anthropic/claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "description": "Fast and capable", "isDefault": true},
            {"id": "openai/gpt-4o", "name": "GPT-4o", "description": "OpenAI's flagship", "isDefault": false},
            {"id": "openai/gpt-4o-mini", "name": "GPT-4o Mini", "description": "Fast and affordable", "isDefault": false},
            {"id": "openai/o4-mini", "name": "o4 Mini", "description": "Reasoning model", "isDefault": false},
            {"id": "google/gemini-2.5-flash", "name": "Gemini 2.5 Flash", "description": "Google - fast", "isDefault": false},
            {"id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro", "description": "Google - powerful", "isDefault": false},
            {"id": "deepseek/deepseek-chat", "name": "DeepSeek V3", "description": "Efficient and capable", "isDefault": false},
            {"id": "meta-llama/llama-3.3-70b-instruct", "name": "Llama 3.3 70B", "description": "Open-source", "isDefault": false},
            {"id": "x-ai/grok-4", "name": "Grok 4", "description": "xAI model", "isDefault": false},
            {"id": "qwen/qwen3-235b-a22b", "name": "Qwen3 235B", "description": "Large MoE model", "isDefault": false}
        ]),
        "openai" => serde_json::json!([
            {"id": "gpt-4o", "name": "GPT-4o", "description": "OpenAI's flagship", "isDefault": true},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "description": "Fast and affordable", "isDefault": false},
            {"id": "o4-mini", "name": "o4 Mini", "description": "Reasoning model", "isDefault": false}
        ]),
        _ => serde_json::json!([
            {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "description": "Fast and capable", "isDefault": true},
            {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "description": "Quick and lightweight", "isDefault": false},
            {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "description": "Most capable", "isDefault": false}
        ]),
    };

    models.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config(test_name: &str) -> InitConfig {
        let root = std::env::temp_dir().join(format!(
            "native-agent-ffi-{}-{}",
            test_name,
            uuid::Uuid::new_v4()
        ));
        InitConfig {
            db_path: root.join("mobile-claw.db").to_string_lossy().to_string(),
            workspace_path: root.join("workspace").to_string_lossy().to_string(),
            auth_profiles_path: root
                .join("agents/main/agent/auth-profiles.json")
                .to_string_lossy()
                .to_string(),
        }
    }

    #[test]
    fn creates_default_workspace_files() {
        let config = temp_config("workspace-files");
        init_default_files(&config).unwrap();

        for (filename, _) in WORKSPACE_PROMPT_FILES {
            assert!(Path::new(&config.workspace_path).join(filename).exists());
        }
        assert!(Path::new(&config.auth_profiles_path).exists());
        assert!(openclaw_root(&config.workspace_path)
            .unwrap()
            .join("openclaw.json")
            .exists());
    }

    #[test]
    fn assembles_system_prompt_from_workspace_files() {
        let config = temp_config("system-prompt");
        init_default_files(&config).unwrap();

        let prompt = load_system_prompt(&config.workspace_path, &[]).unwrap();
        assert!(prompt.contains("# Project Context"));
        assert!(prompt.contains("## AGENTS.md"));
        assert!(prompt.contains("## Vault Aliases"));
        assert!(prompt.contains("## Available Tools"));
    }

    #[test]
    fn system_prompt_includes_mcp_tool_summaries() {
        let config = temp_config("tool-summaries");
        init_default_files(&config).unwrap();

        let tools = vec![
            // A builtin tool
            ToolDefinition {
                name: "read_file".to_string(),
                description: "Read a file from the workspace".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                webview_only: false,
                approval_policy: None,
            },
            // An MCP/account tool
            ToolDefinition {
                name: "gmail_search".to_string(),
                description: "Search Gmail messages".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                webview_only: true,
                approval_policy: None,
            },
        ];

        let prompt = load_system_prompt(&config.workspace_path, &tools).unwrap();
        assert!(prompt.contains("### Built-in"));
        assert!(prompt.contains("read_file: Read a file"));
        assert!(prompt.contains("### Connected Accounts"));
        assert!(prompt.contains("gmail_search: Search Gmail"));
    }
}
