//! Database — SQLite persistence for sessions, cron jobs, scheduler, heartbeat, skills.
//!
//! Reads/writes the same mobile-claw.db that the WebView uses (WAL mode for concurrent access).
//! All CRUD operations mirror the JS CronDbAccess + SessionStore classes exactly.

use crate::types::{DisplayMessage, InitConfig, Message, MessageContent, PendingEvent, Role, TokenUsage};
use crate::{MemoryProvider, NativeAgentError, NativeEventCallback, NativeNotifier};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

// ── Connection ──────────────────────────────────────────────────────────────

pub fn open_db(path: &str) -> Result<Connection, NativeAgentError> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    )?;
    Ok(conn)
}

pub fn ensure_schema(conn: &Connection) -> Result<(), NativeAgentError> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sessions (
            session_key TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL DEFAULT 'main',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            model TEXT,
            total_tokens INTEGER DEFAULT 0,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS messages (
            session_key TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            timestamp INTEGER,
            model TEXT,
            tool_call_id TEXT,
            usage_input INTEGER,
            usage_output INTEGER,
            PRIMARY KEY (session_key, sequence),
            FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_agent_updated ON sessions(agent_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key);

        CREATE TABLE IF NOT EXISTS scheduler_config (
            id INTEGER PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1,
            scheduling_mode TEXT NOT NULL DEFAULT 'balanced',
            run_on_charging INTEGER NOT NULL DEFAULT 1,
            global_active_hours_start TEXT,
            global_active_hours_end TEXT,
            global_active_hours_tz TEXT,
            updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS heartbeat_config (
            id INTEGER PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            every_ms INTEGER NOT NULL DEFAULT 1800000,
            prompt TEXT,
            skill_id TEXT,
            active_hours_start TEXT,
            active_hours_end TEXT,
            active_hours_tz TEXT,
            next_run_at INTEGER,
            last_heartbeat_hash TEXT,
            last_heartbeat_sent_at INTEGER,
            updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS cron_skills (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            allowed_tools TEXT,
            system_prompt TEXT,
            model TEXT,
            max_turns INTEGER NOT NULL DEFAULT 3,
            timeout_ms INTEGER NOT NULL DEFAULT 60000,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cron_jobs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            session_target TEXT NOT NULL DEFAULT 'isolated',
            wake_mode TEXT NOT NULL DEFAULT 'next-heartbeat',
            schedule_kind TEXT,
            schedule_every_ms INTEGER,
            schedule_anchor_ms INTEGER,
            schedule_at_ms INTEGER,
            skill_id TEXT,
            prompt TEXT,
            delivery_mode TEXT NOT NULL DEFAULT 'notification',
            delivery_webhook_url TEXT,
            delivery_notification_title TEXT,
            active_hours_start TEXT,
            active_hours_end TEXT,
            active_hours_tz TEXT,
            last_run_at INTEGER,
            next_run_at INTEGER,
            last_run_status TEXT,
            last_error TEXT,
            last_duration_ms INTEGER,
            last_response_hash TEXT,
            last_response_sent_at INTEGER,
            consecutive_errors INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cron_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            status TEXT,
            duration_ms INTEGER,
            error TEXT,
            response_text TEXT,
            was_heartbeat_ok INTEGER NOT NULL DEFAULT 0,
            was_deduped INTEGER NOT NULL DEFAULT 0,
            delivered INTEGER NOT NULL DEFAULT 0,
            wake_source TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id);

        CREATE TABLE IF NOT EXISTS system_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            context_key TEXT,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            consumed INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_system_events_session ON system_events(session_key, consumed);

        CREATE TABLE IF NOT EXISTS pending_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_pending_events_created_at ON pending_events(created_at);

        CREATE TABLE IF NOT EXISTS tool_permissions (
            tool_name  TEXT PRIMARY KEY,
            permission TEXT NOT NULL DEFAULT 'always_ask',
            enabled    INTEGER NOT NULL DEFAULT 1,
            source     TEXT,
            group_id   TEXT,
            updated_at INTEGER
        );
        "
    )?;
    Ok(())
}

// ── Sessions ────────────────────────────────────────────────────────────────

pub fn save_session(
    conn: &Connection,
    session_key: &str,
    agent_id: &str,
    messages_json: &str,
    model: Option<&str>,
    start_time: i64,
    usage: Option<&crate::types::TokenUsage>,
) -> Result<(), NativeAgentError> {
    let now = chrono::Utc::now().timestamp_millis();

    let input_tokens = usage.map(|u| u.input_tokens as i64).unwrap_or(0);
    let output_tokens = usage.map(|u| u.output_tokens as i64).unwrap_or(0);
    let total_tokens = usage.map(|u| u.total_tokens as i64).unwrap_or(0);

    // Parse messages for individual message persistence
    let messages: Vec<serde_json::Value> = serde_json::from_str(messages_json).unwrap_or_default();

    conn.execute(
        "INSERT INTO sessions (session_key, agent_id, created_at, updated_at, model, total_tokens, input_tokens, output_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_key) DO UPDATE SET
           updated_at = excluded.updated_at,
           model = excluded.model,
           total_tokens = excluded.total_tokens,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens",
        params![session_key, agent_id, start_time, now, model, total_tokens, input_tokens, output_tokens],
    )?;

    // Count existing messages
    let existing_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE session_key = ?",
        params![session_key],
        |row| row.get(0),
    )?;

    // Insert new messages
    for (i, msg) in messages.iter().enumerate().skip(existing_count as usize) {
        let role = msg
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("unknown");
        let content = match msg.get("content") {
            Some(v) if v.is_string() => v.as_str().unwrap_or("").to_string(),
            Some(v) => v.to_string(),
            None => String::new(),
        };
        let timestamp = msg.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(now);
        let msg_model = msg.get("model").and_then(|m| m.as_str());
        let tool_call_id = msg.get("toolCallId").and_then(|t| t.as_str());
        let usage_input = msg
            .get("usage")
            .and_then(|u| u.get("input"))
            .and_then(|v| v.as_i64());
        let usage_output = msg
            .get("usage")
            .and_then(|u| u.get("output"))
            .and_then(|v| v.as_i64());

        conn.execute(
            "INSERT OR IGNORE INTO messages (session_key, sequence, role, content, timestamp, model, tool_call_id, usage_input, usage_output)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![session_key, i as i64, role, content, timestamp, msg_model.or(model), tool_call_id, usage_input, usage_output],
        )?;
    }

    Ok(())
}

pub fn list_sessions(conn: &Connection, agent_id: &str) -> Result<String, NativeAgentError> {
    let mut stmt = conn.prepare(
        "SELECT session_key, created_at, updated_at, model, total_tokens
         FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC",
    )?;
    let sessions: Vec<serde_json::Value> = stmt
        .query_map(params![agent_id], |row| {
            Ok(serde_json::json!({
                "sessionKey": row.get::<_, String>(0)?,
                "agentId": agent_id,
                "updatedAt": row.get::<_, i64>(2)?,
                "model": row.get::<_, Option<String>>(3)?,
                "totalTokens": row.get::<_, Option<i64>>(4)?,
            }))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(serde_json::to_string(&sessions)?)
}

/// Load raw internal messages from DB (for LLM resume context).
pub fn load_session_messages_raw(
    conn: &Connection,
    session_key: &str,
) -> Result<Vec<Message>, NativeAgentError> {
    let mut stmt = conn.prepare(
        "SELECT role, content FROM messages WHERE session_key = ? ORDER BY sequence",
    )?;
    let messages: Vec<Message> = stmt
        .query_map(params![session_key], |row| {
            let role_str: String = row.get(0)?;
            let content_str: String = row.get(1)?;
            Ok((role_str, content_str))
        })?
        .filter_map(|r| r.ok())
        .filter_map(|(role_str, content_str)| {
            let role = match role_str.as_str() {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                "system" => Role::System,
                _ => return None,
            };
            let content: MessageContent = serde_json::from_str(&content_str)
                .unwrap_or_else(|_| MessageContent::Text(content_str));
            Some(Message { role, content })
        })
        .collect();
    Ok(messages)
}

/// Load session messages as provider-agnostic DisplayMessage[] JSON for the UI.
pub fn load_session_messages(
    conn: &Connection,
    session_key: &str,
) -> Result<String, NativeAgentError> {
    let raw = load_session_messages_raw(conn, session_key)?;

    // Get model and usage from session metadata
    let (model, usage) = conn
        .query_row(
            "SELECT model, input_tokens, output_tokens, total_tokens FROM sessions WHERE session_key = ?",
            params![session_key],
            |row| {
                let m: Option<String> = row.get(0)?;
                let inp: Option<i64> = row.get(1)?;
                let out: Option<i64> = row.get(2)?;
                let tot: Option<i64> = row.get(3)?;
                let u = if inp.is_some() || out.is_some() {
                    Some(TokenUsage {
                        input_tokens: inp.unwrap_or(0) as u32,
                        output_tokens: out.unwrap_or(0) as u32,
                        total_tokens: tot.unwrap_or(0) as u32,
                    })
                } else {
                    None
                };
                Ok((m, u))
            },
        )
        .unwrap_or((None, None));

    let now = chrono::Utc::now().timestamp_millis();
    let display = DisplayMessage::from_messages(&raw, model.as_deref(), usage.as_ref(), now);
    Ok(serde_json::to_string(&display)?)
}

pub fn clear_session(conn: &Connection, session_key: &str) -> Result<(), NativeAgentError> {
    conn.execute(
        "DELETE FROM messages WHERE session_key = ?",
        params![session_key],
    )?;
    conn.execute(
        "DELETE FROM sessions WHERE session_key = ?",
        params![session_key],
    )?;
    Ok(())
}

pub fn queue_pending_event(
    conn: &Connection,
    event_type: &str,
    payload_json: &str,
) -> Result<(), NativeAgentError> {
    conn.execute(
        "INSERT INTO pending_events (event_type, payload_json, created_at) VALUES (?1, ?2, ?3)",
        params![
            event_type,
            payload_json,
            chrono::Utc::now().timestamp_millis()
        ],
    )?;
    Ok(())
}

pub fn drain_pending_events(conn: &Connection) -> Result<Vec<PendingEvent>, NativeAgentError> {
    let mut stmt = conn.prepare(
        "SELECT id, event_type, payload_json, created_at
         FROM pending_events ORDER BY created_at ASC, id ASC",
    )?;
    let events = stmt
        .query_map([], |row| {
            Ok(PendingEvent {
                id: row.get(0)?,
                event_type: row.get(1)?,
                payload_json: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .filter_map(|row| row.ok())
        .collect::<Vec<_>>();
    drop(stmt);
    conn.execute("DELETE FROM pending_events", [])?;
    Ok(events)
}

// ── Scheduler config ────────────────────────────────────────────────────────

pub fn get_scheduler_config(conn: &Connection) -> Result<String, NativeAgentError> {
    conn.execute(
        "INSERT OR IGNORE INTO scheduler_config (id, enabled, scheduling_mode, run_on_charging, updated_at)
         VALUES (1, 1, 'balanced', 1, ?)",
        params![chrono::Utc::now().timestamp_millis()],
    )?;
    let row = conn.query_row(
        "SELECT enabled, scheduling_mode, run_on_charging, global_active_hours_start, global_active_hours_end, global_active_hours_tz
         FROM scheduler_config WHERE id = 1",
        [],
        |row| {
            Ok(serde_json::json!({
                "enabled": row.get::<_, i64>(0)? == 1,
                "schedulingMode": row.get::<_, String>(1)?,
                "runOnCharging": row.get::<_, i64>(2)? == 1,
                "globalActiveHours": active_hours_json(
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ),
            }))
        },
    )?;
    Ok(row.to_string())
}

pub fn set_scheduler_config(conn: &Connection, config_json: &str) -> Result<(), NativeAgentError> {
    // Ensure default row exists
    conn.execute(
        "INSERT OR IGNORE INTO scheduler_config (id, enabled, scheduling_mode, run_on_charging, updated_at)
         VALUES (1, 1, 'balanced', 1, ?)",
        params![chrono::Utc::now().timestamp_millis()],
    )?;

    let patch: serde_json::Value = serde_json::from_str(config_json)?;
    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(v) = patch.get("enabled") {
        sets.push("enabled = ?");
        vals.push(Box::new(if v.as_bool().unwrap_or(true) {
            1i64
        } else {
            0i64
        }));
    }
    if let Some(v) = patch.get("schedulingMode").and_then(|v| v.as_str()) {
        sets.push("scheduling_mode = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = patch.get("runOnCharging") {
        sets.push("run_on_charging = ?");
        vals.push(Box::new(if v.as_bool().unwrap_or(true) {
            1i64
        } else {
            0i64
        }));
    }
    if let Some(ah) = patch.get("globalActiveHours") {
        sets.push("global_active_hours_start = ?");
        vals.push(Box::new(
            ah.get("start")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        ));
        sets.push("global_active_hours_end = ?");
        vals.push(Box::new(
            ah.get("end")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        ));
        sets.push("global_active_hours_tz = ?");
        vals.push(Box::new(
            ah.get("tz").and_then(|v| v.as_str()).map(|s| s.to_string()),
        ));
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("updated_at = ?");
    vals.push(Box::new(chrono::Utc::now().timestamp_millis()));

    let sql = format!(
        "UPDATE scheduler_config SET {} WHERE id = 1",
        sets.join(", ")
    );
    let params: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

// ── Heartbeat config ────────────────────────────────────────────────────────

pub fn get_heartbeat_config(conn: &Connection) -> Result<String, NativeAgentError> {
    conn.execute(
        "INSERT OR IGNORE INTO heartbeat_config (id, enabled, every_ms, updated_at)
         VALUES (1, 0, 1800000, ?)",
        params![chrono::Utc::now().timestamp_millis()],
    )?;
    let row = conn.query_row(
        "SELECT enabled, every_ms, prompt, skill_id, active_hours_start, active_hours_end, active_hours_tz,
                next_run_at, last_heartbeat_hash, last_heartbeat_sent_at
         FROM heartbeat_config WHERE id = 1",
        [],
        |row| {
            Ok(serde_json::json!({
                "enabled": row.get::<_, i64>(0)? == 1,
                "everyMs": row.get::<_, i64>(1)?,
                "prompt": row.get::<_, Option<String>>(2)?,
                "skillId": row.get::<_, Option<String>>(3)?,
                "activeHours": active_hours_json(
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ),
                "nextRunAt": row.get::<_, Option<i64>>(7)?,
                "lastHash": row.get::<_, Option<String>>(8)?,
                "lastSentAt": row.get::<_, Option<i64>>(9)?,
            }))
        },
    )?;
    Ok(row.to_string())
}

pub fn set_heartbeat_config(conn: &Connection, config_json: &str) -> Result<(), NativeAgentError> {
    conn.execute(
        "INSERT OR IGNORE INTO heartbeat_config (id, enabled, every_ms, updated_at)
         VALUES (1, 0, 1800000, ?)",
        params![chrono::Utc::now().timestamp_millis()],
    )?;

    let patch: serde_json::Value = serde_json::from_str(config_json)?;
    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(v) = patch.get("enabled") {
        sets.push("enabled = ?");
        vals.push(Box::new(if v.as_bool().unwrap_or(false) {
            1i64
        } else {
            0i64
        }));
    }
    if let Some(v) = patch.get("everyMs").and_then(|v| v.as_i64()) {
        sets.push("every_ms = ?");
        vals.push(Box::new(v));
    }
    if let Some(v) = patch.get("prompt") {
        sets.push("prompt = ?");
        vals.push(Box::new(v.as_str().map(|s| s.to_string())));
    }
    if let Some(v) = patch.get("skillId") {
        sets.push("skill_id = ?");
        vals.push(Box::new(v.as_str().map(|s| s.to_string())));
    }
    if let Some(ah) = patch.get("activeHours") {
        sets.push("active_hours_start = ?");
        vals.push(Box::new(
            ah.get("start")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        ));
        sets.push("active_hours_end = ?");
        vals.push(Box::new(
            ah.get("end")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        ));
        sets.push("active_hours_tz = ?");
        vals.push(Box::new(
            ah.get("tz").and_then(|v| v.as_str()).map(|s| s.to_string()),
        ));
    }
    if let Some(v) = patch.get("nextRunAt") {
        sets.push("next_run_at = ?");
        vals.push(Box::new(v.as_i64()));
    }
    if let Some(v) = patch.get("lastHash") {
        sets.push("last_heartbeat_hash = ?");
        vals.push(Box::new(v.as_str().map(|s| s.to_string())));
    }
    if let Some(v) = patch.get("lastSentAt") {
        sets.push("last_heartbeat_sent_at = ?");
        vals.push(Box::new(v.as_i64()));
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("updated_at = ?");
    vals.push(Box::new(chrono::Utc::now().timestamp_millis()));

    let sql = format!(
        "UPDATE heartbeat_config SET {} WHERE id = 1",
        sets.join(", ")
    );
    let params: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

// ── Cron jobs ───────────────────────────────────────────────────────────────

pub fn add_cron_job(conn: &Connection, input_json: &str) -> Result<String, NativeAgentError> {
    let job: serde_json::Value = serde_json::from_str(input_json)?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = job
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("job_{}_{}", now, &uuid::Uuid::new_v4().to_string()[..8]));

    let schedule: serde_json::Value = job
        .get("schedule")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let active_hours = job
        .get("activeHours")
        .cloned()
        .unwrap_or(serde_json::json!(null));

    let schedule_kind = schedule.get("kind").and_then(|v| v.as_str());
    let every_ms = schedule.get("everyMs").and_then(|v| v.as_i64());
    let anchor_ms = schedule.get("anchorMs").and_then(|v| v.as_i64());
    let at_ms = schedule.get("atMs").and_then(|v| v.as_i64());

    let next_run_at: Option<i64> =
        job.get("nextRunAt")
            .and_then(|v| v.as_i64())
            .or_else(|| match schedule_kind {
                Some("at") => at_ms,
                Some("every") => every_ms.map(|e| now + e),
                _ => None,
            });

    conn.execute(
        "INSERT INTO cron_jobs
         (id, name, enabled, session_target, wake_mode, schedule_kind, schedule_every_ms, schedule_anchor_ms, schedule_at_ms,
          skill_id, prompt, delivery_mode, delivery_webhook_url, delivery_notification_title,
          active_hours_start, active_hours_end, active_hours_tz,
          last_run_at, next_run_at, last_run_status, last_error, last_duration_ms,
          last_response_hash, last_response_sent_at, consecutive_errors, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                 NULL, ?18, NULL, NULL, NULL, NULL, NULL, 0, ?19, ?20)",
        params![
            id,
            job.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            if job.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true) { 1i64 } else { 0 },
            job.get("sessionTarget").and_then(|v| v.as_str()).unwrap_or("isolated"),
            job.get("wakeMode").and_then(|v| v.as_str()).unwrap_or("next-heartbeat"),
            schedule_kind,
            every_ms,
            anchor_ms,
            at_ms,
            job.get("skillId").and_then(|v| v.as_str()),
            job.get("prompt").and_then(|v| v.as_str()).unwrap_or(""),
            job.get("deliveryMode").and_then(|v| v.as_str()).unwrap_or("notification"),
            job.get("deliveryWebhookUrl").and_then(|v| v.as_str()),
            job.get("deliveryNotificationTitle").and_then(|v| v.as_str()),
            active_hours.get("start").and_then(|v| v.as_str()),
            active_hours.get("end").and_then(|v| v.as_str()),
            active_hours.get("tz").and_then(|v| v.as_str()),
            next_run_at,
            now,
            now,
        ],
    )?;

    // Return the inserted record
    query_cron_job(conn, &id)
}

pub fn update_cron_job(
    conn: &Connection,
    id: &str,
    patch_json: &str,
) -> Result<(), NativeAgentError> {
    let patch: serde_json::Value = serde_json::from_str(patch_json)?;
    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    macro_rules! set_field {
        ($key:expr, $col:expr) => {
            if let Some(v) = patch.get($key) {
                sets.push(concat!($col, " = ?"));
                vals.push(Box::new(v.as_str().map(|s| s.to_string())));
            }
        };
    }
    macro_rules! set_bool {
        ($key:expr, $col:expr) => {
            if let Some(v) = patch.get($key) {
                sets.push(concat!($col, " = ?"));
                vals.push(Box::new(if v.as_bool().unwrap_or(true) {
                    1i64
                } else {
                    0i64
                }));
            }
        };
    }
    macro_rules! set_int {
        ($key:expr, $col:expr) => {
            if let Some(v) = patch.get($key) {
                sets.push(concat!($col, " = ?"));
                vals.push(Box::new(v.as_i64()));
            }
        };
    }

    set_field!("name", "name");
    set_bool!("enabled", "enabled");
    set_field!("sessionTarget", "session_target");
    set_field!("wakeMode", "wake_mode");
    set_field!("skillId", "skill_id");
    set_field!("prompt", "prompt");
    set_field!("deliveryMode", "delivery_mode");
    set_field!("deliveryWebhookUrl", "delivery_webhook_url");
    set_field!("deliveryNotificationTitle", "delivery_notification_title");
    set_int!("nextRunAt", "next_run_at");
    set_int!("lastRunAt", "last_run_at");
    set_field!("lastRunStatus", "last_run_status");
    set_field!("lastError", "last_error");
    set_int!("lastDurationMs", "last_duration_ms");
    set_int!("consecutiveErrors", "consecutive_errors");

    if let Some(sched) = patch.get("schedule") {
        if let Some(v) = sched.get("kind").and_then(|v| v.as_str()) {
            sets.push("schedule_kind = ?");
            vals.push(Box::new(v.to_string()));
        }
        if let Some(v) = sched.get("everyMs").and_then(|v| v.as_i64()) {
            sets.push("schedule_every_ms = ?");
            vals.push(Box::new(v));
        }
        if let Some(v) = sched.get("atMs").and_then(|v| v.as_i64()) {
            sets.push("schedule_at_ms = ?");
            vals.push(Box::new(v));
        }
    }

    if let Some(ah) = patch.get("activeHours") {
        sets.push("active_hours_start = ?");
        vals.push(Box::new(
            ah.get("start")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        ));
        sets.push("active_hours_end = ?");
        vals.push(Box::new(
            ah.get("end")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        ));
        sets.push("active_hours_tz = ?");
        vals.push(Box::new(
            ah.get("tz").and_then(|v| v.as_str()).map(|s| s.to_string()),
        ));
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("updated_at = ?");
    vals.push(Box::new(chrono::Utc::now().timestamp_millis()));

    vals.push(Box::new(id.to_string()));
    let sql = format!("UPDATE cron_jobs SET {} WHERE id = ?", sets.join(", "));
    let params: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

pub fn remove_cron_job(conn: &Connection, id: &str) -> Result<(), NativeAgentError> {
    conn.execute("DELETE FROM cron_jobs WHERE id = ?", params![id])?;
    conn.execute("DELETE FROM cron_runs WHERE job_id = ?", params![id])?;
    Ok(())
}

pub fn list_cron_jobs(conn: &Connection) -> Result<String, NativeAgentError> {
    let mut stmt = conn.prepare("SELECT * FROM cron_jobs ORDER BY updated_at DESC")?;
    let jobs: Vec<serde_json::Value> = stmt
        .query_map([], |row| cron_job_to_json(row))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(serde_json::to_string(&jobs)?)
}

fn query_cron_job(conn: &Connection, id: &str) -> Result<String, NativeAgentError> {
    let row = conn.query_row("SELECT * FROM cron_jobs WHERE id = ?", params![id], |row| {
        cron_job_to_json(row)
    })?;
    Ok(row.to_string())
}

fn cron_job_to_json(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "enabled": row.get::<_, i64>(2)? == 1,
        "sessionTarget": row.get::<_, String>(3)?,
        "wakeMode": row.get::<_, String>(4)?,
        "schedule": {
            "kind": row.get::<_, Option<String>>(5)?,
            "everyMs": row.get::<_, Option<i64>>(6)?,
            "atMs": row.get::<_, Option<i64>>(8)?,
        },
        "skillId": row.get::<_, Option<String>>(9)?,
        "prompt": row.get::<_, Option<String>>(10)?,
        "deliveryMode": row.get::<_, String>(11)?,
        "deliveryWebhookUrl": row.get::<_, Option<String>>(12)?,
        "deliveryNotificationTitle": row.get::<_, Option<String>>(13)?,
        "activeHours": active_hours_json(
            row.get::<_, Option<String>>(14)?,
            row.get::<_, Option<String>>(15)?,
            row.get::<_, Option<String>>(16)?,
        ),
        "lastRunAt": row.get::<_, Option<i64>>(17)?,
        "nextRunAt": row.get::<_, Option<i64>>(18)?,
        "lastRunStatus": row.get::<_, Option<String>>(19)?,
        "lastError": row.get::<_, Option<String>>(20)?,
        "lastDurationMs": row.get::<_, Option<i64>>(21)?,
        "consecutiveErrors": row.get::<_, i64>(24)?,
        "createdAt": row.get::<_, i64>(25)?,
        "updatedAt": row.get::<_, i64>(26)?,
    }))
}

pub fn list_cron_runs(
    conn: &Connection,
    job_id: Option<&str>,
    limit: i64,
) -> Result<String, NativeAgentError> {
    let runs: Vec<serde_json::Value> = if let Some(jid) = job_id {
        let mut stmt = conn.prepare(
            "SELECT id, job_id, started_at, ended_at, status, duration_ms, error, response_text, wake_source
             FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?"
        )?;
        let r: Vec<_> = stmt
            .query_map(params![jid, limit], cron_run_to_json)?
            .filter_map(|r| r.ok())
            .collect();
        r
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, job_id, started_at, ended_at, status, duration_ms, error, response_text, wake_source
             FROM cron_runs ORDER BY started_at DESC LIMIT ?"
        )?;
        let r: Vec<_> = stmt
            .query_map(params![limit], cron_run_to_json)?
            .filter_map(|r| r.ok())
            .collect();
        r
    };
    Ok(serde_json::to_string(&runs)?)
}

fn cron_run_to_json(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, i64>(0)?,
        "jobId": row.get::<_, String>(1)?,
        "startedAt": row.get::<_, i64>(2)?,
        "endedAt": row.get::<_, Option<i64>>(3)?,
        "status": row.get::<_, Option<String>>(4)?,
        "durationMs": row.get::<_, Option<i64>>(5)?,
        "error": row.get::<_, Option<String>>(6)?,
        "responseText": row.get::<_, Option<String>>(7)?,
        "wakeSource": row.get::<_, Option<String>>(8)?,
    }))
}

pub fn run_cron_job(conn: &Connection, job_id: &str) -> Result<(), NativeAgentError> {
    // Set next_run_at to now so it triggers on next wake
    conn.execute(
        "UPDATE cron_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?",
        params![
            chrono::Utc::now().timestamp_millis(),
            chrono::Utc::now().timestamp_millis(),
            job_id
        ],
    )?;
    Ok(())
}

// ── Skills ──────────────────────────────────────────────────────────────────

pub fn add_skill(conn: &Connection, input_json: &str) -> Result<String, NativeAgentError> {
    let skill: serde_json::Value = serde_json::from_str(input_json)?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = skill
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("skill_{}_{}", now, &uuid::Uuid::new_v4().to_string()[..8]));

    conn.execute(
        "INSERT INTO cron_skills (id, name, allowed_tools, system_prompt, model, max_turns, timeout_ms, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            skill.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            skill.get("allowedTools").map(|v| v.to_string()),
            skill.get("systemPrompt").and_then(|v| v.as_str()),
            skill.get("model").and_then(|v| v.as_str()),
            skill.get("maxTurns").and_then(|v| v.as_i64()).unwrap_or(3),
            skill.get("timeoutMs").and_then(|v| v.as_i64()).unwrap_or(60_000),
            now,
            now,
        ],
    )?;

    let record = conn.query_row(
        "SELECT * FROM cron_skills WHERE id = ?",
        params![id],
        |row| skill_to_json(row),
    )?;
    Ok(record.to_string())
}

pub fn update_skill(conn: &Connection, id: &str, patch_json: &str) -> Result<(), NativeAgentError> {
    let patch: serde_json::Value = serde_json::from_str(patch_json)?;
    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(v) = patch.get("name").and_then(|v| v.as_str()) {
        sets.push("name = ?");
        vals.push(Box::new(v.to_string()));
    }
    if let Some(v) = patch.get("allowedTools") {
        sets.push("allowed_tools = ?");
        vals.push(Box::new(if v.is_null() {
            None
        } else {
            Some(v.to_string())
        }));
    }
    if let Some(v) = patch.get("systemPrompt") {
        sets.push("system_prompt = ?");
        vals.push(Box::new(v.as_str().map(|s| s.to_string())));
    }
    if let Some(v) = patch.get("model") {
        sets.push("model = ?");
        vals.push(Box::new(v.as_str().map(|s| s.to_string())));
    }
    if let Some(v) = patch.get("maxTurns").and_then(|v| v.as_i64()) {
        sets.push("max_turns = ?");
        vals.push(Box::new(v));
    }
    if let Some(v) = patch.get("timeoutMs").and_then(|v| v.as_i64()) {
        sets.push("timeout_ms = ?");
        vals.push(Box::new(v));
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("updated_at = ?");
    vals.push(Box::new(chrono::Utc::now().timestamp_millis()));
    vals.push(Box::new(id.to_string()));

    let sql = format!("UPDATE cron_skills SET {} WHERE id = ?", sets.join(", "));
    let params: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

pub fn remove_skill(conn: &Connection, id: &str) -> Result<(), NativeAgentError> {
    conn.execute("DELETE FROM cron_skills WHERE id = ?", params![id])?;
    Ok(())
}

pub fn list_skills(conn: &Connection) -> Result<String, NativeAgentError> {
    let mut stmt = conn.prepare("SELECT * FROM cron_skills ORDER BY updated_at DESC")?;
    let skills: Vec<serde_json::Value> = stmt
        .query_map([], |row| skill_to_json(row))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(serde_json::to_string(&skills)?)
}

pub fn load_skill(conn: &Connection, id: &str) -> Result<String, NativeAgentError> {
    let record = conn.query_row(
        "SELECT * FROM cron_skills WHERE id = ?",
        params![id],
        |row| skill_to_json(row),
    )?;
    Ok(record.to_string())
}

fn skill_to_json(row: &rusqlite::Row) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "name": row.get::<_, String>(1)?,
        "allowedTools": row.get::<_, Option<String>>(2)?,
        "systemPrompt": row.get::<_, Option<String>>(3)?,
        "model": row.get::<_, Option<String>>(4)?,
        "maxTurns": row.get::<_, i64>(5)?,
        "timeoutMs": row.get::<_, i64>(6)?,
        "createdAt": row.get::<_, i64>(7)?,
        "updatedAt": row.get::<_, i64>(8)?,
    }))
}

// ── Wake / cron evaluation ──────────────────────────────────────────────────

struct PendingEventWriter {
    db_path: String,
}

impl NativeEventCallback for PendingEventWriter {
    fn on_event(&self, event_type: String, payload_json: String) {
        if let Ok(conn) = open_db(&self.db_path) {
            let _ = ensure_schema(&conn);
            let _ = queue_pending_event(&conn, &event_type, &payload_json);
        }
    }
}

struct DueCronJob {
    id: String,
    name: String,
    prompt: String,
    system_prompt: Option<String>,
    allowed_tools: Option<String>,
    delivery_mode: String,
    delivery_notification_title: Option<String>,
}

fn get_due_jobs(conn: &Connection) -> Result<Vec<DueCronJob>, NativeAgentError> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut stmt = conn.prepare(
        "SELECT id, name, prompt, skill_id, delivery_mode, delivery_notification_title
         FROM cron_jobs
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC",
    )?;

    let jobs = stmt
        .query_map(params![now], |row| {
            let skill_id: Option<String> = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                skill_id,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();

    let mut result = Vec::new();
    for (id, name, prompt, skill_id, delivery_mode, delivery_notification_title) in jobs {
        let (system_prompt, allowed_tools) = if let Some(sid) = &skill_id {
            let sp: Option<String> = conn
                .query_row(
                    "SELECT system_prompt FROM cron_skills WHERE id = ?",
                    params![sid],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            let at: Option<String> = conn
                .query_row(
                    "SELECT allowed_tools FROM cron_skills WHERE id = ?",
                    params![sid],
                    |row| row.get(0),
                )
                .ok()
                .flatten();
            (sp, at)
        } else {
            (None, None)
        };
        result.push(DueCronJob {
            id,
            name,
            prompt,
            system_prompt,
            allowed_tools,
            delivery_mode,
            delivery_notification_title,
        });
    }

    Ok(result)
}

fn mark_job_running(conn: &Connection, id: &str) -> Result<(), NativeAgentError> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE cron_jobs SET last_run_at = ?, last_run_status = 'running', updated_at = ? WHERE id = ?",
        params![now, now, id],
    )?;
    Ok(())
}

fn insert_cron_run(conn: &Connection, id: &str, source: &str) -> Result<i64, NativeAgentError> {
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO cron_runs (job_id, started_at, status, wake_source)
         VALUES (?1, ?2, 'running', ?3)",
        params![id, now, source],
    )?;
    Ok(conn.last_insert_rowid())
}

fn finalize_cron_run(
    conn: &Connection,
    run_id: i64,
    status: &str,
    duration_ms: i64,
    error: Option<&str>,
    response_text: Option<&str>,
    delivered: bool,
) -> Result<(), NativeAgentError> {
    let ended_at = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE cron_runs
         SET ended_at = ?1, status = ?2, duration_ms = ?3, error = ?4, response_text = ?5, delivered = ?6
         WHERE id = ?7",
        params![
            ended_at,
            status,
            duration_ms,
            error,
            response_text,
            if delivered { 1i64 } else { 0i64 },
            run_id,
        ],
    )?;
    Ok(())
}

fn mark_job_completed(
    conn: &Connection,
    id: &str,
    error: Option<&str>,
    duration_ms: i64,
) -> Result<(), NativeAgentError> {
    let now = chrono::Utc::now().timestamp_millis();
    let status = if error.is_some() { "error" } else { "ok" };

    // Advance next_run_at for recurring jobs
    let next: Option<i64> = conn.query_row(
        "SELECT schedule_kind, schedule_every_ms FROM cron_jobs WHERE id = ?",
        params![id],
        |row| {
            let kind: Option<String> = row.get(0)?;
            let every_ms: Option<i64> = row.get(1)?;
            Ok(match (kind.as_deref(), every_ms) {
                (Some("every"), Some(ms)) if ms > 0 => Some(now + ms),
                _ => None,
            })
        },
    )?;

    if error.is_some() {
        conn.execute(
            "UPDATE cron_jobs SET last_run_status = ?, last_error = ?, consecutive_errors = consecutive_errors + 1,
             last_duration_ms = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
            params![status, error, duration_ms, next, now, id],
        )?;
    } else {
        conn.execute(
            "UPDATE cron_jobs SET last_run_status = ?, last_error = NULL, consecutive_errors = 0,
             last_duration_ms = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
            params![status, duration_ms, next, now, id],
        )?;
    }
    Ok(())
}

fn last_response_text(messages: &[crate::types::Message]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|message| message.role == crate::types::Role::Assistant)
        .map(|message| message.text())
        .filter(|text| !text.trim().is_empty())
}

fn send_job_notification(
    notifier: Option<&Arc<dyn NativeNotifier>>,
    job: &DueCronJob,
    source: &str,
    response_text: &str,
) -> Option<String> {
    let notifier = notifier?;
    let title = job
        .delivery_notification_title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| job.name.clone());
    let body = if response_text.trim().is_empty() {
        format!("{} completed.", job.name)
    } else {
        response_text.to_string()
    };
    let data_json = serde_json::json!({
        "jobId": job.id,
        "jobName": job.name,
        "source": source,
        "deliveryMode": job.delivery_mode,
    })
    .to_string();
    Some(notifier.send_notification(title, body, data_json))
}

pub async fn handle_wake(
    config: &InitConfig,
    source: &str,
    callback: Option<Arc<dyn NativeEventCallback>>,
    notifier: Option<Arc<dyn NativeNotifier>>,
    memory_provider: Option<Arc<dyn MemoryProvider>>,
    abort_flag: Arc<Mutex<bool>>,
    approval_sender: Arc<Mutex<Option<oneshot::Sender<crate::types::ApprovalResponse>>>>,
    steer_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    mcp_tools: Arc<Mutex<Vec<crate::types::ToolDefinition>>>,
    mcp_pending: Arc<Mutex<HashMap<String, oneshot::Sender<crate::types::McpToolResult>>>>,
) -> Result<(), NativeAgentError> {
    let effective_callback = callback.unwrap_or_else(|| {
        Arc::new(PendingEventWriter {
            db_path: config.db_path.clone(),
        })
    });
    let callback_ref = Some(effective_callback.as_ref());
    let conn = open_db(&config.db_path)?;
    ensure_schema(&conn)?;

    let due_jobs = get_due_jobs(&conn)?;

    if due_jobs.is_empty() {
        crate::event_bus::emit(
            callback_ref,
            "wake.no_jobs",
            &serde_json::json!({
                "source": source,
            }),
        );
        return Ok(());
    }

    crate::event_bus::emit(
        callback_ref,
        "wake.jobs_found",
        &serde_json::json!({
            "source": source,
            "count": due_jobs.len(),
        }),
    );

    for job in &due_jobs {
        if *abort_flag.lock().await {
            return Err(NativeAgentError::Cancelled);
        }

        crate::event_bus::emit(
            callback_ref,
            "cron.job.started",
            &serde_json::json!({
                "jobId": job.id,
            }),
        );

        mark_job_running(&conn, &job.id)?;
        let run_id = insert_cron_run(&conn, &job.id, source)?;

        let params = crate::types::SendMessageParams {
            prompt: job.prompt.clone(),
            session_key: format!("cron-{}", job.id),
            model: None,
            provider: None,
            system_prompt: job.system_prompt.clone().unwrap_or_else(|| {
                "You are a helpful assistant running a scheduled task.".to_string()
            }),
            max_turns: Some(10),
            allowed_tools_json: job.allowed_tools.clone(),
            prior_messages_json: None,
        };

        let start_time = chrono::Utc::now().timestamp_millis();
        let start = std::time::Instant::now();
        let result = crate::agent_loop::run_agent_turn(crate::agent_loop::AgentLoopContext {
            config,
            params: &params,
            callback: Some(effective_callback.clone()),
            abort_flag: abort_flag.clone(),
            is_background: true,
            wall_clock_timeout_ms: Some(25_000),
            prior_messages: None,
            approval_sender: approval_sender.clone(),
            steer_rx: steer_rx.clone(),
            mcp_tools: mcp_tools.clone(),
            mcp_pending: mcp_pending.clone(),
            memory_provider: memory_provider.clone(),
            skip_user_echo: false,
            session_key: params.session_key.clone(),
        })
        .await;
        let duration_ms = start.elapsed().as_millis() as i64;

        match result {
            Ok(turn_result) => {
                let _ = save_session(
                    &conn,
                    &params.session_key,
                    &format!("cron:{}", job.id),
                    &turn_result.messages_json,
                    Some(&turn_result.model),
                    start_time,
                    Some(&turn_result.usage),
                );
                let response_text = last_response_text(&turn_result.messages);
                let notification_result = if job.delivery_mode == "notification" {
                    send_job_notification(
                        notifier.as_ref(),
                        job,
                        source,
                        response_text.as_deref().unwrap_or(""),
                    )
                } else {
                    None
                };
                if let Some(notification_id) = notification_result.as_ref() {
                    crate::event_bus::emit(
                        callback_ref,
                        "cron.notification",
                        &serde_json::json!({
                            "jobId": job.id,
                            "notificationId": notification_id,
                        }),
                    );
                }
                finalize_cron_run(
                    &conn,
                    run_id,
                    "ok",
                    duration_ms,
                    None,
                    response_text.as_deref(),
                    notification_result.is_some(),
                )?;
                mark_job_completed(&conn, &job.id, None, duration_ms)?;
                crate::event_bus::emit(
                    callback_ref,
                    "cron.job.completed",
                    &serde_json::json!({
                        "jobId": job.id,
                        "status": "ok",
                        "durationMs": duration_ms,
                    }),
                );
            }
            Err(e) => {
                let err_msg = e.to_string();
                let _ = save_session(
                    &conn,
                    &params.session_key,
                    &format!("cron:{}", job.id),
                    "[]",
                    None,
                    start_time,
                    None,
                );
                finalize_cron_run(
                    &conn,
                    run_id,
                    "error",
                    duration_ms,
                    Some(&err_msg),
                    None,
                    false,
                )?;
                mark_job_completed(&conn, &job.id, Some(&err_msg), duration_ms)?;
                crate::event_bus::emit(
                    callback_ref,
                    "cron.job.error",
                    &serde_json::json!({
                        "jobId": job.id,
                        "error": err_msg,
                    }),
                );
            }
        }
    }

    Ok(())
}

// ── Tool Permissions ────────────────────────────────────────────────────────

/// Seed tool permissions from a JSON array of defaults.
/// Uses INSERT OR IGNORE so existing user customizations are preserved.
pub fn seed_tool_permissions(conn: &Connection, defaults_json: &str) -> Result<u32, NativeAgentError> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(defaults_json)
        .map_err(|e| NativeAgentError::Agent { msg: format!("Invalid defaults JSON: {e}") })?;

    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO tool_permissions (tool_name, permission, enabled, source, group_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL)"
    )?;

    let mut count = 0u32;
    for entry in &entries {
        let name = entry.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() { continue; }
        let permission = entry.get("permission").and_then(|v| v.as_str()).unwrap_or("always_ask");
        let enabled = entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        let source = entry.get("source").and_then(|v| v.as_str());
        let group_id = entry.get("group_id").and_then(|v| v.as_str());

        let inserted = stmt.execute(params![name, permission, enabled as i32, source, group_id])?;
        if inserted > 0 { count += 1; }
    }
    Ok(count)
}

/// Set a single tool's permission (upsert).
pub fn set_tool_permission(
    conn: &Connection,
    tool_name: &str,
    permission: &str,
    enabled: bool,
) -> Result<(), NativeAgentError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    conn.execute(
        "INSERT INTO tool_permissions (tool_name, permission, enabled, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(tool_name) DO UPDATE SET permission = ?2, enabled = ?3, updated_at = ?4",
        params![tool_name, permission, enabled as i32, now],
    )?;
    Ok(())
}

/// List all tool permissions as JSON array.
pub fn list_tool_permissions(conn: &Connection) -> Result<String, NativeAgentError> {
    let mut stmt = conn.prepare(
        "SELECT tool_name, permission, enabled, source, group_id, updated_at FROM tool_permissions ORDER BY tool_name"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "tool_name": row.get::<_, String>(0)?,
            "permission": row.get::<_, String>(1)?,
            "enabled": row.get::<_, i32>(2)? != 0,
            "source": row.get::<_, Option<String>>(3)?,
            "group_id": row.get::<_, Option<String>>(4)?,
            "updated_at": row.get::<_, Option<i64>>(5)?,
        }))
    })?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(serde_json::to_string(&results)
        .map_err(|e| NativeAgentError::Agent { msg: format!("JSON serialize failed: {e}") })?)
}

/// Load tool permissions as a HashMap for fast lookup in agent loop.
pub fn load_tool_permissions_map(conn: &Connection) -> Result<std::collections::HashMap<String, (String, bool)>, NativeAgentError> {
    let mut stmt = conn.prepare(
        "SELECT tool_name, permission, enabled FROM tool_permissions"
    )?;
    let mut map = std::collections::HashMap::new();
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i32>(2)? != 0,
        ))
    })?;
    for row in rows {
        let (name, perm, enabled) = row?;
        map.insert(name, (perm, enabled));
    }
    Ok(map)
}

/// Delete all tool permissions (used for reset to defaults).
pub fn reset_tool_permissions(conn: &Connection) -> Result<(), NativeAgentError> {
    conn.execute("DELETE FROM tool_permissions", [])?;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn active_hours_json(
    start: Option<String>,
    end: Option<String>,
    tz: Option<String>,
) -> serde_json::Value {
    if start.is_none() && end.is_none() && tz.is_none() {
        return serde_json::Value::Null;
    }
    serde_json::json!({
        "start": start,
        "end": end,
        "tz": tz,
    })
}
