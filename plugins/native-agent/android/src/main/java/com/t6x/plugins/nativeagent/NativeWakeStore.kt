package com.t6x.plugins.nativeagent

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * Durable store for everything a background wake produces, plus its telemetry.
 *
 * ## Why the plugin owns this
 *
 * The engine (0.5.2-public) can *run* a wake — `handle_wake()` evaluates due
 * cron jobs, runs them through the agent loop, notifies the host through
 * `NativeNotifier` and writes one `cron_runs` row per job (tagged with the
 * `wake_source` the caller passed). What it cannot do is wake itself: iOS and
 * Android both require the *app* to ask the OS for background runtime. So this
 * plugin owns the OS half, and this file owns the record of what that OS half
 * produced while the UI was closed.
 *
 * ## Storage
 *
 *  * `surfaced.json` — an append-only JSON array under
 *    `<filesDir>/native-agent-wakes/`, capped at [MAX_RECORDS] newest entries,
 *    holding the same record shape the previous generation's
 *    `loadSurfacedMessages()` returned (`id`/`at`/`source`/`read` + optional
 *    `title`/`body`/`text`), extended with the engine fields that make a wake
 *    auditable (`jobId`, `runId`, `status`, `delivered`).
 *  * SharedPreferences (`native_agent_wakes`) — the wake interval the OS was
 *    actually given, whether it requires charging, and the last wake's
 *    timestamp/source/summary/outcome, which is what `getWakeStatus()` reports.
 *
 * It is written from three places that can run concurrently (the foreground
 * plugin, the WorkManager worker, and the notifier callback inside a wake), so
 * every mutation is serialised through [lock].
 */
internal class NativeWakeStore(private val context: Context) {

    companion object {
        /**
         * Capacitor Preferences file the plugin's `initialize()` writes the
         * engine config path into. A background worker has no WebView and no
         * in-memory handle, so this path is the only way back to the engine.
         */
        const val CAPACITOR_STORAGE_FILE = "CapacitorStorage"
        const val CONFIG_PATH_KEY = "mobilecron:native-agent-config-path"

        /** Directory (under the app's private files dir) that holds [SURFACED_FILE]. */
        const val DIR_NAME = "native-agent-wakes"
        const val SURFACED_FILE = "surfaced.json"
        const val MAX_RECORDS = 500

        /**
         * WorkManager's floor for periodic work
         * (`PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS` = 15 min). Asking
         * for less is not a silent no-op: the granted interval is reported back.
         */
        const val MIN_INTERVAL_MINUTES = 15
        const val DEFAULT_INTERVAL_MINUTES = 30

        private const val PREFS = "native_agent_wakes"
        private const val KEY_INTERVAL = "wake_interval_minutes"
        private const val KEY_REQUIRES_CHARGING = "wake_requires_charging"
        private const val KEY_LAST_AT = "last_wake_at"
        private const val KEY_LAST_SOURCE = "last_wake_source"
        private const val KEY_LAST_SUMMARY = "last_wake_summary"
        private const val KEY_LAST_RAN = "last_wake_ran"
        private const val KEY_LAST_OK = "last_wake_ok"

        private const val ISO_PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"

        private val lock = Any()

        /** ISO-8601 with millisecond precision and an explicit offset. */
        fun iso(ms: Long): String = SimpleDateFormat(ISO_PATTERN, Locale.US).format(Date(ms))
    }

    /** One page of surfaced messages. */
    data class Page(val messagesJson: String, val count: Int, val unread: Int)

    private fun prefs(): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun dir(): File = File(context.filesDir, DIR_NAME).apply { mkdirs() }

    private fun file(): File = File(dir(), SURFACED_FILE)

    // ── Engine config discovery (works with no WebView alive) ────────────────

    /**
     * Absolute path of the engine config `initialize()` persisted, or null when
     * the app never initialised the agent (then a wake has nothing to restore).
     */
    fun engineConfigPath(): String? = context
        .getSharedPreferences(CAPACITOR_STORAGE_FILE, Context.MODE_PRIVATE)
        .getString(CONFIG_PATH_KEY, null)
        ?.takeIf { it.isNotBlank() }
        ?.takeIf { File(it).isFile }

    // ── Surfaced messages ───────────────────────────────────────────────────

    /** Appends one record; returns the stored JSON object. */
    fun append(
        source: String,
        title: String? = null,
        body: String? = null,
        text: String? = null,
        jobId: String? = null,
        runId: Long? = null,
        status: String? = null,
        delivered: Boolean? = null,
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
        if (!jobId.isNullOrBlank()) {
            record.put("jobId", jobId)
            // `taskId` is the name the previous generation's contract used for
            // the same value; keeping it means old readers keep working.
            record.put("taskId", jobId)
        }
        runId?.let { record.put("runId", it) }
        if (!status.isNullOrBlank()) record.put("status", status)
        delivered?.let { record.put("delivered", it) }

        val all = readAll().toMutableList()
        all.add(record)
        while (all.size > MAX_RECORDS) all.removeAt(0)
        writeAll(all)
        record
    }

    /** Newest-first page plus the unread count. Optionally marks the page read. */
    fun load(limit: Int, markRead: Boolean): Page = synchronized(lock) {
        val all = readAll()
        val page = all.takeLast(limit.coerceAtLeast(1)).reversed()
        if (markRead && page.isNotEmpty()) {
            val ids = HashSet<String>()
            for (record in page) {
                val id = record.optString("id", "")
                if (id.isNotEmpty()) ids.add(id)
            }
            val updated = ArrayList<JSONObject>(all.size)
            for (record in all) {
                if (ids.contains(record.optString("id", ""))) {
                    updated.add(JSONObject(record.toString()).put("read", true))
                } else {
                    updated.add(record)
                }
            }
            writeAll(updated)
        }
        val unread = readAll().count { !it.optBoolean("read", false) }
        Page(JSONArray(page).toString(), page.size, unread)
    }

    /** Empties the queue; returns how many records were dropped. */
    fun clear(): Int = synchronized(lock) {
        val count = readAll().size
        writeAll(emptyList())
        count
    }

    fun unreadCount(): Int = synchronized(lock) { readAll().count { !it.optBoolean("read", false) } }

    private fun readAll(): List<JSONObject> {
        val f = file()
        if (!f.isFile) return emptyList()
        return try {
            val array = JSONArray(f.readText())
            val items = ArrayList<JSONObject>(array.length())
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                items.add(item)
            }
            items
        } catch (t: Throwable) {
            // A truncated or hand-edited file must never break a wake.
            emptyList()
        }
    }

    private fun writeAll(records: List<JSONObject>) {
        val f = file()
        f.parentFile?.mkdirs()
        f.writeText(JSONArray(records).toString())
    }

    // ── Wake telemetry (what getWakeStatus reports) ──────────────────────────

    var intervalMinutes: Int
        get() = prefs().getInt(KEY_INTERVAL, DEFAULT_INTERVAL_MINUTES)
        set(value) = prefs().edit().putInt(KEY_INTERVAL, value).apply()

    var requiresCharging: Boolean
        get() = prefs().getBoolean(KEY_REQUIRES_CHARGING, false)
        set(value) = prefs().edit().putBoolean(KEY_REQUIRES_CHARGING, value).apply()

    /**
     * `ok` answers one question: *did the wake run* (engine restored, `handle_wake`
     * returned). It is not "did every cron job succeed" — a job that failed is in
     * [summary] and in the surfaced records, so a wake that ran and reported a
     * failure stays `ok = true` and the failure is still visible.
     */
    fun recordWake(source: String, summary: String, ran: Int, ok: Boolean) {
        prefs().edit()
            .putString(KEY_LAST_AT, iso(System.currentTimeMillis()))
            .putString(KEY_LAST_SOURCE, source)
            .putString(KEY_LAST_SUMMARY, summary)
            .putInt(KEY_LAST_RAN, ran)
            .putBoolean(KEY_LAST_OK, ok)
            .apply()
    }

    val lastWakeAt: String? get() = prefs().getString(KEY_LAST_AT, null)
    val lastWakeSource: String? get() = prefs().getString(KEY_LAST_SOURCE, null)
    val lastWakeSummary: String? get() = prefs().getString(KEY_LAST_SUMMARY, null)
    val lastWakeRan: Int get() = prefs().getInt(KEY_LAST_RAN, 0)
    val lastWakeOk: Boolean get() = prefs().getBoolean(KEY_LAST_OK, false)
}
