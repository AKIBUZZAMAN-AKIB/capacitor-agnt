package com.t6x.plugins.nativeagent

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import uniffi.native_agent_ffi.MemoryProvider
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.ln

/**
 * Long-term memory for the agent — built in, file-backed, no vector database.
 *
 * ## Why this exists (and why it is not LanceDB any more)
 *
 * The engine's `memory_store` / `memory_recall` / `memory_search` /
 * `memory_forget` / `memory_list` tools do not store anything themselves: they
 * call a host-side `MemoryProvider` (Rust trait `MemoryProvider`, UniFFI callback
 * interface) and the host owns the storage. The previous implementation lived in
 * `src/main/java-memory`, was compiled only when the app also integrated the
 * third-party `capacitor-lancedb` plugin, and relied on vector embeddings — so on
 * every build that did not ship that plugin (`package.json` never had it) the
 * tools answered `{"error":"Memory provider not configured"}` and the feature was
 * dead weight.
 *
 * This class replaces it with something that is always present:
 *
 *  * **Storage** — one JSON document, `native-agent-memory/memory.json` under the
 *    app's private files dir, written atomically (temp file + rename) and capped
 *    ([MAX_ENTRIES]) so it cannot grow forever. Nothing leaves the device.
 *  * **Search** — a lexical scorer (token overlap with inverse document frequency
 *    weighting, plus a whole-phrase and a key-match bonus), *not* embeddings.
 *    That is an honest trade: it needs no model download, no network, no extra
 *    dependency and no second native runtime, and it matches the way an agent
 *    asks ("what did I note about X?"). It is deliberately not semantic: two
 *    phrasings with no shared word will not match, and the tool output says
 *    "lexical" so the model is not misled about that.
 *
 * ## Contract
 *
 * Every method returns a JSON **string** (never throws across the FFI boundary —
 * UniFFI would turn a thrown exception into a Rust error, and a bad memory write
 * must not fail the model's tool call):
 *   * `store`  → `{"success":true,"key":"…"}`
 *   * `recall` / `search` → `[{"key":…,"text":…,"score":…,"metadata":…}, …]`
 *   * `list`   → `["key", …]`
 *   * `forget` → `{"success":true,"key":"…"}`
 *   * failure  → `{"error":"…"}`
 *
 * The engine reads `recall`/`search` as an array (or `{"results":[…]}`) and uses
 * the `key` field to delete single matches for `memory_forget`.
 */
class MemoryProviderImpl(context: Context) : MemoryProvider {

    private val appContext = context.applicationContext
    private val storeFile = File(File(appContext.filesDir, DIR_NAME), FILE_NAME)
    private val lock = ReentrantLock()

    // ── MemoryProvider ──────────────────────────────────────────────────────

    override fun store(key: String, text: String, metadataJson: String?): String = guard {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return@guard error("Nothing to store: 'text' is empty.")
        if (trimmed.length > MAX_TEXT_LENGTH) {
            return@guard error("Memory entry too large (${trimmed.length} chars, limit $MAX_TEXT_LENGTH).")
        }

        val resolvedKey = key.trim().ifEmpty { "mem-${System.currentTimeMillis()}-${randomSuffix()}" }
        val now = System.currentTimeMillis()
        val metadata = parseMetadata(metadataJson)

        lock.withLock {
            val entries = readDocument().entries
            // JSONArray has no indexOfFirst/find: walk it by index. (`entries[i]`
            // does not exist either — get() returns Any, so use optJSONObject.)
            var existing = -1
            for (index in 0 until entries.length()) {
                if (entries.optJSONObject(index)?.optString("key") == resolvedKey) {
                    existing = index
                    break
                }
            }

            val createdAt = if (existing >= 0) {
                entries.optJSONObject(existing)?.optLong("createdAt", now) ?: now
            } else {
                now
            }
            val record = JSONObject()
                .put("key", resolvedKey)
                .put("text", trimmed)
                .put("createdAt", createdAt)
                .put("updatedAt", now)
            if (metadata != null) record.put("metadata", metadata)

            if (existing >= 0) entries.put(existing, record) else entries.put(record)
            while (entries.length() > MAX_ENTRIES) entries.remove(0) // oldest first
            writeDocument(entries)
        }

        JSONObject().put("success", true).put("key", resolvedKey).toString()
    }

    override fun recall(query: String, limit: UInt): String = search(query, limit)

    override fun search(query: String, maxResults: UInt): String = guard {
        val limit = maxResults.toInt().coerceIn(1, MAX_RESULTS)
        val entries = lock.withLock { readDocument().entries }
        val scored = score(entries, query).take(limit)

        val results = JSONArray()
        for (hit in scored) {
            val item = JSONObject()
                .put("key", hit.record.optString("key"))
                .put("text", hit.record.optString("text"))
                .put("score", hit.score)
            hit.record.optJSONObject("metadata")?.let { item.put("metadata", it) }
            results.put(item)
        }
        results.toString()
    }

    override fun forget(key: String): String = guard {
        val wanted = key.trim()
        if (wanted.isEmpty()) return@guard error("Provide a key to forget.")

        val removed = lock.withLock {
            val entries = readDocument().entries
            val kept = JSONArray()
            var found = false
            for (index in 0 until entries.length()) {
                val record = entries.optJSONObject(index) ?: continue
                if (record.optString("key") == wanted) found = true else kept.put(record)
            }
            if (found) writeDocument(kept)
            found
        }

        if (removed) {
            JSONObject().put("success", true).put("key", wanted).toString()
        } else {
            error("No memory stored under key '$wanted'.")
        }
    }

    override fun list(prefix: String?, limit: UInt?): String = guard {
        val wantedPrefix = prefix?.trim().orEmpty()
        val cap = (limit?.toInt() ?: MAX_RESULTS).coerceIn(1, MAX_RESULTS)

        val keys = JSONArray()
        val entries = lock.withLock {
            readDocument().entries.let { array ->
                // newest first, like every other listing this plugin returns
                (0 until array.length()).mapNotNull { array.optJSONObject(it) }.sortedByDescending { it.optLong("updatedAt") }
            }
        }
        for (record in entries) {
            val candidate = record.optString("key")
            if (wantedPrefix.isEmpty() || candidate.startsWith(wantedPrefix)) {
                if (keys.length() >= cap) break
                keys.put(candidate)
            }
        }
        keys.toString()
    }

    // ── scoring (lexical, deterministic, no embeddings) ──────────────────────

    private data class Hit(val record: JSONObject, val score: Double)

    private class Document(val root: JSONObject) {
        val entries: JSONArray = root.optJSONArray("entries") ?: JSONArray()
    }

    private fun score(entries: JSONArray, query: String): List<Hit> {
        val queryTokens = tokenize(query)
        val phrase = query.trim().lowercase()
        if (queryTokens.isEmpty() && phrase.length < MIN_PHRASE_LENGTH) return emptyList()

        // document frequency per token: log(1 + N/df) is what makes a shared rare
        // word count for more than a shared common one
        val records = (0 until entries.length()).mapNotNull { entries.optJSONObject(it) }
        val total = records.size
        if (total == 0) return emptyList()

        val documentFrequency = HashMap<String, Int>()
        val tokenCache = HashMap<String, List<String>>()
        for (record in records) {
            val key = record.optString("key")
            val tokens = tokenize("${record.optString("text")} $key")
            tokenCache[key] = tokens
            for (token in tokens.toSet()) documentFrequency[token] = (documentFrequency[token] ?: 0) + 1
        }

        val hits = ArrayList<Hit>()
        for (record in records) {
            val key = record.optString("key")
            val text = record.optString("text")
            val tokens = tokenCache[key] ?: emptyList()
            if (tokens.isEmpty()) continue

            var score = 0.0
            for (token in queryTokens) {
                val occurrences = tokens.count { it == token }
                if (occurrences == 0) continue
                val df = documentFrequency[token] ?: 1
                val inverseFrequency = ln(1.0 + total.toDouble() / df)
                // term frequency saturates: 3 hits are not 3x as relevant as 1
                val termFrequency = occurrences.toDouble() / (occurrences + 0.5)
                score += inverseFrequency * (1.0 + termFrequency)
            }

            // an exact phrase hit or a key hit is a strong signal even when the
            // individual words are common
            val haystack = text.lowercase()
            if (phrase.length >= MIN_PHRASE_LENGTH && haystack.contains(phrase)) score += PHRASE_BONUS
            for (token in queryTokens) if (key.lowercase().contains(token)) score += KEY_BONUS

            for (token in queryTokens) {
                if (token.length >= MIN_PARTIAL_LENGTH && tokens.any { it.contains(token) }) score += PARTIAL_BONUS
            }

            if (score > 0.0) hits.add(Hit(record, round(score)))
        }

        return hits.sortedWith(compareByDescending<Hit> { it.score }.thenByDescending { it.record.optLong("updatedAt") })
    }

    /** Lowercase word/number runs of at least two characters. */
    private fun tokenize(text: String): List<String> {
        val tokens = ArrayList<String>()
        val current = StringBuilder()
        fun flush() {
            if (current.length >= MIN_TOKEN_LENGTH) tokens.add(current.toString())
            current.setLength(0)
        }
        for (character in text.lowercase()) {
            if (character.isLetterOrDigit()) current.append(character) else flush()
        }
        flush()
        return tokens
    }

    private fun round(value: Double): Double = Math.round(value * 10_000.0) / 10_000.0

    // ── storage ─────────────────────────────────────────────────────────────

    private fun readDocument(): Document {
        if (!storeFile.isFile) return Document(JSONObject().put("version", FORMAT_VERSION))
        return try {
            val parsed = JSONObject(storeFile.readText())
            parsed.put("version", FORMAT_VERSION)
            Document(parsed)
        } catch (t: Throwable) {
            // A corrupt file must not break every future tool call: keep it for
            // the user to inspect and start clean.
            val corrupt = File(storeFile.parentFile, "${storeFile.name}.corrupt-${System.currentTimeMillis()}")
            runCatching { storeFile.renameTo(corrupt) }
            Document(JSONObject().put("version", FORMAT_VERSION))
        }
    }

    private fun writeDocument(entries: JSONArray) {
        storeFile.parentFile?.mkdirs()
        val root = JSONObject().put("version", FORMAT_VERSION).put("entries", entries)
        val temporary = File(storeFile.parentFile, "${storeFile.name}.tmp")
        temporary.writeText(root.toString())
        if (!temporary.renameTo(storeFile)) {
            storeFile.writeText(root.toString())
            temporary.delete()
        }
    }

    private fun parseMetadata(metadataJson: String?): JSONObject? {
        val raw = metadataJson?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return runCatching { JSONObject(raw) }.getOrNull()
    }

    private fun randomSuffix(): String = java.util.UUID.randomUUID().toString().take(8)

    /** Never throw across the FFI boundary; report failure as data. */
    private inline fun guard(block: () -> String): String = try {
        block()
    } catch (t: Throwable) {
        error("memory store failed: ${t.message ?: t::class.java.simpleName}")
    }

    private fun error(message: String): String = JSONObject().put("error", message).toString()

    private companion object {
        const val DIR_NAME = "native-agent-memory"
        const val FILE_NAME = "memory.json"
        const val FORMAT_VERSION = 1
        const val MAX_ENTRIES = 2_000
        const val MAX_TEXT_LENGTH = 20_000
        const val MAX_RESULTS = 200
        const val MIN_TOKEN_LENGTH = 2
        const val MIN_PHRASE_LENGTH = 3
        const val MIN_PARTIAL_LENGTH = 4
        const val PHRASE_BONUS = 2.0
        const val KEY_BONUS = 0.75
        const val PARTIAL_BONUS = 0.25
    }
}
