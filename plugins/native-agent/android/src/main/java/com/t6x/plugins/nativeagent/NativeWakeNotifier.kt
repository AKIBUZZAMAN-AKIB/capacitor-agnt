package com.t6x.plugins.nativeagent

import android.content.Context
import org.json.JSONObject
import uniffi.native_agent_ffi.NativeNotifier

/**
 * Notifier used while a wake is running: it posts the OS notification (through
 * [NativeNotifierImpl], the same implementation the foreground uses) **and**
 * records what was posted as a surfaced message.
 *
 * That second half matters because the engine has no notion of an inbox: its
 * `send_job_notification()` hands title/body to the host and the host decides
 * what survives. On a phone, a notification the user swipes away would otherwise
 * leave no trace of what the cron job produced, and `loadSurfacedMessages()`
 * would be empty exactly when it is most useful.
 *
 * The engine expects a JSON string back (it stores it as the notification id
 * that later shows up in the `cron.notification` event), so the delegate's answer
 * is returned unchanged; a failure to persist the record never fails the
 * notification.
 */
internal class NativeWakeNotifier(
    private val context: Context,
    private val store: NativeWakeStore,
    private val delegate: NativeNotifier = NativeNotifierImpl(context.applicationContext),
) : NativeNotifier {

    override fun sendNotification(title: String, body: String, dataJson: String): String {
        val result = try {
            delegate.sendNotification(title, body, dataJson)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            JSONObject().put("error", t.message ?: t::class.java.simpleName).toString()
        }

        try {
            val data = try {
                JSONObject(dataJson)
            } catch (t: Throwable) {
                JSONObject()
            }
            store.append(
                source = "notification",
                title = title,
                body = body,
                jobId = data.optString("jobId", "").takeIf { it.isNotEmpty() },
                status = data.optString("deliveryMode", "").takeIf { it.isNotEmpty() },
            )
        } catch (t: Throwable) {
            // Recording is best-effort: the notification itself already went out.
        }
        return result
    }
}
