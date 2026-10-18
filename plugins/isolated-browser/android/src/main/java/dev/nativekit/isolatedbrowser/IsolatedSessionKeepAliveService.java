package dev.nativekit.isolatedbrowser;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Foreground service in the HOST process, active only while an isolated
 * mini-app / remote-URL session is in front.
 *
 * Why: while the isolated surface is visible the host Capacitor process sits in
 * the background with TWO full Chromium stacks resident. On 2-4GB phones the
 * low-memory killer regularly reaped the background host process, so closing
 * the mini app cold-restarted the whole agent app (splash + WebView reload —
 * the "ager page dekhay na, sob blank" report). A foreground service moves the
 * host process into a kill-protected oom bucket for the duration of the session
 * only, then removes itself.
 */
public final class IsolatedSessionKeepAliveService extends Service {
    static final String ACTION_START = "dev.nativekit.isolatedbrowser.KEEPALIVE_START";
    static final String ACTION_STOP = "dev.nativekit.isolatedbrowser.KEEPALIVE_STOP";
    private static final String CHANNEL_ID = "nativekit_isolated_session";
    private static final int NOTIFICATION_ID = 47201;
    private static final long MAX_SESSION_MS = 30L * 60_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable maxTimeout = new Runnable() {
        @Override public void run() { stopSession(); }
    };

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSession();
            return START_NOT_STICKY;
        }
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, buildNotification());
            }
        } catch (Throwable error) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(maxTimeout);
        handler.postDelayed(maxTimeout, MAX_SESSION_MS);
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(maxTimeout);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // The host task was swiped away — no session is worth keeping alive anymore.
        stopSession();
        super.onTaskRemoved(rootIntent);
    }

    private void stopSession() {
        handler.removeCallbacks(maxTimeout);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Mini-app sessions", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while an isolated mini app is open so the agent workspace keeps running");
            channel.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        } catch (Throwable ignored) {}
    }

    private Notification buildNotification() {
        PendingIntent contentIntent = null;
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                contentIntent = PendingIntent.getActivity(this, NOTIFICATION_ID, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            }
        } catch (Throwable ignored) {}
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("NativeKit agent active")
            .setContentText("A mini app is open — keeping the agent workspace alive in the background.")
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_SECRET)
            .setOngoing(true)
            .setAutoCancel(false);
        if (contentIntent != null) builder.setContentIntent(contentIntent);
        return builder.build();
    }

    static void start(Context context) {
        if (context == null) return;
        try {
            Intent intent = new Intent(context, IsolatedSessionKeepAliveService.class).setAction(ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Throwable ignored) { /* Best-effort protection; session still runs without it. */ }
    }

    static void stop(Context context) {
        if (context == null) return;
        try {
            Intent intent = new Intent(context, IsolatedSessionKeepAliveService.class).setAction(ACTION_STOP);
            context.startService(intent);
        } catch (Throwable ignored) {}
    }
}
