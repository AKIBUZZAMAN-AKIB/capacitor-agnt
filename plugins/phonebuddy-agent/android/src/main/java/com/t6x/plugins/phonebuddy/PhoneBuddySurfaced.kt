package com.t6x.plugins.phonebuddy

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

private const val PREFS_NAME = "phonebuddy_agent"
private const val KEY_LAST_WAKE_AT = "last_wake_at"
private const val KEY_LAST_WAKE_SOURCE = "last_wake_source"
private const val KEY_LAST_WAKE_SUMMARY = "last_wake_summary"

/**
 * Durable "surfaced messages" store.
 *
 * Semantics (identical to the 0.9.x `loadSurfacedMessages()` this feature
 * restores): everything the agent produced **while the user was not looking** —
 * a background wake finishing a scheduled task, a notification the engine asked
 * the host to show, a monitor event, or a chat turn that completed after the app
 * went to the background — is appended here, and the UI reads it on next launch
 * via `{ messagesJson, count, unread }`.
 *
 * Storage: `surfaced.json` inside the engine sandbox root, capped at
 * [MAX_RECORDS] newest entries (oldest are dropped, so a device that keeps
 * running for months can never grow the file without bound). It is written from
 * both the plugin (foreground) and the wake `JobService` (background), so every
 * mutation is serialised through a process-wide lock.
 */
internal class PhoneBuddySurfaced(private val context: Context, private val rootDir: File) {

    companion object {
        const val FILE_NAME = "surfaced.json"
        const val MAX_RECORDS = 500
        private val lock = Any()
        private val isoFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"

        private fun iso(ms: Long): String =
            SimpleDateFormat(isoFormat, Locale.US).format(Date(ms))
    }

    private fun file(): File {
        rootDir.mkdirs()
        return File(rootDir, FILE_NAME)
    }

    private fun prefs(): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Appends one record; returns the stored JSON object. */
    fun append(
        source: String,
        title: String? = null,
        body: String? = null,
        text: String? = null,
        sessionId: String? = null,
        taskId: String? = null,
        at: Long = System.currentTimeMillis(),
    ): JSONObject = synchronized(lock) {
        val record = JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("at", iso(at))
            .put("source", source)
            .put("read", false)
        if (!title.isNullOrBlank()) record.put("title", title)
        if (!body.isNullOrBlank()) record.put("body", body)
        if (!text.isNullOrBlank()) record.put("text", text)
        if (!sessionId.isNullOrBlank()) record.put("sessionId", sessionId)
        if (!taskId.isNullOrBlank()) record.put("taskId", taskId)

        val all = readAll().toMutableList()
        all.add(record)
        while (all.size > MAX_RECORDS) all.removeAt(0)
        writeAll(all)
        record
    }

    /** Newest-first page plus the unread count. Optionally marks the page read. */
    fun load(limit: Int, markRead: Boolean): Json {
        val page: List<JSONObject>
        synchronized(lock) {
            val all = readAll()
            page = all.takeLast(limit.coerceAtLeast(1)).reversed()
            if (markRead && page.isNotEmpty()) {
                val ids = page.mapNotNull { it.optString("id").takeIf(String::isNotEmpty) }.toSet()
                writeAll(all.map { if (it.optString("id") in ids) it.put("read", true) else it })
            }
        }
        val unread = synchronized(lock) { readAll().count { !it.optBoolean("read", false) } }
        return Json(JSONArray(page).toString(), page.size, unread)
    }

    fun clear(): Int = synchronized(lock) {
        val count = readAll().size
        writeAll(emptyList())
        count
    }

    fun unreadCount(): Int = synchronized(lock) { readAll().count { !it.optBoolean("read", false) } }

    /** Result of a paged read. */
    data class Json(val messagesJson: String, val count: Int, val unread: Int)

    private fun readAll(): List<JSONObject> {
        val f = file()
        if (!f.isFile) return emptyList()
        return try {
            val array = JSONArray(f.readText())
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }
        } catch (t: Throwable) {
            // A truncated/absent file must never break the agent.
            emptyList()
        }
    }

    private fun writeAll(records: List<JSONObject>) {
        val f = file()
        f.parentFile?.mkdirs()
        f.writeText(JSONArray(records).toString())
    }

    // ── wake telemetry (read by getWakeStatus) ───────────────────────────────

    fun recordWake(source: String, summary: String) {
        prefs().edit()
            .putString(KEY_LAST_WAKE_AT, iso(System.currentTimeMillis()))
            .putString(KEY_LAST_WAKE_SOURCE, source)
            .putString(KEY_LAST_WAKE_SUMMARY, summary)
            .apply()
    }

    fun lastWakeAt(): String? = prefs().getString(KEY_LAST_WAKE_AT, null)
    fun lastWakeSource(): String? = prefs().getString(KEY_LAST_WAKE_SOURCE, null)
    fun lastWakeSummary(): String? = prefs().getString(KEY_LAST_WAKE_SUMMARY, null)
}
