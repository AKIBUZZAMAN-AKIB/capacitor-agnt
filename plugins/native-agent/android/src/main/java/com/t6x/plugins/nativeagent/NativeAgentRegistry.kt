package com.t6x.plugins.nativeagent

import android.content.Context
import android.util.Log
import org.json.JSONObject
import uniffi.native_agent_ffi.InitConfig
import uniffi.native_agent_ffi.NativeAgentHandle
import uniffi.native_agent_ffi.NativeEventCallback
import java.lang.ref.WeakReference

/**
 * Process-wide owner of the single [NativeAgentHandle].
 *
 * A Capacitor app can host several bridge/activity instances, and each one
 * instantiates its own [NativeAgentPlugin]. The native handle is expensive
 * (SQLite store, scheduler, auth profiles, event pump) and MUST be unique per
 * process — opening a second handle on the same database would duplicate the
 * scheduler, double-fire notifications and race on the SQLite file.
 *
 * All plugin instances therefore share this registry. The previous handle is
 * explicitly closed (via the UniFFI cleaner) when a new one replaces it, and
 * the event sink is held weakly so a destroyed webview is never pinned by the
 * Rust callback for the rest of the process lifetime.
 */
object NativeAgentRegistry {

    private const val TAG = "NativeAgentRegistry"
    private const val PREFS = "CapacitorStorage"
    private const val CONFIG_KEY = "mobilecron:native-agent-config"
    /** Legacy key (workspace parent config path) kept for theshell compatibility. */
    private const val CONFIG_PATH_KEY = "mobilecron:native-agent-config-path"

    private val lock = Any()

    @Volatile
    private var handle: NativeAgentHandle? = null

    /** Weak on purpose: the FFI callback must not keep a dead webview alive. */
    @Volatile
    private var eventSinkRef: WeakReference<NativeEventListener>? = null

    @JvmStatic
    fun get(): NativeAgentHandle? = handle

    @JvmStatic
    fun isInitialized(): Boolean = handle != null

    /**
     * Creates (or replaces) the process-wide handle. Any previous handle is
     * closed first. [eventSink] receives raw FFI events until it is
     * replaced by another initialize() call or garbage collected.
     *
     * @throws Throwable including [java.lang.UnsatisfiedLinkError] when the
     *   native library is missing for the device ABI — callers (the plugin)
     *   must catch [Throwable], not just [Exception], and turn this into a
     *   clean JS reject instead of a native crash.
     */
    @JvmStatic
    fun initialize(
        context: Context,
        config: InitConfig,
        eventSink: NativeEventListener,
    ): NativeAgentHandle = synchronized(lock) {
        val appContext = context.applicationContext
        eventSinkRef = WeakReference(eventSink)
        handle?.let { old ->
            try {
                old.close()
            } catch (t: Throwable) {
                Log.w(TAG, "error closing previous handle: ${t.message}")
            }
        }

        val h = NativeAgentHandle(config)
        h.setEventCallback(object : NativeEventCallback {
            override fun onEvent(eventType: String, payloadJson: String) {
                eventSinkRef?.get()?.onEvent(eventType, payloadJson)
                NativeAgentBridge.dispatch(eventType, payloadJson)
            }
        })
        h.setNotifier(NativeNotifierImpl(appContext))
        // Memory provider (LanceDB) is an OPTIONAL feature: its Kotlin class is
        // only compiled into the plugin when the host also integrates
        // capacitor-lancedb, hence the reflective lookup.
        runCatching {
            createMemoryProvider(appContext)?.let { h.setMemoryProvider(it) }
        }.onFailure { Log.w(TAG, "memory provider unavailable: ${it.message}") }
        h.persistConfig()

        handle = h
        NativeAgentBridge.setHandle(h)
        persistConfig(appContext, config)
        h
    }

    /**
     * Background entry point (JobService / other processes of the app):
     * reuse the live handle, or restore one from the config saved by
     * initialize(). Returns null when nothing is usable (not initialized
     * yet, or the saved config is unreadable).
     */
    @JvmStatic
    fun ensureFromSavedConfig(context: Context): NativeAgentHandle? {
        handle?.let { return it }
        val appContext = context.applicationContext
        val json = appContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(CONFIG_KEY, null)
            ?: return null
        return try {
            val o = JSONObject(json)
            val cfg = InitConfig(
                dbPath = o.getString("dbPath"),
                workspacePath = o.getString("workspacePath"),
                authProfilesPath = o.getString("authProfilesPath"),
                defaultProvider = o.optString("defaultProvider", "").takeIf { it.isNotEmpty() },
                defaultModel = o.optString("defaultModel", "").takeIf { it.isNotEmpty() },
            )
            val bgSink = object : NativeEventListener {
                override fun onEvent(eventType: String, payloadJson: String) {
                    // No webview in a background process; in-process listeners
                    // (NativeAgentBridge) still receive the events.
                }
            }
            initialize(appContext, cfg, bgSink)
        } catch (t: Throwable) {
            Log.w(TAG, "could not restore handle from saved config: ${t.message}")
            null
        }
    }

    /** Explicitly releases the process-wide handle. */
    @JvmStatic
    fun shutdown() {
        synchronized(lock) {
            handle?.let {
                try {
                    it.close()
                } catch (t: Throwable) {
                    Log.w(TAG, "error closing handle on shutdown: ${t.message}")
                }
            }
            handle = null
            NativeAgentBridge.setHandle(null)
        }
    }

    // ── internals ─────────────────────────────────────────────────────────

    private fun persistConfig(context: Context, config: InitConfig) {
        val o = JSONObject()
            .put("dbPath", config.dbPath)
            .put("workspacePath", config.workspacePath)
            .put("authProfilesPath", config.authProfilesPath)
            .put("defaultProvider", config.defaultProvider ?: JSONObject.NULL)
            .put("defaultModel", config.defaultModel ?: JSONObject.NULL)
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        editor.putString(CONFIG_KEY, o.toString())
        // Legacy key: path of the engine's own persisted config file.
        val workspace = java.io.File(config.workspacePath)
        val parent = workspace.parentFile ?: workspace
        editor.putString(CONFIG_PATH_KEY, java.io.File(parent, ".native-agent-config.json").absolutePath)
        editor.apply()
    }

    /**
     * Reflective creation of the optional LanceDB-backed memory provider.
     * The MemoryProviderImpl class only exists in the compiled plugin when
     * the host app also integrates capacitor-lancedb (see build.gradle
     * source-set gating), so there is no compile-time reference here.
     */
    private fun createMemoryProvider(context: Context): uniffi.native_agent_ffi.MemoryProvider? {
        val clazz = Class.forName("com.t6x.plugins.nativeagent.MemoryProviderImpl")
        val instance = clazz.getConstructor(Context::class.java).newInstance(context)
        val available = clazz.getMethod("isAvailable").invoke(instance) as Boolean
        return if (available) instance as uniffi.native_agent_ffi.MemoryProvider else null
    }
}
