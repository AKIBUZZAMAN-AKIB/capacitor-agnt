package dev.nativekit.widget;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Renders an HTML/CSS/JS string (or a bundled page) to a {@link Bitmap} using an offscreen
 * {@link WebView}, so a home-screen widget can show rich HTML content. Home-screen widgets cannot
 * host a live WebView (they are inflated by the launcher from a RemoteViews whitelist), so the HTML
 * is rendered to a bitmap that is then set on a widget {@code ImageView}. This produces a static
 * snapshot (not interactive / not animating); re-trigger a widget update to refresh it.
 *
 * <p>Correctness notes (audited):
 * <ul>
 *   <li>The WebView is created on the main thread (a platform requirement) and destruction is also
 *       posted to the main thread, so a renderer process is never leaked across repeated updates.</li>
 *   <li>Capture uses a <em>software</em> display layer + drawing cache (with a {@code draw(Canvas)}
 *       fallback). A hardware-accelerated WebView that is never attached to a window can otherwise
 *       paint a blank bitmap on Android 10+; requesting a software layer makes {@code draw()} yield
 *       real pixels for typical card/snippet content.</li>
 *   <li>A {@link WebViewAssetLoader} is wired so bundled assets resolve the same way the floating
 *       overlay does ({@code https://appassets.androidplatform.net/<path>} &rarr; {@code assets/}).</li>
 *   <li>The bitmap cache never {@link Bitmap#recycle()}s evicted entries, because a bitmap that is
 *       still attached to a launcher {@code RemoteViews} must not be recycled (that throws
 *       "Bitmap already recycled"). Evicted entries are simply dropped for GC.</li>
 * </ul>
 *
 * <p>Rendering is asynchronous and never blocks the main thread. Every failure is logged and
 * reported as {@code null} so a widget can never crash the app.
 */
public final class HtmlWidgetRenderer {

    private static final String TAG = "NativeKitHtmlW";
    /** Base URL for bundled pages (matches the floating overlay's asset-loader host). */
    private static final String ASSET_BASE = "https://appassets.androidplatform.net/";
    /** Default base for inline {@code html} relative assets: the Capacitor web root (public/). */
    private static final String HTML_DEFAULT_BASE = "https://appassets.androidplatform.net/public/";

    /** Small bitmap cache so repeated widget updates do not re-render identical content. */
    private static final Map<String, Bitmap> CACHE = new HashMap<>();
    private static final int CACHE_LIMIT = 8;

    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    public interface Callback {
        void onBitmap(Bitmap bitmap);
    }

    private HtmlWidgetRenderer() {}

    /** True when the developer opted into HTML/webview rendering for the home-screen widget. */
    public static boolean isHtmlMode(JSONObject cfg) {
        if (cfg == null) return false;
        String render = cfg.optString("render", "native");
        boolean hasContent = cfg.has("html")
                || (cfg.has("page") && !cfg.optString("page", "").isEmpty());
        return hasContent && ("html".equalsIgnoreCase(render) || "webview".equalsIgnoreCase(render));
    }

    /**
     * Render the configured HTML/page to a bitmap of the given pixel size and deliver it to the
     * callback. If the same content was rendered before, the cached bitmap is returned immediately.
     */
    public static void render(Context context, JSONObject cfg, int widthPx, int heightPx, Callback callback) {
        final String key = cacheKey(cfg, widthPx, heightPx);
        Bitmap cached = CACHE.get(key);
        if (cached != null && !cached.isRecycled()) {
            callback.onBitmap(cached);
            return;
        }
        POOL.execute(() -> {
            final AtomicReference<Bitmap> result = new AtomicReference<>();
            final AtomicReference<WebView> liveWv = new AtomicReference<>();
            final CountDownLatch latch = new CountDownLatch(1);
            final Context app = context.getApplicationContext();
            MAIN.post(() -> {
                WebView wv = null;
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        WebView.enableSlowWholeDocumentDraw();
                    }
                    wv = new WebView(app);
                    liveWv.set(wv);
                    wv.setBackgroundColor(Color.TRANSPARENT);
                    wv.setVerticalScrollBarEnabled(false);
                    wv.setHorizontalScrollBarEnabled(false);
                    // Force software rendering so a detached WebView draws real pixels to the Canvas
                    // (a hardware-accelerated WebView with no attached window can otherwise be blank).
                    wv.setLayerType(View.LAYER_TYPE_SOFTWARE, null);

                    WebSettings s = wv.getSettings();
                    final boolean sandboxed = cfg.optBoolean("sandboxed", false);
                    s.setJavaScriptEnabled(true);
                    // Mini App artifacts are self-contained untrusted HTML. They must not
                    // read host assets/files or exfiltrate data over the network. Trusted
                    // host widgets retain the legacy asset-loader behavior.
                    s.setBlockNetworkLoads(sandboxed);
                    s.setDomStorageEnabled(!sandboxed);
                    s.setAllowFileAccess(!sandboxed);
                    s.setAllowContentAccess(!sandboxed);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        s.setMixedContentMode(sandboxed ? WebSettings.MIXED_CONTENT_NEVER_ALLOW : WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                    }

                    final int w = Math.max(1, widthPx);
                    final int h = Math.max(1, heightPx);
                    wv.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
                    wv.layout(0, 0, w, h);

                    final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                            .setDomain("appassets.androidplatform.net")
                            .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(app))
                            .build();

                    final WebView finalWv = wv;
                    wv.setWebViewClient(new WebViewClient() {
                        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                            if (sandboxed) return null;
                            try { return assets.shouldInterceptRequest(request.getUrl()); }
                            catch (Throwable error) { return null; }
                        }
                        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                            return sandboxed;
                        }
                        @Override public void onPageFinished(WebView view, String url) {
                            // Wait a short beat so the page has actually painted before capture, then
                            // snapshot + destroy the WebView on this same main-thread runnable.
                            view.postDelayed(() -> {
                                Bitmap b = snapshot(view, w, h);
                                result.set(b);
                                destroy(view);
                                latch.countDown();
                            }, 180);
                        }
                    });

                    final String html = cfg.optString("html", null);
                    final String page = cfg.optString("page", null);
                    String base = sandboxed ? "https://miniapp.invalid/" : cfg.optString("htmlBaseUrl", HTML_DEFAULT_BASE);
                    if (html != null && !html.isEmpty()) {
                        finalWv.loadDataWithBaseURL(base, html, "text/html", "UTF-8", null);
                    } else if (page != null && !page.isEmpty()) {
                        finalWv.loadUrl(ASSET_BASE + page);
                    } else {
                        latch.countDown();
                    }
                } catch (Throwable error) {
                    Log.e(TAG, "render (webview setup) failed", error);
                    latch.countDown();
                }
            });
            try {
                latch.await(8, TimeUnit.SECONDS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
            if (result.get() == null) {
                // Timeout / load never finished: make sure the WebView is torn down.
                final WebView toDestroy = liveWv.get();
                if (toDestroy != null) MAIN.post(() -> destroy(toDestroy));
            }
            Bitmap bitmap = result.get();
            if (bitmap != null) cache(key, bitmap);
            // Callback may be invoked from the pool thread; the provider hops to main as needed.
            callback.onBitmap(bitmap);
        });
    }

    private static Bitmap snapshot(WebView wv, int w, int h) {
        try {
            Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            wv.draw(canvas);
            return bitmap;
        } catch (Throwable error) {
            Log.e(TAG, "snapshot (webview draw) failed", error);
            return null;
        }
    }

    /** Tear down a WebView on the main thread; idempotent and never throws. */
    private static void destroy(WebView wv) {
        if (wv == null) return;
        try {
            wv.setWebViewClient(null);
            wv.stopLoading();
            wv.loadUrl("about:blank");
            wv.destroy();
        } catch (Throwable ignored) {}
    }

    private static String cacheKey(JSONObject cfg, int w, int h) {
        String content = cfg.optString("html", cfg.optString("page", ""))
                + "|" + cfg.optString("htmlBaseUrl", "") + "|" + w + "x" + h;
        return Integer.toHexString(content.hashCode());
    }

    private static synchronized void cache(String key, Bitmap bitmap) {
        if (CACHE.size() >= CACHE_LIMIT) {
            String eldest = CACHE.keySet().iterator().next();
            CACHE.remove(eldest); // do NOT recycle: it may still be attached to a live RemoteViews
        }
        CACHE.put(key, bitmap);
    }
}
