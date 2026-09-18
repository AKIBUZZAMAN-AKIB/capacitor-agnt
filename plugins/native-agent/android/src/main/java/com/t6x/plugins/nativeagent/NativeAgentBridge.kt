package com.t6x.plugins.nativeagent

import java.util.concurrent.CopyOnWriteArrayList
import uniffi.native_agent_ffi.NativeAgentHandle

/**
 * Listener interface for in-process Kotlin code that wants to observe
 * raw FFI events alongside the WebView listener. Mirrors the shape of
 * uniffi.native_agent_ffi.NativeEventCallback but is registered through
 * NativeAgentBridge instead of the FFI itself, so multiple consumers
 * can subscribe at once.
 */
interface NativeEventListener {
    fun onEvent(eventType: String, payloadJson: String)
}

/**
 * Process-wide accessor that exposes the live NativeAgentHandle and a
 * multi-listener event fan-out to other modules in the same Android
 * process — most notably the STOMP transport service in theshell.
 *
 * The single FFI-side NativeEventCallback registered by NativeAgentPlugin
 * forwards every event into [dispatch] in addition to its existing
 * notifyListeners("nativeAgentEvent", ...) call, so the WebView pipeline
 * is byte-equivalent to before this bridge existed.
 *
 * Listeners are strong-referenced; callers MUST call
 * [removeNativeEventListener] when their lifecycle ends.
 */
object NativeAgentBridge {

    @Volatile
    private var handleRef: NativeAgentHandle? = null

    private val listeners = CopyOnWriteArrayList<NativeEventListener>()

    /**
     * The live FFI handle, or null if NativeAgent has not been
     * initialized yet (or has been destroyed).
     */
    @JvmStatic
    fun handle(): NativeAgentHandle? = handleRef

    @JvmStatic
    fun addNativeEventListener(listener: NativeEventListener) {
        listeners.addIfAbsent(listener)
    }

    @JvmStatic
    fun removeNativeEventListener(listener: NativeEventListener) {
        listeners.remove(listener)
    }

    internal fun setHandle(h: NativeAgentHandle?) {
        handleRef = h
    }

    internal fun dispatch(eventType: String, payloadJson: String) {
        for (l in listeners) {
            try {
                l.onEvent(eventType, payloadJson)
            } catch (t: Throwable) {
                android.util.Log.w(
                    "NativeAgentBridge",
                    "listener threw on $eventType: ${t.message}",
                )
            }
        }
    }
}
