package com.t6x.plugins.nativeagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import org.json.JSONObject
import uniffi.native_agent_ffi.NativeNotifier
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicInteger

class NativeNotifierImpl(
    private val appContext: Context
) : NativeNotifier {
    override fun sendNotification(title: String, body: String, dataJson: String): String {
        val channelId = CHANNEL_ID
        ensureChannel(channelId)

        val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Fast, synchronous permission probe (areNotificationsEnabled has
        // existed since API 16 and still works on 33+ where POST_NOTIFICATIONS
        // applies) so we return a proper error JSON instead of a fake success.
        @Suppress("DEPRECATION")
        if (!manager.areNotificationsEnabled()) {
            return JSONObject().put("error", "notification_permission_denied").toString()
        }

        val icon = appContext.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(appContext, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(appContext)
        }

        val notification = builder
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setSmallIcon(icon)
            .setAutoCancel(true)
            .build()

        return try {
            // AtomicInteger instead of System.currentTimeMillis(): two cron
            // notifications in the same millisecond previously collided and
            // silently replaced each other.
            val notificationId = nextNotificationId.getAndIncrement()
            manager.notify(notificationId, notification)
            JSONObject()
                .put("notificationId", notificationId)
                .put("dataJson", dataJson)
                .toString()
        } catch (e: SecurityException) {
            JSONObject().put("error", e.message ?: "notification_permission_denied").toString()
        }
    }

    private fun ensureChannel(channelId: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            channelId,
            "Native Agent Jobs",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Background cron notifications from Native Agent"
        }
        manager.createNotificationChannel(channel)
    }

    private companion object {
        private const val CHANNEL_ID = "native-agent-cron"
        // Random per-process base so ids never collide across app launches
        // (the notification framework is per-process, but this keeps logs sane).
        private val nextNotificationId = AtomicInteger(
            ThreadLocalRandom.current().nextInt(1_000, 2_000_000_000)
        )
    }
}
