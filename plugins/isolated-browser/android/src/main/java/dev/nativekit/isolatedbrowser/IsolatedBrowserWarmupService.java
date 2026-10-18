package dev.nativekit.isolatedbrowser;

import android.app.ActivityManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.WebView;

/**
 * Keeps the ':nativekit_isolated' process warm so the FIRST mini-app / remote-URL
 * launch skips the Chromium provider cold init (typically 300-800ms on mid-range
 * hardware). The service creates one headless WebView when the host app starts and
 * holds it until a real session takes over ({@link #releaseForSession()}) or the
 * idle timeout expires.
 *
 * Memory trade-off: a warm WebView costs background memory, so the service is only
 * started on devices that can afford it (see {@link #shouldWarm(Context)}). This is
 * the same preload/preheat strategy WeChat documents for its mini-program runtime.
 */
public final class IsolatedBrowserWarmupService extends Service {
    private static final long IDLE_TIMEOUT_MS = 15L * 60_000L;
    private static final long MIN_TOTAL_RAM_BYTES = 3L * 1024L * 1024L * 1024L;

    private static volatile WebView warmWebView;
    private static volatile IsolatedBrowserWarmupService instance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable idleTimeout = new Runnable() {
        @Override public void run() { stopSelf(); }
    };

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT < 28) { stopSelf(); return; }
        try { WebView.setDataDirectorySuffix("nativekit-isolated-v1"); }
        catch (IllegalStateException ignored) { /* WebView already initialized in this process. */ }
        try {
            WebView view = new WebView(getApplicationContext());
            view.setBackgroundColor(0xFF07111F);
            warmWebView = view;
        } catch (Throwable error) {
            warmWebView = null;
            stopSelf();
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        handler.removeCallbacks(idleTimeout);
        handler.postDelayed(idleTimeout, IDLE_TIMEOUT_MS);
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(idleTimeout);
        instance = null;
        destroyWarmWebView();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void destroyWarmWebView() {
        WebView view = warmWebView;
        warmWebView = null;
        if (view == null) return;
        try { view.loadUrl("about:blank"); } catch (Throwable ignored) {}
        try { view.destroy(); } catch (Throwable ignored) {}
    }

    /**
     * A real isolated session is starting in this process: release the warm
     * WebView's memory immediately (the provider itself stays loaded, which is
     * the part that is expensive).
     */
    static void releaseForSession() {
        IsolatedBrowserWarmupService service = instance;
        if (service == null) return;
        service.destroyWarmWebView();
        service.stopSelf();
    }

    /** Starts pre-warming when the device can afford the background memory. */
    static void warm(Context context) {
        if (context == null || !shouldWarm(context)) return;
        try {
            context.startService(new Intent(context, IsolatedBrowserWarmupService.class));
        } catch (Throwable ignored) { /* Best-effort only; background starts are simply skipped. */ }
    }

    static boolean shouldWarm(Context context) {
        if (Build.VERSION.SDK_INT < 28) return false;
        try {
            ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) return false;
            if (manager.isLowRamDevice()) return false;
            ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(info);
            return info.totalMem >= MIN_TOTAL_RAM_BYTES;
        } catch (Throwable error) { return false; }
    }
}
