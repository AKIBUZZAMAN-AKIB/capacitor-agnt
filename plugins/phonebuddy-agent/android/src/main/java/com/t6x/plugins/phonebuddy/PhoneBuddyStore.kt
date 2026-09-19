package com.t6x.plugins.phonebuddy

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.io.File

private const val STORE_PREFS = "phonebuddy_agent"
private const val KEY_ENGINE_CONFIG = "engine_config_json"
private const val KEY_ROOT_DIR = "root_dir"
private const val KEY_INTERVAL = "wake_interval_minutes"
private const val KEY_JOB_ARMED = "wake_job_armed"
private const val KEY_HOST_TOOLS = "host_tools_json"

/**
 * Small persistence layer shared by the plugin and the wake [JobService].
 *
 * The engine handle itself cannot cross process boundaries or survive the app
 * being killed, so the wake job stores everything needed to rebuild it
 * headlessly: the exact `EngineConfig` JSON the host initialised with (including
 * the API key), the sandbox root, and the host-tool schemas the app registered.
 * That is the same restore contract the removed 0.9.x `NativeAgentRegistry` had.
 */
internal class PhoneBuddyStore(private val context: Context) {

    companion object {
        const val DEFAULT_INTERVAL_MINUTES = 30
        /** Android's JobScheduler floor for periodic jobs. */
        const val MIN_INTERVAL_MINUTES = 15
    }

    private fun prefs(): SharedPreferences =
        context.getSharedPreferences(STORE_PREFS, Context.MODE_PRIVATE)

    fun saveEngineConfig(configJson: String, rootDir: File) {
        prefs().edit()
            .putString(KEY_ENGINE_CONFIG, configJson)
            .putString(KEY_ROOT_DIR, rootDir.absolutePath)
            .apply()
    }

    fun engineConfig(): String? = prefs().getString(KEY_ENGINE_CONFIG, null)

    fun rootDir(): File? = prefs().getString(KEY_ROOT_DIR, null)?.let(::File)

    /** Root for the wake job: falls back to the app sandbox when never initialised. */
    fun rootDirOrDefault(): File = rootDir() ?: defaultRootDir()

    fun defaultRootDir(): File = File(context.filesDir, "phonebuddy")

    fun saveHostTools(toolsJson: String) {
        prefs().edit().putString(KEY_HOST_TOOLS, toolsJson).apply()
    }

    fun hostTools(): String? = prefs().getString(KEY_HOST_TOOLS, null)

    fun saveWakeJob(armed: Boolean, intervalMinutes: Int) {
        prefs().edit()
            .putBoolean(KEY_JOB_ARMED, armed)
            .putInt(KEY_INTERVAL, intervalMinutes)
            .apply()
    }

    fun wakeJobArmed(): Boolean = prefs().getBoolean(KEY_JOB_ARMED, false)
    fun wakeIntervalMinutes(): Int = prefs().getInt(KEY_INTERVAL, DEFAULT_INTERVAL_MINUTES)

    fun clear() {
        prefs().edit()
            .remove(KEY_ENGINE_CONFIG)
            .remove(KEY_ROOT_DIR)
            .remove(KEY_HOST_TOOLS)
            .remove(KEY_JOB_ARMED)
            .remove(KEY_INTERVAL)
            .apply()
    }

    // NOTE: host tools are NOT smuggled into the engine config JSON — the wake
    // runner registers them explicitly with pb_engine_set_host_tools() right
    // after the engine is rebuilt, which is the documented way (EngineConfig has
    // no host-tool field; unknown keys would be silently ignored anyway).
}
