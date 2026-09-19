package com.t6x.plugins.phonebuddy

import android.util.Log
import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.ptr.PointerByReference

/**
 * Direct JNA mapping of the PhoneBuddy C ABI.
 *
 * The signatures below mirror `native/include/phone_buddy.h` **verbatim** — that
 * vendored header (cbindgen output, Apache-2.0) is the contract, and
 * `tests/agent-api.test.ts` fails the build if a function name or a parameter
 * ever drifts away from it. Upstream's own examples use a JNI wrapper plus a C
 * shim compiled by CMake; JNA keeps the app build free of NDK/CMake work while
 * reaching exactly the same symbols.
 *
 * Contract notes that matter (all taken from the header / SDK source):
 *  * every `char *` the library returns must be released with [pb_string_free];
 *  * `err_out` is a `char **` the caller also frees;
 *  * callbacks may fire on an engine worker thread — never touch UI from them;
 *  * `notify_event()` host events (`scheduler_registered`, `notification_send`,
 *    …) are fire-and-forget: they carry a `call_id` but must NOT be answered
 *    with [pb_engine_host_tool_result];
 *  * real host tools (registered via [pb_engine_set_host_tools]) DO need a
 *    result through [pb_engine_host_tool_result].
 */
internal const val PHONE_BUDDY_LIB = "phone_buddy_ffi"

// The five callback types live in their own Java files (Pb*Callback.java):
// Kotlin's SAM conversion does not apply to interfaces declared in Kotlin, so
// `PbEventCallback { ... }` would not compile here. Java declarations also keep
// the "public function exposes its internal parameter type" checks happy without
// widening anything else.

interface PhoneBuddyLib : Library {
    fun pb_version(): Pointer
    fun pb_string_free(ptr: Pointer?)
    fun pb_init_logging(callback: PbLogCallback?, minLevel: Int)

    fun pb_engine_new(configJson: String?, errOut: PointerByReference): Pointer?
    fun pb_engine_free(engine: Pointer?)

    fun pb_engine_chat(
        engine: Pointer?,
        sessionId: String?,
        userInput: String?,
        callback: PbEventCallback?,
        userData: Pointer?,
        errOut: PointerByReference,
    ): Pointer?

    fun pb_engine_chat_v2(
        engine: Pointer?,
        sessionId: String?,
        turnJson: String?,
        callback: PbEventCallback?,
        userData: Pointer?,
        errOut: PointerByReference,
    ): Pointer?

    fun pb_engine_list_sessions(engine: Pointer?, errOut: PointerByReference): Pointer?
    fun pb_engine_get_session(engine: Pointer?, sessionId: String?, errOut: PointerByReference): Pointer?
    fun pb_engine_delete_session(engine: Pointer?, sessionId: String?): Int
    fun pb_engine_cancel(engine: Pointer?, sessionId: String?)

    fun pb_engine_set_host_callbacks(
        engine: Pointer?,
        llmCallback: PbLlmRequestCallback?,
        toolCallback: PbHostToolCallback?,
        userData: Pointer?,
    )

    fun pb_engine_llm_push_chunk(engine: Pointer?, requestId: String?, chunkJson: String?, errOut: PointerByReference): Int
    fun pb_engine_llm_finish(engine: Pointer?, requestId: String?, errOut: PointerByReference): Int
    fun pb_engine_llm_fail(engine: Pointer?, requestId: String?, errorMsg: String?, errOut: PointerByReference): Int

    fun pb_engine_set_host_tools(engine: Pointer?, toolsJson: String?, errOut: PointerByReference): Int
    fun pb_engine_host_tool_result(engine: Pointer?, callId: String?, ok: Int, output: String?, errOut: PointerByReference): Int

    fun pb_engine_set_webview_callback(engine: Pointer?, callback: PbWebViewFetchCallback?, userData: Pointer?)
    fun pb_engine_webview_result(engine: Pointer?, callId: String?, ok: Int, output: String?, errOut: PointerByReference): Int

    fun pb_engine_set_system_prompt_extra(engine: Pointer?, extra: String?)
    fun pb_engine_set_agent_name(engine: Pointer?, name: String?)

    companion object {
        const val TAG = "PhoneBuddyFfi"

        /** Set when the library could not be loaded (unsupported ABI, corrupt slice). */
        @Volatile
        var loadError: String? = null
            private set

        val INSTANCE: PhoneBuddyLib? by lazy {
            try {
                Native.load(
                    PHONE_BUDDY_LIB,
                    PhoneBuddyLib::class.java,
                    mapOf(Library.OPTION_STRING_ENCODING to "UTF-8"),
                ).also { loadError = null }
            } catch (t: Throwable) {
                // UnsatisfiedLinkError is an Error, not an Exception — catching
                // Throwable here is what keeps an unsupported ABI from killing
                // the app (the same crash-safety rule the native-agent plugin
                // needed after the 0.9.x incident).
                loadError = "${t::class.java.simpleName}: ${t.message ?: "unknown"}"
                Log.w(TAG, "lib$PHONE_BUDDY_LIB.so could not be loaded: $loadError")
                null
            }
        }

        val isAvailable: Boolean get() = INSTANCE != null
    }
}

/** Hex-dump-free helper for the `char *` results of the C ABI. */
internal fun PhoneBuddyLib.takeString(pointer: Pointer?): String? =
    pointer?.let {
        try {
            it.getString(0, "UTF-8")
        } finally {
            pb_string_free(it)
        }
    }

/** Reads and frees an `err_out` slot; null when the engine reported success. */
internal fun PhoneBuddyLib.takeError(errOut: PointerByReference): String? =
    takeString(errOut.value)?.takeIf { it.isNotBlank() }

internal object PhoneBuddyFfi {
    /** `pb_version()` — raw, no allocation. */
    fun version(): String? = try {
        PhoneBuddyLib.INSTANCE?.pb_version()?.getString(0, "UTF-8")
    } catch (t: Throwable) {
        null
    }
}
