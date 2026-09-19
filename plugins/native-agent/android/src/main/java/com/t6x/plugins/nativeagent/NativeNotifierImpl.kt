package com.t6x.plugins.nativeagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import org.json.JSONObject
import uniffi.native_agent_ffi.NativeNotifier

class NativeNotifierImpl(
    private val appContext: Context
) : NativeNotifier {
    override fun sendNotification(title: String, body: String, dataJson: String): String {
        val channelId = CHANNEL_ID
        ensureChannel(channelId)

        val notificationId = ((System.currentTimeMillis() and 0x7fffffff) % Int.MAX_VALUE).toInt()
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
            val manager = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
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
    }
}
