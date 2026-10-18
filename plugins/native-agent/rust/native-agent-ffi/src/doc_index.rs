//! On-device document index — Phase-1 RAG (keyword retrieval, SQLite FTS5).
//!
//! The engine's `memory_*` tools store short facts and answer with a lexical
//! scorer on the host side; they are deliberately NOT semantic and they are a
//! poor fit for long reference material. This module adds the complementary
//! piece: a full-text index over whole documents, built on SQLite FTS5 (the
//! `bundled` rusqlite build compiles SQLite with `-DSQLITE_ENABLE_FTS5`, so
//! there is no new dependency and no host-side code — iOS and Android get it
//! from the same FFI).
//!
//! Design notes:
//!  * One index file per app, `document_index.sqlite3`, stored next to the
//!    session database (same private directory, same lifetime/backup rules).
//!    A connection is opened per call: writes are rare, reads are
//!    milliseconds, and per-call opens avoid all cross-thread `Connection`
//!    sharing issues. `busy_timeout` covers concurrent sessions.
//!  * `tokenize = 'unicode61'` splits on Unicode whitespace/punctuation, so
//!    Bengali and English text index as words (no stemming — an honest
//!    limitation stated in the tool description).
//!  * User queries are re-quoted token-by-token before they reach `MATCH`:
//!    raw FTS5 syntax (`"`, `*`, `NEAR`, `-`) would otherwise be a syntax
//!    error or an unintended query shape.
//!  * Chunking targets ~1200 chars with a small overlap, preferring
//!    paragraph, then sentence boundaries — the Bengali danda (`।`) is a
//!    sentence ender here.
//!  * `index_document` and `forget_document` mutate the index and therefore
//!    require approval by default; `search_documents` and `list_documents`
//!    are read-only.

use crate::tool_runner::resolve_path;
use crate::NativeAgentError;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_INLINE_CONTENT_CHARS: usize = 256_000;
const MAX_FILE_CONTENT_CHARS: usize = 1_000_000;
const MAX_TITLE_CHARS: usize = 300;
const MAX_SOURCE_CHARS: usize = 1_000;
const MAX_DOC_ID_CHARS: usize = 120;
const MAX_CHUNKS_PER_DOC: usize = 400;
const MAX_TOTAL_CHUNKS: i64 = 50_000;
const CHUNK_TARGET_CHARS: usize = 1_200;
const CHUNK_OVERLAP_CHARS: usize = 150;
const MAX_QUERY_CHARS: usize = 400;
const SNIPPET_TOKENS: i32 = 24;

fn tool_err(msg: String) -> serde_json::Value {
    serde_json::json!({ "error": msg })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// The index lives beside the session database so it shares its directory,
/// lifetime and backup treatment without being part of the session schema.
fn index_path(db_path: &str) -> PathBuf {
    let base = Path::new(db_path);
    match base.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.join("document_index.sqlite3"),
        _ => PathBuf::from("document_index.sqlite3"),
    }
}

fn open_index(db_path: &str) -> Result<Connection, NativeAgentError> {
    let path = index_path(db_path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| NativeAgentError::Tool {
            msg: format!("Document index directory could not be created: {}", e),
        })?;
    }
    let conn = Connection::open(&path).map_err(|e| NativeAgentError::Tool {
        msg: format!("Document index could not be opened: {}", e),
    })?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|e| NativeAgentError::Tool {
            msg: format!("Document index busy-timeout failed: {}", e),
        })?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS documents(
            doc_id        TEXT PRIMARY KEY,
            title         TEXT NOT NULL,
            source        TEXT NOT NULL DEFAULT '',
            chunk_count   INTEGER NOT NULL,
            content_chars INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
            body,
            doc_id UNINDEXED,
            seq    UNINDEXED,
            tokenize = 'unicode61'
        );",
    )
    .map_err(|e| NativeAgentError::Tool {
        msg: format!("Document index schema could not be initialised: {}", e),
    })?;
    Ok(conn)
}

fn totals(conn: &Connection) -> Result<(i64, i64), NativeAgentError> {
    let docs: i64 = conn
        .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
        .map_err(|e| NativeAgentError::Tool { msg: format!("Index read failed: {}", e) })?;
    let chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM document_chunks", [], |row| row.get(0))
        .map_err(|e| NativeAgentError::Tool { msg: format!("Index read failed: {}", e) })?;
    Ok((docs, chunks))
}

/// FNV-1a 64-bit — a stable, dependency-free content hash for default ids.
fn fnv64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn slug(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.chars().count() >= max_chars {
            break;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Quote each whitespace-separated term so arbitrary user text can never
/// become FTS5 query syntax. Terms are AND-ed; at most 16 terms.
pub(crate) fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.replace(['"', '\\'], ""))
        .filter(|term| !term.is_empty())
        .take(16)
        .map(|term| format!("\"{}\"", term))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

fn char_count(text: &str) -> usize {
    text.chars().count()
}

fn take_tail_chars(text: &str, max_chars: usize) -> String {
    if char_count(text) <= max_chars {
        return text.to_string();
    }
    let skip = char_count(text) - max_chars;
    text.chars().skip(skip).collect()
}

/// Split on sentence enders, including the Bengali danda (।). A sentence is
/// closed by the ender plus trailing whitespace/quote so abbreviations like
/// "e.g." are less likely to shatter (best effort, not a parser).
fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?' | '।') {
            let mut closing = true;
            while let Some(&next) = chars.peek() {
                if next.is_whitespace() {
                    current.push(chars.next().unwrap());
                } else {
                    closing = false;
                    break;
                }
            }
            if closing && !current.trim().is_empty() {
                sentences.push(current.trim().to_string());
                current = String::new();
            }
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current.trim().to_string());
    }
    sentences
}

/// Hard-split an over-long unit into fixed char windows.
fn hard_split(text: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if current.chars().count() >= CHUNK_TARGET_CHARS {
            parts.push(current.clone());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

/// Paragraph → sentence → hard-split packing with a small overlap, so a match
/// that straddles a boundary is still findable in one chunk.
pub(crate) fn chunk_text(text: &str) -> Vec<String> {
    let normalized: String = text.replace("\r\n", "\n");
    let mut packed: Vec<String> = Vec::new();
    let mut current = String::new();

    let mut push_unit = |unit: &str, packed: &mut Vec<String>, current: &mut String| {
        let unit_len = char_count(unit);
        let current_len = char_count(current);
        if current_len + unit_len + 2 <= CHUNK_TARGET_CHARS {
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(unit);
        } else {
            if !current.trim().is_empty() {
                packed.push(current.clone());
            }
            *current = unit.to_string();
        }
    };

    for paragraph in normalized.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if char_count(paragraph) > CHUNK_TARGET_CHARS {
            for sentence in split_sentences(paragraph) {
                if char_count(&sentence) > CHUNK_TARGET_CHARS {
                    for piece in hard_split(&sentence) {
                        push_unit(&piece, &mut packed, &mut current);
                    }
                } else {
                    push_unit(&sentence, &mut packed, &mut current);
                }
            }
        } else {
            push_unit(paragraph, &mut packed, &mut current);
        }
    }
    if !current.trim().is_empty() {
        packed.push(current);
    }

    // Overlap pass: prefix each chunk with the tail of its predecessor.
    let mut chunks: Vec<String> = Vec::with_capacity(packed.len());
    for (index, body) in packed.iter().enumerate() {
        let mut chunk = String::new();
        if index > 0 {
            chunk.push_str(&take_tail_chars(&packed[index - 1], CHUNK_OVERLAP_CHARS));
            chunk.push(' ');
        }
        chunk.push_str(body);
        chunks.push(chunk);
        if chunks.len() >= MAX_CHUNKS_PER_DOC {
            break;
        }
    }
    chunks
}

fn clean_doc_id(raw: &str) -> Option<String> {
    let id: String = raw.trim().to_string();
    if id.is_empty() || id.len() > MAX_DOC_ID_CHARS {
        return None;
    }
    if !id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_')) {
        return None;
    }
    Some(id)
}

// ── Tools ───────────────────────────────────────────────────────────────────

pub(crate) fn tool_index_document(
    args: &serde_json::Value,
    workspace: &str,
    db_path: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let title = args["title"].as_str().unwrap_or("").trim().to_string();
    if title.is_empty() {
        return Ok(tool_err("'title' is required (1-300 characters).".into()));
    }
    if char_count(&title) > MAX_TITLE_CHARS {
        return Ok(tool_err(format!("'title' must be at most {} characters.", MAX_TITLE_CHARS)));
    }
    let source = args["source"]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(MAX_SOURCE_CHARS)
        .collect::<String>();

    let content: String = match (args["content"].as_str(), args["path"].as_str()) {
        (Some(_), Some(_)) => {
            return Ok(tool_err("Give either 'content' or 'path', not both.".into()));
        }
        (Some(content), None) => {
            if content.trim().is_empty() {
                return Ok(tool_err("'content' is empty; nothing to index.".into()));
            }
            if char_count(content) > MAX_INLINE_CONTENT_CHARS {
                return Ok(tool_err(format!(
                    "'content' exceeds the {} character inline limit; write it to a workspace file and pass 'path' instead (limit {} characters).",
                    MAX_INLINE_CONTENT_CHARS, MAX_FILE_CONTENT_CHARS
                )));
            }
            content.to_string()
        }
        (None, Some(rel)) => {
            let path = resolve_path(workspace, rel)?;
            let bytes = std::fs::read_to_string(&path).map_err(|e| NativeAgentError::Tool {
                msg: format!("Failed to read file for indexing: {}", e),
            })?;
            if bytes.trim().is_empty() {
                return Ok(tool_err(format!("File '{}' is empty; nothing to index.", rel)));
            }
            if char_count(&bytes) > MAX_FILE_CONTENT_CHARS {
                return Ok(tool_err(format!(
                    "File '{}' exceeds the {} character indexing limit.",
                    rel, MAX_FILE_CONTENT_CHARS
                )));
            }
            bytes
        }
        (None, None) => {
            return Ok(tool_err("Give 'content' (inline text) or 'path' (workspace file).".into()));
        }
    };

    let content_chars = char_count(&content);
    let doc_id = match args["doc_id"].as_str() {
        Some(raw) => match clean_doc_id(raw) {
            Some(id) => id,
            None => {
                return Ok(tool_err(format!(
                    "'doc_id' may only contain letters, digits, '.', '-' and '_' (max {} characters).",
                    MAX_DOC_ID_CHARS
                )));
            }
        },
        None => {
            let slug_part = slug(&title, 40);
            let hash_part = format!("{:012x}", fnv64(format!("{}\n{}", title, content).as_bytes()) & 0xffff_ffff_ffff);
            if slug_part.is_empty() {
                format!("doc-{}", hash_part)
            } else {
                format!("{}-{}", slug_part, hash_part)
            }
        }
    };

    let chunks = chunk_text(&content);
    if chunks.is_empty() {
        return Ok(tool_err("The document has no indexable text.".into()));
    }

    let conn = open_index(db_path)?;
    let old_chunks: i64 = conn
        .query_row("SELECT chunk_count FROM documents WHERE doc_id = ?1", [&doc_id], |row| row.get(0))
        .unwrap_or(0);
    let (total_docs, total_chunks) = totals(&conn)?;
    let projected = total_chunks - old_chunks + chunks.len() as i64;
    if projected > MAX_TOTAL_CHUNKS {
        return Ok(tool_err(format!(
            "Indexing this document would raise the index to {} chunks (limit {}). Use forget_document to remove old material first; list_documents shows candidates.",
            projected, MAX_TOTAL_CHUNKS
        )));
    }

    conn.execute("BEGIN", []).map_err(sql_err)?;
    let result = (|| -> Result<(), rusqlite::Error> {
        conn.execute("DELETE FROM document_chunks WHERE doc_id = ?1", [&doc_id])?;
        conn.execute("DELETE FROM documents WHERE doc_id = ?1", [&doc_id])?;
        conn.execute(
            "INSERT INTO documents(doc_id, title, source, chunk_count, content_chars, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![doc_id, title, source, chunks.len() as i64, content_chars as i64, now_ms()],
        )?;
        for (seq, chunk) in chunks.iter().enumerate() {
            conn.execute(
                "INSERT INTO document_chunks(body, doc_id, seq) VALUES (?1, ?2, ?3)",
                rusqlite::params![chunk, doc_id, seq as i64],
            )?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute("COMMIT", []).map_err(sql_err)?,
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            return Ok(tool_err(format!("Indexing failed: {}", e)));
        }
    }

    let (total_docs, total_chunks) = totals(&conn)?;
    Ok(serde_json::json!({
        "docId": doc_id,
        "title": title,
        "chunks": chunks.len(),
        "chars": content_chars,
        "replaced": old_chunks > 0,
        "totalDocs": total_docs,
        "totalChunks": total_chunks,
        "message": format!(
            "Indexed '{}' as {} chunks under docId '{}'{}. Search it with search_documents.",
            args["title"].as_str().unwrap_or(""),
            chunks.len(),
            doc_id,
            if old_chunks > 0 { " (replacing the previous version)" } else { "" }
        ),
    }))
}

fn sql_err(e: rusqlite::Error) -> NativeAgentError {
    NativeAgentError::Tool { msg: format!("Document index write failed: {}", e) }
}

pub(crate) fn tool_search_documents(
    args: &serde_json::Value,
    db_path: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let raw_query = args["query"].as_str().unwrap_or("").trim().to_string();
    if raw_query.is_empty() {
        return Ok(tool_err("'query' is required (the words to find).".into()));
    }
    if char_count(&raw_query) > MAX_QUERY_CHARS {
        return Ok(tool_err(format!("'query' must be at most {} characters.", MAX_QUERY_CHARS)));
    }
    let Some(match_expr) = fts_query(&raw_query) else {
        return Ok(tool_err("'query' must contain at least one word.".into()));
    };
    let limit = args["limit"].as_u64().unwrap_or(5).clamp(1, 20);
    let doc_filter = args["doc_id"].as_str().and_then(|raw| clean_doc_id(raw));

    let conn = open_index(db_path)?;
    let (total_docs, total_chunks) = totals(&conn)?;

    // Step 1: the FTS5 pass. The table is queried WITHOUT an alias — FTS5's
    // MATCH constraint and the snippet()/bm25() auxiliary functions name the
    // table itself, and an alias would shadow that name. An UNINDEXED column
    // filter (doc_id) is an ordinary WHERE term, which FTS5 applies as a
    // post-scan filter.
    let (sql, has_filter): (String, bool) = match &doc_filter {
        Some(_) => (
            "SELECT doc_id, seq,
                    snippet(document_chunks, 0, '', '', '…', ?1) AS excerpt,
                    bm25(document_chunks) AS rank
             FROM document_chunks
             WHERE document_chunks MATCH ?2 AND doc_id = ?3
             ORDER BY rank
             LIMIT ?4"
                .to_string(),
            true,
        ),
        None => (
            "SELECT doc_id, seq,
                    snippet(document_chunks, 0, '', '', '…', ?1) AS excerpt,
                    bm25(document_chunks) AS rank
             FROM document_chunks
             WHERE document_chunks MATCH ?2
             ORDER BY rank
             LIMIT ?3"
                .to_string(),
            false,
        ),
    };

    let mut statement = conn
        .prepare(&sql)
        .map_err(|e| NativeAgentError::Tool { msg: format!("Search failed: {}", e) })?;
    let mut rows = if has_filter {
        statement
            .query(rusqlite::params![SNIPPET_TOKENS, match_expr, doc_filter.unwrap_or_default(), limit as i64])
            .map_err(|e| NativeAgentError::Tool { msg: format!("Search failed: {}", e) })?
    } else {
        statement
            .query(rusqlite::params![SNIPPET_TOKENS, match_expr, limit as i64])
            .map_err(|e| NativeAgentError::Tool { msg: format!("Search failed: {}", e) })?
    };

    let mut hits: Vec<(String, i64, String, f64)> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| NativeAgentError::Tool { msg: format!("Search failed: {}", e) })? {
        hits.push((
            row.get(0).unwrap_or_default(),
            row.get(1).unwrap_or(0),
            row.get(2).unwrap_or_default(),
            row.get(3).unwrap_or(0.0),
        ));
    }

    // Step 2: titles/sources for the (at most `limit`) hit documents, so the
    // model can cite what it found. Extra round-trips stay bounded by LIMIT.
    let mut results: Vec<serde_json::Value> = Vec::new();
    for (doc_id, seq, excerpt, rank) in hits {
        let (title, source) = conn
            .query_row(
                "SELECT title, source FROM documents WHERE doc_id = ?1",
                [&doc_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap_or_else(|_| (String::new(), String::new()));
        results.push(serde_json::json!({
            "docId": doc_id,
            "chunk": seq,
            "title": title,
            "source": source,
            "snippet": excerpt,
            // bm25() is "smaller is better"; expose higher-is-better instead.
            "score": (-(rank) * 1000.0).round() / 1000.0,
        }));
    }

    if results.is_empty() {
        return Ok(serde_json::json!({
            "query": raw_query,
            "indexedDocs": total_docs,
            "totalChunks": total_chunks,
            "results": [],
            "message": if total_docs == 0 {
                "No documents are indexed yet. Use index_document first, then search again.".to_string()
            } else {
                "No passage contains all the query words. Try fewer or different words (the index matches words, not meaning).".to_string()
            },
        }));
    }
    Ok(serde_json::json!({
        "query": raw_query,
        "indexedDocs": total_docs,
        "totalChunks": total_chunks,
        "results": results,
    }))
}

pub(crate) fn tool_list_documents(
    args: &serde_json::Value,
    db_path: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 100);
    let prefix = args["prefix"].as_str().unwrap_or("").trim().to_lowercase();

    let conn = open_index(db_path)?;
    let (total_docs, total_chunks) = totals(&conn)?;
    let mut statement = conn
        .prepare("SELECT doc_id, title, source, chunk_count, content_chars, created_at_ms FROM documents ORDER BY created_at_ms DESC")
        .map_err(|e| NativeAgentError::Tool { msg: format!("List failed: {}", e) })?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| NativeAgentError::Tool { msg: format!("List failed: {}", e) })?;

    let mut documents: Vec<serde_json::Value> = Vec::new();
    for row in rows {
        let (doc_id, title, source, chunk_count, content_chars, created_at_ms) =
            row.map_err(|e| NativeAgentError::Tool { msg: format!("List failed: {}", e) })?;
        if !prefix.is_empty() && !doc_id.to_lowercase().starts_with(&prefix) {
            continue;
        }
        documents.push(serde_json::json!({
            "docId": doc_id,
            "title": title,
            "source": source,
            "chunks": chunk_count,
            "chars": content_chars,
            "indexedAtMs": created_at_ms,
        }));
        if documents.len() as u64 >= limit {
            break;
        }
    }
    Ok(serde_json::json!({
        "documents": documents,
        "totalDocs": total_docs,
        "totalChunks": total_chunks,
    }))
}

pub(crate) fn tool_forget_document(
    args: &serde_json::Value,
    db_path: &str,
) -> Result<serde_json::Value, NativeAgentError> {
    let Some(doc_id) = args["doc_id"].as_str().and_then(clean_doc_id) else {
        return Ok(tool_err(format!(
            "'doc_id' is required (letters, digits, '.', '-', '_'; max {} characters). Use list_documents to find ids.",
            MAX_DOC_ID_CHARS
        )));
    };
    let conn = open_index(db_path)?;
    conn.execute("BEGIN", []).map_err(sql_err)?;
    let removed_chunks = conn
        .execute("DELETE FROM document_chunks WHERE doc_id = ?1", [&doc_id])
        .map_err(sql_err)?;
    let removed_doc = conn
        .execute("DELETE FROM documents WHERE doc_id = ?1", [&doc_id])
        .map_err(sql_err)?;
    if removed_doc == 0 {
        let _ = conn.execute("ROLLBACK", []);
        return Ok(tool_err(format!(
            "No indexed document has docId '{}'. Use list_documents to see the ids that exist.",
            doc_id
        )));
    }
    conn.execute("COMMIT", []).map_err(sql_err)?;
    let (total_docs, total_chunks) = totals(&conn)?;
    Ok(serde_json::json!({
        "deleted": doc_id,
        "chunksRemoved": removed_chunks,
        "totalDocs": total_docs,
        "totalChunks": total_chunks,
        "message": format!("Removed '{}' and its {} chunk(s) from the index.", doc_id, removed_chunks),
    }))
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db_path(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!("nativeagent-docindex-{}-{}", label, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("sessions.sqlite3").to_string_lossy().into_owned()
    }

    #[test]
    fn fts_query_quotes_and_caps_terms() {
        assert_eq!(fts_query(r#"tax "notes" 2024"#).as_deref(), Some(r#""tax" "notes" "2024""#));
        assert_eq!(fts_query("   ").as_deref(), None);
        assert_eq!(fts_query("\"\"").as_deref(), None);
        let many: Vec<String> = (0..30).map(|i| format!("w{}", i)).collect();
        assert_eq!(fts_query(&many.join(" ")).unwrap().matches('"').count() / 2, 16);
    }

    #[test]
    fn chunking_respects_boundaries_and_overlap() {
        let text = "প্রথম অনুচ্ছেদ। এটি বাংলা লেখা।\n\nSecond paragraph with a normal amount of text. It has sentences. Each is short.\n\n";
        let chunks = chunk_text(text);
        assert_eq!(chunks.len(), 1, "small text should stay one chunk");
        assert!(chunks[0].contains("প্রথম অনুচ্ছেদ"));
        assert!(chunks[0].contains("Second paragraph"));

        let long: String = "বাক্য। ".repeat(400);
        let chunks = chunk_text(&long);
        assert!(chunks.len() >= 2, "long text must split");
        for chunk in &chunks {
            assert!(char_count(chunk) <= CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS + 2);
        }
        // Overlap carries the tail of the previous chunk.
        let tail = take_tail_chars(&chunks[0], CHUNK_OVERLAP_CHARS);
        assert!(chunks[1].starts_with(&tail), "second chunk should start with the overlap tail");

        let unsplit: String = "x".repeat(5_000);
        let chunks = chunk_text(&unsplit);
        assert!(chunks.len() >= 4, "no-boundary text must hard-split");
        assert!(chunks.len() <= MAX_CHUNKS_PER_DOC);
    }

    #[test]
    fn index_search_replace_forget_roundtrip() {
        let db_path = temp_db_path("roundtrip");
        let index_args = serde_json::json!({
            "title": "Pathao Notes",
            "source": "https://example.com/pathao",
            "content": "Pathao rides operate in Dhaka. Pathao Pay handles payments. Pathao food delivery is popular. The courier arm ships parcels nationwide.",
        });
        let indexed = tool_index_document(&index_args, ".", &db_path).expect("index");
        assert!(indexed.get("error").is_none(), "index must not error: {:?}", indexed);
        assert!(indexed["chunks"].as_i64().unwrap_or(0) >= 1);
        let doc_id = indexed["docId"].as_str().unwrap().to_string();

        let hit = tool_search_documents(&serde_json::json!({ "query": "Pathao courier" }), &db_path).expect("search");
        assert!(hit["results"].as_array().map(|r| !r.is_empty()).unwrap_or(false), "must find the doc: {:?}", hit);
        let first = &hit["results"][0];
        assert_eq!(first["docId"].as_str(), Some(doc_id.as_str()));
        assert!(first["snippet"].as_str().unwrap_or("").contains("courier"));
        assert!(first["title"].as_str().unwrap_or("").contains("Pathao"));

        // Unrelated word must not match.
        let miss = tool_search_documents(&serde_json::json!({ "query": "quantum" }), &db_path).expect("search miss");
        assert!(miss["results"].as_array().unwrap().is_empty());
        assert!(miss["message"].as_str().unwrap_or("").contains("No passage"));

        // Replace with a shorter version: chunk totals must not grow stale.
        let replaced = tool_index_document(
            &serde_json::json!({ "title": "Pathao Notes", "doc_id": doc_id, "content": "Short update." }),
            ".",
            &db_path,
        )
        .expect("reindex");
        assert_eq!(replaced["replaced"].as_bool(), Some(true));
        assert_eq!(replaced["totalDocs"].as_i64(), Some(1), "same doc_id must not duplicate the document row");

        let listed = tool_list_documents(&serde_json::json!({}), &db_path).expect("list");
        assert_eq!(listed["documents"].as_array().unwrap().len(), 1);
        assert_eq!(listed["documents"][0]["docId"].as_str(), Some(doc_id.as_str()));

        // Search scoped to one doc_id.
        tool_index_document(
            &serde_json::json!({ "title": "Other Doc", "content": "courier mention in another doc" }),
            ".",
            &db_path,
        )
        .expect("second doc");
        let scoped = tool_search_documents(
            &serde_json::json!({ "query": "courier", "doc_id": doc_id }),
            &db_path,
        )
        .expect("scoped search");
        for result in scoped["results"].as_array().unwrap() {
            assert_eq!(result["docId"].as_str(), Some(doc_id.as_str()));
        }

        let forgotten = tool_forget_document(&serde_json::json!({ "doc_id": doc_id }), &db_path).expect("forget");
        assert_eq!(forgotten["deleted"].as_str(), Some(doc_id.as_str()));
        let missing = tool_forget_document(&serde_json::json!({ "doc_id": doc_id }), &db_path).expect("forget again");
        assert!(missing.get("error").is_some());
    }

    #[test]
    fn index_rejects_bad_input() {
        let db_path = temp_db_path("validation");
        assert!(tool_index_document(&serde_json::json!({ "content": "x" }), ".", &db_path).unwrap()["error"].is_string());
        assert!(tool_index_document(&serde_json::json!({ "title": "T" }), ".", &db_path).unwrap()["error"].is_string());
        let both = tool_index_document(
            &serde_json::json!({ "title": "T", "content": "x", "path": "y.txt" }),
            ".",
            &db_path,
        )
        .unwrap();
        assert!(both["error"].as_str().unwrap_or("").contains("not both"));
        let bad_id = tool_index_document(
            &serde_json::json!({ "title": "T", "doc_id": "bad id!", "content": "x" }),
            ".",
            &db_path,
        )
        .unwrap();
        assert!(bad_id["error"].is_string());
    }

    #[test]
    fn default_doc_id_is_stable_and_slugged() {
        let db_path = temp_db_path("docid");
        let args = serde_json::json!({ "title": "Travel Guide 2024!", "content": "Sajek valley route details." });
        let first = tool_index_document(&args, ".", &db_path).unwrap();
        let second = tool_index_document(&args, ".", &db_path).unwrap();
        assert_eq!(first["docId"], second["docId"]);
        assert!(first["docId"].as_str().unwrap().starts_with("travel-guide-2024-"));
    }
}
