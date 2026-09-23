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
            output_tokens INTEGER DEFAULT 0,
            -- Turn budget and tool allow-list the session was created with.
            -- resumeSession() used to hardcode max_turns = 25 and drop the
            -- allow-list entirely, so resuming a restricted session silently
            -- unlocked every tool.
            max_turns INTEGER,
            allowed_tools_json TEXT
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

    // ── Migrations ─────────────────────────────────────────────────────────
    // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so columns
    // added after a release have to be patched in explicitly for databases
    // created by an older build. Adding a duplicate column is an error, so
    // check first.
    add_column_if_missing(conn, "sessions", "max_turns", "INTEGER")?;
    add_column_if_missing(conn, "sessions", "allowed_tools_json", "TEXT")?;

    Ok(())
}

/// `ALTER TABLE ... ADD COLUMN`, but only when the column is absent.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), NativeAgentError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|name| name == column);
    if !exists {
        conn.execute_batch(&format!(
            "ALTER TABLE {} ADD COLUMN {} {};",
            table, column, decl
        ))?;
    }
    Ok(())
}

// ── Sessions ────────────────────────────────────────────────────────────────

/// Persist the turn budget + tool allow-list a session runs under, so
/// `resumeSession` can restore the real constraints instead of guessing.
pub fn save_session_constraints(
    conn: &Connection,
    session_key: &str,
    max_turns: Option<u32>,
    allowed_tools_json: Option<&str>,
) -> Result<(), NativeAgentError> {
    conn.execute(
        "UPDATE sessions SET max_turns = ?, allowed_tools_json = ? WHERE session_key = ?",
        params![max_turns.map(|v| v as i64), allowed_tools_json, session_key],
    )?;
    Ok(())
}

/// Read back what `save_session_constraints` stored.
pub fn load_session_constraints(
    conn: &Connection,
    session_key: &str,
) -> Result<(Option<u32>, Option<String>), NativeAgentError> {
    let row = conn
        .query_row(
            "SELECT max_turns, allowed_tools_json FROM sessions WHERE session_key = ?",
            params![session_key],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?.map(|v| v.max(1) as u32),
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .unwrap_or((None, None));
    Ok(row)
}


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

    // Bound the queue. Background wakes keep appending while the app is closed;
    // without a cap a device that never foregrounds the app grows this table
    // forever. Keep the most recent MAX_PENDING_EVENTS and drop the oldest.
    const MAX_PENDING_EVENTS: i64 = 500;
    conn.execute(
        "DELETE FROM pending_events
         WHERE id NOT IN (
             SELECT id FROM pending_events ORDER BY created_at DESC, id DESC LIMIT ?1
         )",
        params![MAX_PENDING_EVENTS],
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

    // Delete ONLY the rows we just read. A blanket `DELETE FROM
    // pending_events` also discarded any event a background wake inserted
    // between the SELECT and the DELETE — those were never delivered to the
    // callback and were gone for good. Bounding the delete by the highest id
    // we actually returned closes that window.
    if let Some(max_id) = events.iter().map(|e| e.id).max() {
        conn.execute("DELETE FROM pending_events WHERE id <= ?1", params![max_id])?;
    }
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
    delivery_webhook_url: Option<String>,
    delivery_notification_title: Option<String>,
    session_target: String,
    /// Per-job quiet hours; `handle_wake` skips the job outside this window.
    active_hours: Option<ActiveHours>,
    /// From the job's skill, when it has one.
    model: Option<String>,
    provider: Option<String>,
    max_turns: Option<u32>,
    timeout_ms: Option<u64>,
    last_response_hash: Option<String>,
}

/// A quiet-hours window, stored as "HH:MM" strings plus an optional IANA zone.
#[derive(Clone, Debug)]
pub(crate) struct ActiveHours {
    start_minutes: u32,
    end_minutes: u32,
    /// Fixed offset from UTC in minutes. `None` = evaluate in device-local time.
    tz_offset_minutes: Option<i32>,
}

fn parse_hhmm(value: &str) -> Option<u32> {
    let (h, m) = value.split_once(':')?;
    let h: u32 = h.trim().parse().ok()?;
    let m: u32 = m.trim().parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

/// Parse the handful of timezone spellings we can honour without pulling in a
/// full tz database: "UTC"/"Z", and fixed offsets like "+06:00" / "-0330".
/// Anything else (a real IANA name such as "Asia/Dhaka") falls back to device
/// local time, which is the behaviour a phone user actually expects.
/// Parse a FIXED UTC offset such as `+06:00`, `-0500`, `+6`, `UTC`/`Z`/`GMT`.
///
/// IANA zone names (`Asia/Dhaka`, `America/New_York`) are NOT supported: that
/// needs a tz database (`chrono-tz`), which is not a dependency. Returning
/// `None` here used to mean "silently use the device's local time", so a job
/// configured for one zone would run against another with no warning — the
/// exact silent-failure pattern this audit flagged. Callers now log the
/// rejection, so a bad value is visible instead of quietly wrong.
fn parse_tz_offset_minutes(tz: &str) -> Option<i32> {
    let tz = tz.trim();
    if tz.eq_ignore_ascii_case("utc") || tz.eq_ignore_ascii_case("z") || tz.eq_ignore_ascii_case("gmt") {
        return Some(0);
    }
    let bytes = tz.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let sign = match bytes[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let rest = &tz[1..];
    let (h, m) = if let Some((h, m)) = rest.split_once(':') {
        (h, m)
    } else if rest.len() == 4 {
        (&rest[..2], &rest[2..])
    } else if rest.len() <= 2 {
        (rest, "0")
    } else {
        return None;
    };
    let h: i32 = h.trim().parse().ok()?;
    let m: i32 = m.trim().parse().ok()?;
    Some(sign * (h * 60 + m))
}

impl ActiveHours {
    pub(crate) fn parse(
        start: Option<String>,
        end: Option<String>,
        tz: Option<String>,
    ) -> Option<ActiveHours> {
        let start = start?;
        let end = end?;
        let start_minutes = parse_hhmm(&start)?;
        let end_minutes = parse_hhmm(&end)?;
        // Distinguish "no tz given" (fine — use device local) from "a tz was
        // given but we cannot honour it" (must not be silently ignored).
        let tz_offset_minutes = match tz.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => match parse_tz_offset_minutes(raw) {
                Some(offset) => Some(offset),
                None => {
                    tracing::warn!(
                        tz = raw,
                        "active-hours timezone is not a fixed UTC offset (IANA zone names are \
                         unsupported); falling back to device local time — the window may \
                         evaluate against the wrong zone. Use a form like +06:00."
                    );
                    None
                }
            },
        };
        Some(ActiveHours {
            start_minutes,
            end_minutes,
            tz_offset_minutes,
        })
    }

    /// Is `now_ms` inside the window? Windows that wrap past midnight
    /// (22:00→06:00) are supported.
    pub(crate) fn contains(&self, now_ms: i64) -> bool {
        let minutes_of_day = match self.tz_offset_minutes {
            Some(offset) => {
                let shifted = now_ms + (offset as i64) * 60_000;
                let dt = chrono::DateTime::from_timestamp_millis(shifted).unwrap_or_default();
                use chrono::Timelike;
                dt.hour() * 60 + dt.minute()
            }
            None => {
                use chrono::Timelike;
                let dt = chrono::Local::now();
                dt.hour() * 60 + dt.minute()
            }
        };
        if self.start_minutes <= self.end_minutes {
            minutes_of_day >= self.start_minutes && minutes_of_day < self.end_minutes
        } else {
            // Wraps midnight.
            minutes_of_day >= self.start_minutes || minutes_of_day < self.end_minutes
        }
    }
}

/// Resolved scheduler-level gates, read once per wake.
pub(crate) struct SchedulerGate {
    pub enabled: bool,
    pub active_hours: Option<ActiveHours>,
}

fn load_scheduler_gate(conn: &Connection) -> Result<SchedulerGate, NativeAgentError> {
    // `get_scheduler_config` seeds the row if missing, so reuse it.
    let raw = get_scheduler_config(conn)?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let enabled = value
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let active_hours = value.get("activeHours").and_then(|ah| {
        if ah.is_null() {
            None
        } else {
            ActiveHours::parse(
                ah.get("start").and_then(|v| v.as_str()).map(String::from),
                ah.get("end").and_then(|v| v.as_str()).map(String::from),
                ah.get("tz").and_then(|v| v.as_str()).map(String::from),
            )
        }
    });
    Ok(SchedulerGate {
        enabled,
        active_hours,
    })
}

fn get_due_jobs(conn: &Connection) -> Result<Vec<DueCronJob>, NativeAgentError> {
    let now = chrono::Utc::now().timestamp_millis();
    // Single query with a LEFT JOIN: the old code issued two extra SELECTs per
    // skill-bearing job (N+1) and, worse, swallowed a missing skill row with
    // `.ok().flatten()` so a job pointing at a deleted skill silently ran with
    // the default prompt and *unrestricted* tools. We now detect that case and
    // fail the job closed instead.
    let mut stmt = conn.prepare(
        "SELECT j.id, j.name, j.prompt, j.skill_id, j.delivery_mode, j.delivery_webhook_url,
                j.delivery_notification_title, j.session_target,
                j.active_hours_start, j.active_hours_end, j.active_hours_tz,
                j.last_response_hash,
                s.id, s.system_prompt, s.allowed_tools, s.model, s.max_turns, s.timeout_ms
         FROM cron_jobs j
         LEFT JOIN cron_skills s ON s.id = j.skill_id
         WHERE j.enabled = 1 AND j.next_run_at IS NOT NULL AND j.next_run_at <= ?
         ORDER BY j.next_run_at ASC",
    )?;

    let rows = stmt
        .query_map(params![now], |row| {
            let skill_id: Option<String> = row.get(3)?;
            let joined_skill_id: Option<String> = row.get(12)?;
            Ok((
                DueCronJob {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    prompt: row.get(2)?,
                    system_prompt: row.get(13)?,
                    allowed_tools: row.get(14)?,
                    delivery_mode: row.get(4)?,
                    delivery_webhook_url: row.get(5)?,
                    delivery_notification_title: row.get(6)?,
                    session_target: row
                        .get::<_, Option<String>>(7)?
                        .unwrap_or_else(|| "isolated".to_string()),
                    active_hours: ActiveHours::parse(row.get(8)?, row.get(9)?, row.get(10)?),
                    model: row.get(15)?,
                    provider: None,
                    max_turns: row.get::<_, Option<i64>>(16)?.map(|v| v.max(1) as u32),
                    timeout_ms: row.get::<_, Option<i64>>(17)?.map(|v| v.max(1) as u64),
                    last_response_hash: row.get(11)?,
                },
                skill_id,
                joined_skill_id,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();

    let mut result = Vec::new();
    for (job, skill_id, joined_skill_id) in rows {
        if skill_id.is_some() && joined_skill_id.is_none() {
            // The referenced skill was deleted. Running with default settings
            // would silently widen the job's tool access, so disable it and
            // record why instead.
            let msg = format!(
                "Job references skill '{}' which no longer exists; job disabled.",
                skill_id.unwrap_or_default()
            );
            tracing::warn!(job_id = %job.id, "{}", msg);
            conn.execute(
                "UPDATE cron_jobs SET enabled = 0, last_run_status = 'error', last_error = ?, updated_at = ?
                 WHERE id = ?",
                params![msg, chrono::Utc::now().timestamp_millis(), job.id],
            )?;
            continue;
        }
        result.push(job);
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

#[allow(clippy::too_many_arguments)]
fn finalize_cron_run(
    conn: &Connection,
    run_id: i64,
    status: &str,
    duration_ms: i64,
    error: Option<&str>,
    response_text: Option<&str>,
    delivered: bool,
    was_deduped: bool,
) -> Result<(), NativeAgentError> {
    let ended_at = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE cron_runs
         SET ended_at = ?1, status = ?2, duration_ms = ?3, error = ?4, response_text = ?5,
             delivered = ?6, was_deduped = ?7
         WHERE id = ?8",
        params![
            ended_at,
            status,
            duration_ms,
            error,
            response_text,
            if delivered { 1i64 } else { 0i64 },
            if was_deduped { 1i64 } else { 0i64 },
            run_id,
        ],
    )?;
    Ok(())
}

/// Maximum consecutive failures before a job is auto-disabled.
const MAX_CONSECUTIVE_ERRORS: i64 = 5;

fn mark_job_completed(
    conn: &Connection,
    id: &str,
    error: Option<&str>,
    duration_ms: i64,
) -> Result<(), NativeAgentError> {
    let now = chrono::Utc::now().timestamp_millis();
    let status = if error.is_some() { "error" } else { "ok" };

    // Advance next_run_at for recurring jobs.
    //
    // Two fixes here:
    //  * drift — the old code used `now + every_ms`, where `now` is when the run
    //    *finished*, so every execution's duration was added to the period. A
    //    hourly job taking 30 s drifted ~12 min/day. We anchor to the schedule
    //    instead (`schedule_anchor_ms`, which was stored but never read) and
    //    step forward in whole periods until we are in the future.
    //  * "at" jobs — they got `next_run_at = NULL` while staying `enabled = 1`,
    //    leaving a job that looks active in the UI but can never run again.
    //    One-shot jobs are now disabled explicitly.
    struct ScheduleRow {
        kind: Option<String>,
        every_ms: Option<i64>,
        anchor_ms: Option<i64>,
        next_run_at: Option<i64>,
    }
    let row = conn.query_row(
        "SELECT schedule_kind, schedule_every_ms, schedule_anchor_ms, next_run_at
         FROM cron_jobs WHERE id = ?",
        params![id],
        |row| {
            Ok(ScheduleRow {
                kind: row.get(0)?,
                every_ms: row.get(1)?,
                anchor_ms: row.get(2)?,
                next_run_at: row.get(3)?,
            })
        },
    )?;

    let mut disable_job = false;
    let next: Option<i64> = match (row.kind.as_deref(), row.every_ms) {
        (Some("every"), Some(every)) if every > 0 => {
            // Step from the anchor (or the slot we just served) in whole
            // periods until strictly after `now` — no accumulated drift.
            let base = row
                .anchor_ms
                .or(row.next_run_at)
                .unwrap_or(now);
            let mut next = base;
            if next <= now {
                let missed = (now - next) / every + 1;
                next += missed * every;
            }
            Some(next)
        }
        (Some("at"), _) => {
            // One-shot: it has fired, so retire it.
            disable_job = true;
            None
        }
        _ => None,
    };

    if let Some(err) = error {
        conn.execute(
            "UPDATE cron_jobs SET last_run_status = ?, last_error = ?, consecutive_errors = consecutive_errors + 1,
             last_duration_ms = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
            params![status, err, duration_ms, next, now, id],
        )?;

        // Auto-disable a job that keeps failing. Without this a job with, say,
        // a revoked API key retried on every wake forever, draining the battery
        // and spamming errors. `consecutive_errors` was incremented but never
        // read before.
        let errors: i64 = conn.query_row(
            "SELECT consecutive_errors FROM cron_jobs WHERE id = ?",
            params![id],
            |row| row.get(0),
        )?;
        if errors >= MAX_CONSECUTIVE_ERRORS {
            tracing::warn!(
                job_id = %id,
                consecutive_errors = errors,
                "disabling cron job after repeated failures"
            );
            conn.execute(
                "UPDATE cron_jobs SET enabled = 0, last_error = ?, updated_at = ? WHERE id = ?",
                params![
                    format!(
                        "Disabled automatically after {} consecutive failures. Last error: {}",
                        errors, err
                    ),
                    now,
                    id
                ],
            )?;
        }
    } else {
        conn.execute(
            "UPDATE cron_jobs SET last_run_status = ?, last_error = NULL, consecutive_errors = 0,
             last_duration_ms = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
            params![status, duration_ms, next, now, id],
        )?;
    }

    if disable_job {
        conn.execute(
            "UPDATE cron_jobs SET enabled = 0, updated_at = ? WHERE id = ?",
            params![now, id],
        )?;
    }
    Ok(())
}

/// Stable hash of a delivered response, used to suppress duplicate
/// notifications for jobs that keep producing the same answer.
fn response_hash(text: &str) -> String {
    // FNV-1a 64: no extra dependency, and collision risk is irrelevant for
    // "is this the same string as last time".
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
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

/// Outcome of delivering one cron result.
struct DeliveryOutcome {
    delivered: bool,
    deduped: bool,
    detail: Option<String>,
}

/// POST a cron result to the job's webhook.
///
/// `delivery_mode = "webhook"` and `delivery_webhook_url` were stored and
/// round-tripped through the API, but `handle_wake` only ever handled
/// `"notification"`, so webhook jobs produced no delivery at all and reported
/// success anyway.
async fn send_job_webhook(
    job: &DueCronJob,
    source: &str,
    response_text: &str,
) -> Result<(), String> {
    let url = job
        .delivery_webhook_url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| "delivery mode is 'webhook' but no webhook URL is configured".to_string())?;

    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("unsupported webhook URL scheme: {}", url));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "jobId": job.id,
        "jobName": job.name,
        "source": source,
        "response": response_text,
        "deliveredAt": chrono::Utc::now().timestamp_millis(),
    });

    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("webhook request failed: {}", e))?;

    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("webhook returned HTTP {}", status.as_u16()))
    }
}

/// Deliver a finished cron run according to its `delivery_mode`, suppressing a
/// repeat of the previous response.
async fn deliver_job_result(
    conn: &Connection,
    notifier: Option<&Arc<dyn NativeNotifier>>,
    job: &DueCronJob,
    source: &str,
    response_text: &str,
) -> DeliveryOutcome {
    // De-duplication: `last_response_hash` / `last_response_sent_at` existed in
    // the schema but were never written or compared, so an unchanged answer was
    // re-notified on every single run.
    let hash = response_hash(response_text);
    if !response_text.trim().is_empty() && job.last_response_hash.as_deref() == Some(hash.as_str()) {
        return DeliveryOutcome {
            delivered: false,
            deduped: true,
            detail: Some("identical to the previous response — delivery suppressed".into()),
        };
    }

    let outcome = match job.delivery_mode.as_str() {
        "notification" => match send_job_notification(notifier, job, source, response_text) {
            Some(id) => DeliveryOutcome {
                delivered: true,
                deduped: false,
                detail: Some(id),
            },
            None => DeliveryOutcome {
                delivered: false,
                deduped: false,
                detail: Some("no notifier registered on this platform".into()),
            },
        },
        "webhook" => match send_job_webhook(job, source, response_text).await {
            Ok(()) => DeliveryOutcome {
                delivered: true,
                deduped: false,
                detail: None,
            },
            Err(err) => DeliveryOutcome {
                delivered: false,
                deduped: false,
                detail: Some(err),
            },
        },
        "silent" | "none" => DeliveryOutcome {
            delivered: false,
            deduped: false,
            detail: Some("delivery mode is silent".into()),
        },
        other => DeliveryOutcome {
            delivered: false,
            deduped: false,
            detail: Some(format!("unknown delivery mode '{}'", other)),
        },
    };

    if outcome.delivered {
        let _ = conn.execute(
            "UPDATE cron_jobs SET last_response_hash = ?, last_response_sent_at = ? WHERE id = ?",
            params![hash, chrono::Utc::now().timestamp_millis(), job.id],
        );
    }
    outcome
}

/// Run one cron job end to end. Shared by the due-job loop and the heartbeat.
#[allow(clippy::too_many_arguments)]
async fn execute_cron_job(
    conn: &Connection,
    config: &InitConfig,
    job: &DueCronJob,
    source: &str,
    effective_callback: &Arc<dyn NativeEventCallback>,
    notifier: Option<&Arc<dyn NativeNotifier>>,
    memory_provider: &Option<Arc<dyn MemoryProvider>>,
    abort_flag: &Arc<Mutex<bool>>,
    approval_senders: &Arc<Mutex<HashMap<String, oneshot::Sender<crate::types::ApprovalResponse>>>>,
    steer_rx: &Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    mcp_tools: &Arc<Mutex<Vec<crate::types::ToolDefinition>>>,
    mcp_pending: &Arc<Mutex<HashMap<String, oneshot::Sender<crate::types::McpToolResult>>>>,
) -> Result<(), NativeAgentError> {
    let callback_ref = Some(effective_callback.as_ref());

    crate::event_bus::emit(
        callback_ref,
        "cron.job.started",
        &serde_json::json!({ "jobId": job.id, "source": source }),
    );

    mark_job_running(conn, &job.id)?;
    let run_id = insert_cron_run(conn, &job.id, source)?;

    // `session_target` was stored and patchable but never read: every job was
    // forced into its own "cron-<id>" session, so `sessionTarget: "main"` was a
    // no-op. Honour it, and carry prior history when the job shares a session.
    let session_key = match job.session_target.as_str() {
        "main" => "main".to_string(),
        "shared" => "cron-shared".to_string(),
        _ => format!("cron-{}", job.id),
    };
    let prior_messages = if job.session_target == "isolated" {
        None
    } else {
        load_session_messages_raw(conn, &session_key)
            .ok()
            .filter(|messages| !messages.is_empty())
    };

    let params = crate::types::SendMessageParams {
        prompt: job.prompt.clone(),
        session_key: session_key.clone(),
        // The skill's model/provider were stored but ignored, so every cron run
        // used the default (most expensive) model even when the skill asked for
        // a cheap one.
        model: job.model.clone(),
        provider: job.provider.clone(),
        system_prompt: job.system_prompt.clone().unwrap_or_else(|| {
            "You are a helpful assistant running a scheduled task.".to_string()
        }),
        // Likewise `max_turns` / `timeout_ms` from the skill row.
        max_turns: Some(job.max_turns.unwrap_or(10)),
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
        wall_clock_timeout_ms: Some(job.timeout_ms.unwrap_or(25_000)),
        prior_messages,
        approval_senders: approval_senders.clone(),
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
                conn,
                &params.session_key,
                &format!("cron:{}", job.id),
                &turn_result.messages_json,
                Some(&turn_result.model),
                start_time,
                Some(&turn_result.usage),
            );
            let response_text = last_response_text(&turn_result.messages);
            let outcome = deliver_job_result(
                conn,
                notifier,
                job,
                source,
                response_text.as_deref().unwrap_or(""),
            )
            .await;

            if outcome.delivered {
                crate::event_bus::emit(
                    callback_ref,
                    "cron.notification",
                    &serde_json::json!({
                        "jobId": job.id,
                        "deliveryMode": job.delivery_mode,
                        "notificationId": outcome.detail,
                    }),
                );
            } else if let Some(detail) = outcome.detail.as_deref() {
                crate::event_bus::emit(
                    callback_ref,
                    if outcome.deduped { "cron.deduped" } else { "cron.delivery_skipped" },
                    &serde_json::json!({
                        "jobId": job.id,
                        "deliveryMode": job.delivery_mode,
                        "reason": detail,
                    }),
                );
            }

            finalize_cron_run(
                conn,
                run_id,
                "ok",
                duration_ms,
                None,
                response_text.as_deref(),
                outcome.delivered,
                outcome.deduped,
            )?;
            mark_job_completed(conn, &job.id, None, duration_ms)?;
            crate::event_bus::emit(
                callback_ref,
                "cron.job.completed",
                &serde_json::json!({
                    "jobId": job.id,
                    "status": "ok",
                    "durationMs": duration_ms,
                    "delivered": outcome.delivered,
                    "deduped": outcome.deduped,
                }),
            );
        }
        Err(e) => {
            let err_msg = e.to_string();
            // NOTE: deliberately NOT calling save_session with "[]" here. The
            // old error path overwrote the session row with an empty message
            // array, destroying the entire conversation history on any
            // transient failure (a dropped connection was enough).
            finalize_cron_run(
                conn,
                run_id,
                "error",
                duration_ms,
                Some(&err_msg),
                None,
                false,
                false,
            )?;
            mark_job_completed(conn, &job.id, Some(&err_msg), duration_ms)?;
            crate::event_bus::emit(
                callback_ref,
                "cron.job.error",
                &serde_json::json!({ "jobId": job.id, "error": err_msg }),
            );
        }
    }
    Ok(())
}

/// Build the synthetic job that represents the heartbeat.
fn heartbeat_due_job(conn: &Connection, now: i64) -> Result<Option<DueCronJob>, NativeAgentError> {
    let raw = get_heartbeat_config(conn)?;
    let cfg: serde_json::Value = serde_json::from_str(&raw)?;

    if !cfg.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(None);
    }
    let next_run_at = cfg.get("nextRunAt").and_then(|v| v.as_i64());
    // A heartbeat that has never run is due immediately.
    if let Some(next) = next_run_at {
        if next > now {
            return Ok(None);
        }
    }

    let active_hours = cfg.get("activeHours").and_then(|ah| {
        if ah.is_null() {
            None
        } else {
            ActiveHours::parse(
                ah.get("start").and_then(|v| v.as_str()).map(String::from),
                ah.get("end").and_then(|v| v.as_str()).map(String::from),
                ah.get("tz").and_then(|v| v.as_str()).map(String::from),
            )
        }
    });

    let skill_id = cfg.get("skillId").and_then(|v| v.as_str());
    let (system_prompt, allowed_tools, model, max_turns, timeout_ms) = match skill_id {
        Some(sid) => conn
            .query_row(
                "SELECT system_prompt, allowed_tools, model, max_turns, timeout_ms
                 FROM cron_skills WHERE id = ?",
                params![sid],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?.map(|v| v.max(1) as u32),
                        row.get::<_, Option<i64>>(4)?.map(|v| v.max(1) as u64),
                    ))
                },
            )
            .unwrap_or((None, None, None, None, None)),
        None => (None, None, None, None, None),
    };

    Ok(Some(DueCronJob {
        id: HEARTBEAT_JOB_ID.to_string(),
        name: "Heartbeat".to_string(),
        prompt: cfg
            .get("prompt")
            .and_then(|v| v.as_str())
            .filter(|p| !p.trim().is_empty())
            .unwrap_or(
                "Run the periodic check described in HEARTBEAT.md. Report only what changed.",
            )
            .to_string(),
        system_prompt,
        allowed_tools,
        delivery_mode: "notification".to_string(),
        delivery_webhook_url: None,
        delivery_notification_title: Some("Heartbeat".to_string()),
        session_target: "shared".to_string(),
        active_hours,
        model,
        provider: None,
        max_turns,
        timeout_ms,
        last_response_hash: cfg
            .get("lastHash")
            .and_then(|v| v.as_str())
            .map(String::from),
    }))
}

/// Synthetic job id used for heartbeat runs in `cron_runs`.
const HEARTBEAT_JOB_ID: &str = "__heartbeat__";

/// Run the heartbeat turn and roll its schedule forward.
#[allow(clippy::too_many_arguments)]
async fn run_heartbeat(
    conn: &Connection,
    config: &InitConfig,
    job: &DueCronJob,
    source: &str,
    effective_callback: &Arc<dyn NativeEventCallback>,
    notifier: Option<&Arc<dyn NativeNotifier>>,
    memory_provider: &Option<Arc<dyn MemoryProvider>>,
    abort_flag: &Arc<Mutex<bool>>,
    approval_senders: &Arc<Mutex<HashMap<String, oneshot::Sender<crate::types::ApprovalResponse>>>>,
    steer_rx: &Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
    mcp_tools: &Arc<Mutex<Vec<crate::types::ToolDefinition>>>,
    mcp_pending: &Arc<Mutex<HashMap<String, oneshot::Sender<crate::types::McpToolResult>>>>,
) -> Result<(), NativeAgentError> {
    let callback_ref = Some(effective_callback.as_ref());
    let now = chrono::Utc::now().timestamp_millis();

    crate::event_bus::emit(
        callback_ref,
        "heartbeat.started",
        &serde_json::json!({ "source": source }),
    );

    let run_id = insert_cron_run(conn, HEARTBEAT_JOB_ID, source)?;
    let start = std::time::Instant::now();
    let start_time = now;

    let params = crate::types::SendMessageParams {
        prompt: job.prompt.clone(),
        session_key: "heartbeat".to_string(),
        model: job.model.clone(),
        provider: None,
        system_prompt: job
            .system_prompt
            .clone()
            .unwrap_or_else(|| "You are the device heartbeat. Be brief.".to_string()),
        max_turns: Some(job.max_turns.unwrap_or(5)),
        allowed_tools_json: job.allowed_tools.clone(),
        prior_messages_json: None,
    };

    let prior_messages = load_session_messages_raw(conn, &params.session_key)
        .ok()
        .filter(|messages| !messages.is_empty());

    let result = crate::agent_loop::run_agent_turn(crate::agent_loop::AgentLoopContext {
        config,
        params: &params,
        callback: Some(effective_callback.clone()),
        abort_flag: abort_flag.clone(),
        is_background: true,
        wall_clock_timeout_ms: Some(job.timeout_ms.unwrap_or(25_000)),
        prior_messages,
        approval_senders: approval_senders.clone(),
        steer_rx: steer_rx.clone(),
        mcp_tools: mcp_tools.clone(),
        mcp_pending: mcp_pending.clone(),
        memory_provider: memory_provider.clone(),
        skip_user_echo: true,
        session_key: params.session_key.clone(),
    })
    .await;
    let duration_ms = start.elapsed().as_millis() as i64;

    // Roll the schedule forward regardless of the outcome, so a failing
    // heartbeat does not hot-loop on every wake.
    let every_ms: i64 = conn
        .query_row(
            "SELECT every_ms FROM heartbeat_config WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(1_800_000);
    let next = now + every_ms.max(60_000);
    conn.execute(
        "UPDATE heartbeat_config SET next_run_at = ?, updated_at = ? WHERE id = 1",
        params![next, now],
    )?;

    match result {
        Ok(turn_result) => {
            let _ = save_session(
                conn,
                &params.session_key,
                "heartbeat",
                &turn_result.messages_json,
                Some(&turn_result.model),
                start_time,
                Some(&turn_result.usage),
            );
            let response_text = last_response_text(&turn_result.messages).unwrap_or_default();
            let hash = response_hash(&response_text);
            let deduped = !response_text.trim().is_empty()
                && job.last_response_hash.as_deref() == Some(hash.as_str());

            let delivered = if deduped {
                false
            } else {
                let sent = send_job_notification(notifier, job, source, &response_text).is_some();
                if sent {
                    conn.execute(
                        "UPDATE heartbeat_config SET last_heartbeat_hash = ?, last_heartbeat_sent_at = ?
                         WHERE id = 1",
                        params![hash, now],
                    )?;
                }
                sent
            };

            finalize_cron_run(
                conn,
                run_id,
                "ok",
                duration_ms,
                None,
                Some(&response_text),
                delivered,
                deduped,
            )?;
            conn.execute(
                "UPDATE cron_runs SET was_heartbeat_ok = 1 WHERE id = ?",
                params![run_id],
            )?;
            crate::event_bus::emit(
                callback_ref,
                "heartbeat.completed",
                &serde_json::json!({
                    "durationMs": duration_ms,
                    "delivered": delivered,
                    "deduped": deduped,
                    "nextRunAt": next,
                }),
            );
        }
        Err(e) => {
            let err_msg = e.to_string();
            finalize_cron_run(
                conn,
                run_id,
                "error",
                duration_ms,
                Some(&err_msg),
                None,
                false,
                false,
            )?;
            crate::event_bus::emit(
                callback_ref,
                "heartbeat.error",
                &serde_json::json!({ "error": err_msg, "nextRunAt": next }),
            );
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn handle_wake(
    config: &InitConfig,
    source: &str,
    callback: Option<Arc<dyn NativeEventCallback>>,
    notifier: Option<Arc<dyn NativeNotifier>>,
    memory_provider: Option<Arc<dyn MemoryProvider>>,
    abort_flag: Arc<Mutex<bool>>,
    approval_senders: Arc<Mutex<HashMap<String, oneshot::Sender<crate::types::ApprovalResponse>>>>,
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

    let now = chrono::Utc::now().timestamp_millis();

    // ── Gate 1: the scheduler master switch ────────────────────────────────
    // `scheduler_config.enabled` was written and read back by the API but never
    // consulted here, so "pause all scheduling" did nothing at all.
    let gate = load_scheduler_gate(&conn)?;
    if !gate.enabled {
        crate::event_bus::emit(
            callback_ref,
            "wake.skipped",
            &serde_json::json!({ "source": source, "reason": "scheduler disabled" }),
        );
        return Ok(());
    }

    // ── Gate 2: global quiet hours ─────────────────────────────────────────
    if let Some(hours) = gate.active_hours.as_ref() {
        if !hours.contains(now) {
            crate::event_bus::emit(
                callback_ref,
                "wake.skipped",
                &serde_json::json!({
                    "source": source,
                    "reason": "outside global active hours",
                }),
            );
            return Ok(());
        }
    }

    let all_due = get_due_jobs(&conn)?;

    // ── Gate 3: per-job quiet hours ────────────────────────────────────────
    let mut due_jobs = Vec::new();
    let mut skipped = 0usize;
    for job in all_due {
        if let Some(hours) = job.active_hours.as_ref() {
            if !hours.contains(now) {
                skipped += 1;
                crate::event_bus::emit(
                    callback_ref,
                    "cron.job.skipped",
                    &serde_json::json!({
                        "jobId": job.id,
                        "reason": "outside job active hours",
                    }),
                );
                continue;
            }
        }
        due_jobs.push(job);
    }

    // The heartbeat is a first-class schedule that `handle_wake` simply never
    // ran: `heartbeat_config` was pure storage.
    let heartbeat = heartbeat_due_job(&conn, now)?.filter(|hb| {
        hb.active_hours
            .as_ref()
            .map(|hours| hours.contains(now))
            .unwrap_or(true)
    });

    if due_jobs.is_empty() && heartbeat.is_none() {
        crate::event_bus::emit(
            callback_ref,
            "wake.no_jobs",
            &serde_json::json!({ "source": source, "skipped": skipped }),
        );
        return Ok(());
    }

    crate::event_bus::emit(
        callback_ref,
        "wake.jobs_found",
        &serde_json::json!({
            "source": source,
            "count": due_jobs.len(),
            "skipped": skipped,
            "heartbeat": heartbeat.is_some(),
        }),
    );

    for job in &due_jobs {
        if *abort_flag.lock().await {
            return Err(NativeAgentError::Cancelled);
        }
        execute_cron_job(
            &conn,
            config,
            job,
            source,
            &effective_callback,
            notifier.as_ref(),
            &memory_provider,
            &abort_flag,
            &approval_senders,
            &steer_rx,
            &mcp_tools,
            &mcp_pending,
        )
        .await?;
    }

    if let Some(hb) = heartbeat.as_ref() {
        if *abort_flag.lock().await {
            return Err(NativeAgentError::Cancelled);
        }
        run_heartbeat(
            &conn,
            config,
            hb,
            source,
            &effective_callback,
            notifier.as_ref(),
            &memory_provider,
            &abort_flag,
            &approval_senders,
            &steer_rx,
            &mcp_tools,
            &mcp_pending,
        )
        .await?;
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

#[cfg(test)]
mod pending_event_tests {
    use super::*;

    fn tmp() -> String {
        std::env::temp_dir()
            .join(format!(
                "nk-pe-{}-{}.db",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn db() -> (String, Connection) {
        let path = tmp();
        let conn = open_db(&path).unwrap();
        ensure_schema(&conn).unwrap();
        (path, conn)
    }

    #[test]
    fn events_drain_in_order_and_only_once() {
        let (path, conn) = db();
        for i in 0..3 {
            queue_pending_event(&conn, "wake.jobs_found", &format!("{{\"n\":{i}}}")).unwrap();
        }
        let drained = drain_pending_events(&conn).unwrap();
        assert_eq!(drained.len(), 3);
        assert_eq!(drained[0].payload_json, r#"{"n":0}"#, "oldest first");
        assert_eq!(drained[2].payload_json, r#"{"n":2}"#);
        // A second drain must return nothing.
        assert!(drain_pending_events(&conn).unwrap().is_empty());
        std::fs::remove_file(&path).ok();
    }

    /// The race the bounded DELETE closes: a background wake inserting an event
    /// after the SELECT must NOT be wiped by the drain.
    #[test]
    fn an_event_arriving_during_a_drain_is_not_lost() {
        let (path, conn) = db();
        queue_pending_event(&conn, "cron.job.completed", "{\"a\":1}").unwrap();

        // Simulate the drain's read half.
        let read: Vec<i64> = {
            let mut st = conn
                .prepare("SELECT id FROM pending_events ORDER BY created_at ASC, id ASC")
                .unwrap();
            let v = st
                .query_map([], |r| r.get::<_, i64>(0))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            v
        };
        // A wake fires here, between SELECT and DELETE.
        queue_pending_event(&conn, "cron.job.completed", "{\"b\":2}").unwrap();

        // The bounded delete only removes what was read.
        let max_id = read.iter().copied().max().unwrap();
        conn.execute("DELETE FROM pending_events WHERE id <= ?1", params![max_id])
            .unwrap();

        let left = drain_pending_events(&conn).unwrap();
        assert_eq!(left.len(), 1, "the late event must survive");
        assert_eq!(left[0].payload_json, r#"{"b":2}"#);
        std::fs::remove_file(&path).ok();
    }

    /// An app that never foregrounds must not grow the table without bound.
    #[test]
    fn the_queue_is_capped_and_keeps_the_newest() {
        let (path, conn) = db();
        for i in 0..520 {
            queue_pending_event(&conn, "wake.no_jobs", &format!("{{\"i\":{i}}}")).unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pending_events", [], |r| r.get(0))
            .unwrap();
        assert!(count <= 500, "queue grew to {count}");

        let drained = drain_pending_events(&conn).unwrap();
        // The newest event must be retained; the oldest dropped.
        let last = drained.last().unwrap();
        assert_eq!(last.payload_json, r#"{"i":519}"#);
        assert!(
            !drained.iter().any(|e| e.payload_json == r#"{"i":0}"#),
            "the oldest events should have been evicted"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn draining_an_empty_queue_is_a_no_op() {
        let (path, conn) = db();
        assert!(drain_pending_events(&conn).unwrap().is_empty());
        std::fs::remove_file(&path).ok();
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    fn tmp_db() -> String {
        std::env::temp_dir()
            .join(format!(
                "nk-mig-{}-{}.db",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// `CREATE TABLE IF NOT EXISTS` does NOT add columns to a table that
    /// already exists. An app upgrading from the published version has a
    /// `sessions` table without `max_turns`/`allowed_tools_json`, so the
    /// migration must add them or every session query fails with
    /// "no such column" on real user devices.
    #[test]
    fn upgrading_an_existing_database_adds_the_new_session_columns() {
        let path = tmp_db();
        {
            // Exactly the pre-upgrade `sessions` table (v0.5.2 shape).
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (
                    session_key TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL DEFAULT 'main',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    model TEXT,
                    total_tokens INTEGER DEFAULT 0,
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sessions (session_key, created_at, updated_at) VALUES ('old', 1, 1)",
                [],
            )
            .unwrap();
        }

        // The upgrade path.
        let conn = open_db(&path).unwrap();
        ensure_schema(&conn).unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(sessions)").unwrap();
        let names: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(names.contains(&"max_turns".to_string()), "max_turns missing: {names:?}");
        assert!(
            names.contains(&"allowed_tools_json".to_string()),
            "allowed_tools_json missing: {names:?}"
        );

        // The pre-existing row must survive, and the new columns must be usable.
        save_session_constraints(&conn, "old", Some(7), Some(r#"["read_file"]"#)).unwrap();
        let (turns, tools): (Option<u32>, Option<String>) = conn
            .query_row(
                "SELECT max_turns, allowed_tools_json FROM sessions WHERE session_key='old'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(turns, Some(7));
        assert_eq!(tools.as_deref(), Some(r#"["read_file"]"#));

        std::fs::remove_file(&path).ok();
    }

    /// Running the migration repeatedly must be a no-op — a duplicate
    /// `ALTER TABLE ADD COLUMN` is a hard error that would brick every launch.
    #[test]
    fn the_migration_is_idempotent() {
        let path = tmp_db();
        let conn = open_db(&path).unwrap();
        for i in 0..5 {
            ensure_schema(&conn).unwrap_or_else(|e| panic!("run {i} failed: {e:?}"));
        }
        std::fs::remove_file(&path).ok();
    }

    /// A fresh install and an upgraded install must end up identical.
    #[test]
    fn a_fresh_database_matches_an_upgraded_one() {
        let fresh_path = tmp_db();
        let fresh = open_db(&fresh_path).unwrap();
        ensure_schema(&fresh).unwrap();

        let upgraded_path = tmp_db();
        {
            let c = Connection::open(&upgraded_path).unwrap();
            c.execute_batch(
                "CREATE TABLE sessions (
                    session_key TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL DEFAULT 'main',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    model TEXT,
                    total_tokens INTEGER DEFAULT 0,
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0
                );",
            )
            .unwrap();
        }
        let upgraded = open_db(&upgraded_path).unwrap();
        ensure_schema(&upgraded).unwrap();

        let names = |c: &Connection| -> Vec<String> {
            let mut st = c.prepare("PRAGMA table_info(sessions)").unwrap();
            let mut v: Vec<String> = st
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .filter_map(|r| r.ok())
                .collect();
            v.sort();
            v
        };
        assert_eq!(names(&fresh), names(&upgraded));

        std::fs::remove_file(&fresh_path).ok();
        std::fs::remove_file(&upgraded_path).ok();
    }

    /// WAL + busy_timeout must actually be applied: without them concurrent
    /// access from the WebView and the agent returns SQLITE_BUSY.
    #[test]
    fn the_connection_uses_wal_and_a_busy_timeout() {
        let path = tmp_db();
        let conn = open_db(&path).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let timeout: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert!(timeout >= 5000, "busy_timeout was {timeout}");
        std::fs::remove_file(&path).ok();
    }
}

#[cfg(test)]
mod scheduler_gate_tests {
    use super::*;

    /// The exact arithmetic `mark_job_completed` uses to advance a recurring
    /// job, extracted so the drift property can be asserted directly.
    fn next_slot(base: i64, every: i64, now: i64) -> i64 {
        let mut next = base;
        if next <= now {
            let missed = (now - next) / every + 1;
            next += missed * every;
        }
        next
    }

    #[test]
    fn a_recurring_job_does_not_drift_when_runs_take_time() {
        let every = 3_600_000; // hourly
        let anchor = 0;
        // Each run finishes 30 s late. Anchored scheduling must keep landing on
        // exact hour boundaries; `now + every` would add 30 s every single time
        // (~12 min/day).
        let mut slot = anchor;
        for hour in 1..=24 {
            let finished = slot + 30_000;
            slot = next_slot(anchor, every, finished);
            assert_eq!(
                slot,
                hour * every,
                "hour {hour} must stay on the exact boundary"
            );
        }
        assert_eq!(slot, 24 * every, "no drift after a full day");
    }

    #[test]
    fn a_long_outage_skips_missed_slots_instead_of_replaying_them() {
        let every = 3_600_000;
        let anchor = 0;
        // Device asleep for ~3.5 h: schedule the NEXT future slot, not a backlog.
        let now = 3 * every + 1_800_000;
        let slot = next_slot(anchor, every, now);
        assert_eq!(slot, 4 * every);
        assert!(slot > now, "must be strictly in the future");
    }

    #[test]
    fn the_next_slot_is_always_strictly_in_the_future() {
        let every = 900_000; // 15 min
        for offset in [0, 1, every - 1, every, every + 1, 10 * every] {
            let slot = next_slot(0, every, offset);
            assert!(slot > offset, "slot {slot} must be after now {offset}");
            assert_eq!(slot % every, 0, "must stay aligned to the anchor grid");
        }
    }

    #[test]
    fn identical_text_hashes_identically_and_different_text_does_not() {
        // Drives the cron dedup: same answer twice must not notify twice.
        assert_eq!(response_hash("no changes"), response_hash("no changes"));
        assert_ne!(response_hash("no changes"), response_hash("no changes."));
        assert_ne!(response_hash(""), response_hash(" "));
        // Known FNV-1a 64 vector for the empty string (the offset basis).
        assert_eq!(response_hash(""), "cbf29ce484222325");
        // Bangla text must hash stably too (bytes, not chars).
        assert_eq!(response_hash("আমি"), response_hash("আমি"));
        assert_eq!(response_hash("আমি").len(), 16);
    }

    /// Midnight UTC on 2026-01-01, as epoch millis.
    const MIDNIGHT_UTC: i64 = 1_767_225_600_000;

    fn at_utc(hour: i64, minute: i64) -> i64 {
        MIDNIGHT_UTC + hour * 3_600_000 + minute * 60_000
    }

    #[test]
    fn fixed_utc_offsets_parse_in_every_accepted_spelling() {
        assert_eq!(parse_tz_offset_minutes("+06:00"), Some(360));
        assert_eq!(parse_tz_offset_minutes("+0600"), Some(360));
        assert_eq!(parse_tz_offset_minutes("+6"), Some(360));
        assert_eq!(parse_tz_offset_minutes("-05:30"), Some(-330));
        assert_eq!(parse_tz_offset_minutes("-0530"), Some(-330));
        for z in ["UTC", "utc", "Z", "gmt"] {
            assert_eq!(parse_tz_offset_minutes(z), Some(0), "{z}");
        }
        // IANA names are deliberately unsupported (no tz database linked).
        assert_eq!(parse_tz_offset_minutes("Asia/Dhaka"), None);
        assert_eq!(parse_tz_offset_minutes("garbage"), None);
        assert_eq!(parse_tz_offset_minutes(""), None);
    }

    #[test]
    fn a_normal_window_includes_its_start_and_excludes_its_end() {
        // 09:00–17:00 in UTC+00.
        let ah = ActiveHours::parse(
            Some("09:00".into()),
            Some("17:00".into()),
            Some("UTC".into()),
        )
        .unwrap();

        assert!(!ah.contains(at_utc(8, 59)));
        assert!(ah.contains(at_utc(9, 0)), "start is inclusive");
        assert!(ah.contains(at_utc(16, 59)));
        assert!(!ah.contains(at_utc(17, 0)), "end is exclusive");
    }

    #[test]
    fn a_window_that_wraps_midnight_is_handled() {
        // 22:00–06:00 in UTC+00 — the case a naive start<=now<end test breaks on.
        let ah = ActiveHours::parse(
            Some("22:00".into()),
            Some("06:00".into()),
            Some("UTC".into()),
        )
        .unwrap();

        assert!(ah.contains(at_utc(23, 0)), "before midnight");
        assert!(ah.contains(at_utc(0, 30)), "after midnight");
        assert!(ah.contains(at_utc(5, 59)));
        assert!(!ah.contains(at_utc(6, 0)), "end is exclusive");
        assert!(!ah.contains(at_utc(12, 0)), "midday is outside");
        assert!(ah.contains(at_utc(22, 0)), "start is inclusive");
    }

    #[test]
    fn the_offset_actually_shifts_the_window() {
        // 09:00–17:00 at UTC+06 (Dhaka) == 03:00–11:00 UTC.
        let ah = ActiveHours::parse(
            Some("09:00".into()),
            Some("17:00".into()),
            Some("+06:00".into()),
        )
        .unwrap();

        assert!(ah.contains(at_utc(3, 0)), "09:00 local");
        assert!(ah.contains(at_utc(10, 59)), "16:59 local");
        assert!(!ah.contains(at_utc(11, 0)), "17:00 local is excluded");
        assert!(!ah.contains(at_utc(2, 59)), "08:59 local");
        // Same clock times with no offset must behave differently, proving the
        // offset is applied rather than ignored.
        let utc = ActiveHours::parse(
            Some("09:00".into()),
            Some("17:00".into()),
            Some("UTC".into()),
        )
        .unwrap();
        assert!(!utc.contains(at_utc(3, 0)));
    }

    #[test]
    fn a_window_needs_both_ends_and_valid_times() {
        assert!(ActiveHours::parse(Some("09:00".into()), None, None).is_none());
        assert!(ActiveHours::parse(None, Some("17:00".into()), None).is_none());
        assert!(
            ActiveHours::parse(Some("nope".into()), Some("17:00".into()), None).is_none(),
            "an unparseable time must not silently become a window"
        );
    }
}
