package dev.nativekit.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONObject;

/**
 * Base AppWidgetProvider for config-driven home-screen widgets. scripts/configure-native.mjs
 * generates one tiny subclass per declared home-screen kind in the app package, so each widget
 * keeps its own unique provider ComponentName (required by Android) while sharing all rendering
 * logic here. The rendering reads the kind's stored spec from WidgetStore.
 *
 * <p>AppWidgetProvider callbacks run inside the app's own process, so an uncaught exception here
 * (a bad config value, a missing view id, a malformed color) would crash the whole app — appearing
 * to users as "the app closes when I open it". Every render is therefore wrapped so a widget can
 * never take the app down: failures are logged and the render is skipped instead.
 */
public abstract class NativeKitWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "NativeKitWidget";

    /** Custom tap action used when a widget action button is pressed. */
    static final String ACTION_TAP = "dev.nativekit.widget.ACTION_WIDGET_TAP";
    private static final String ACTION_UPDATE = "android.appwidget.action.APPWIDGET_UPDATE";

    /** The configured kind this provider renders (returned by the generated subclass). */
    public abstract String kind();

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        JSONObject config;
        try {
            config = WidgetStore.readConfig(context, kind());
        } catch (Exception error) {
            Log.e(TAG, "readConfig failed for kind '" + kind() + "'", error);
            config = new JSONObject();
        }
        if (appWidgetIds == null) return;
        for (int appWidgetId : appWidgetIds) {
            try {
                render(context, manager, appWidgetId, config);
            } catch (Throwable error) {
                // Never let a widget render error take the app process down.
                Log.e(TAG, "render failed for kind '" + kind() + "' widget " + appWidgetId, error);
            }
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int appWidgetId, android.os.Bundle newOptions) {
        super.onAppWidgetOptionsChanged(context, manager, appWidgetId, newOptions);
        try {
            render(context, manager, appWidgetId, WidgetStore.readConfig(context, kind()));
        } catch (Throwable error) {
            Log.e(TAG, "onAppWidgetOptionsChanged render failed for widget " + appWidgetId, error);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            super.onReceive(context, intent);
            if (ACTION_TAP.equals(intent.getAction())) {
                // Forward the tap to the host plugin's dynamic receiver so it becomes a
                // "nativeWidgetTap" event in the web bridge. Scoped to our own package so no
                // other process can spoof it.
                Intent forward = new Intent(ACTION_TAP);
                forward.setPackage(context.getPackageName());
                forward.putExtra("kind", kind());
                if (intent.hasExtra("action")) forward.putExtra("action", intent.getStringExtra("action"));
                if (intent.hasExtra("value")) forward.putExtra("value", intent.getStringExtra("value"));
                if (intent.hasExtra("id")) forward.putExtra("id", intent.getIntExtra("id", 0));
                context.sendBroadcast(forward);
            }
        } catch (Throwable error) {
            Log.e(TAG, "onReceive failed for kind '" + kind() + "'", error);
        }
    }

    private void render(Context context, AppWidgetManager manager, int appWidgetId, JSONObject config) {
        // Defensively-final local so lambdas below can capture it; a reassigned parameter is
        // not "effectively final" and would not compile.
        final JSONObject cfg = config != null ? config : new JSONObject();

        // HTML/CSS/JS mode: render the developer's page to a bitmap and show it in an ImageView.
        // This is the only way to get a live-HTML design onto a home-screen widget (RemoteViews
        // cannot host a WebView). It is a static snapshot; re-update to refresh.
        if (HtmlWidgetRenderer.isHtmlMode(cfg)) {
            renderHtmlWidget(context, manager, appWidgetId, cfg);
            return;
        }

        // 'layout' is either a bundled preset (small|medium|large) or any layout resource the app
        // ships (free design): the developer designs its own RemoteViews XML (RelativeLayout,
        // gradients, ImageView, Button...) and references it by name. We still fill the SAME id
        // contract below (widget_value/title/subtitle/icon/image/progress/button/root), so a fully
        // custom look works with zero layout code in this plugin.
        String layoutName = cfg.optString("layout", "medium");
        int layoutRes = resolveLayout(context, layoutName);
        RemoteViews views = new RemoteViews(context.getPackageName(), layoutRes);

        boolean has = cfg.has("value");
        setText(views, R.id.widget_value, cfg.optString("value", ""), has);

        setText(views, R.id.widget_title, cfg.optString("title",
                context.getString(R.string.nativekit_widget_title)), true);

        setText(views, R.id.widget_subtitle, cfg.optString("subtitle", ""), cfg.has("subtitle"));

        // Icon is optional; only touch it when it is actually demanded so layouts without the
        // view (or empty values) never throw. All shipped layouts now include widget_icon, but
        // third-party renders / future small layouts may not.
        String icon = cfg.optString("icon", "");
        boolean showIcon = cfg.has("icon") && !icon.isEmpty();
        safe(views, R.id.widget_icon, () -> {
            views.setTextViewText(R.id.widget_icon, icon);
            views.setViewVisibility(R.id.widget_icon, showIcon ? View.VISIBLE : View.GONE);
        });

        // Real image via an ImageView: either a bundled drawable name ('image') or a base64
        // data-URI bitmap ('imageData'). RemoteViews supports setImageViewResource/Bitmap; a
        // missing widget_image id is safely skipped (so bundled layouts without it still work).
        applyImage(views, context, cfg);

        // Colors are passed as hex strings to stay clear of Java int-overflow issues. Only set a
        // background at runtime when the developer explicitly asks — a custom layout that uses a
        // drawable/gradient (e.g. @drawable/... in XML) keeps its design when no color is passed.
        if (cfg.has("backgroundColor")) {
            safe(views, R.id.widget_root, () -> views.setInt(R.id.widget_root, "setBackgroundColor",
                    WidgetStore.color(cfg, "backgroundColor", 0xFF0F172A)));
        }
        final int valueColor = WidgetStore.color(cfg, "valueColor",
                WidgetStore.color(cfg, "accentColor", 0xFF4FC3F7));
        safe(views, R.id.widget_value, () -> views.setTextColor(R.id.widget_value, valueColor));
        safe(views, R.id.widget_title, () -> views.setTextColor(R.id.widget_title,
                WidgetStore.color(cfg, "titleColor", 0xFFFFFFFF)));
        safe(views, R.id.widget_subtitle, () -> views.setTextColor(R.id.widget_subtitle,
                WidgetStore.color(cfg, "subtitleColor", 0xFFB0BEC5)));

        // Numeric text sizes (sp). A developer can scale value/title/subtitle without shipping a new
        // layout — RemoteViews.setFloat(...,"setTextSize",...) is the legal way to set a float prop.
        if (cfg.has("valueSize")) safe(views, R.id.widget_value, () ->
                views.setFloat(R.id.widget_value, "setTextSize", (float) cfg.optDouble("valueSize", 40)));
        if (cfg.has("titleSize")) safe(views, R.id.widget_title, () ->
                views.setFloat(R.id.widget_title, "setTextSize", (float) cfg.optDouble("titleSize", 14)));
        if (cfg.has("subtitleSize")) safe(views, R.id.widget_subtitle, () ->
                views.setFloat(R.id.widget_subtitle, "setTextSize", (float) cfg.optDouble("subtitleSize", 11)));

        // Horizontal alignment of the widget content (root gravity): 'start' | 'center' | 'end'.
        String align = cfg.optString("align", "center");
        final int alignGravity;
        switch (align) {
            case "start": alignGravity = Gravity.START | Gravity.CENTER_VERTICAL; break;
            case "end":   alignGravity = Gravity.END | Gravity.CENTER_VERTICAL; break;
            default:      alignGravity = Gravity.CENTER; break;
        }
        safe(views, R.id.widget_root, () -> views.setInt(R.id.widget_root, "setGravity", alignGravity));

        // Optional progress / level bar (only honored on layouts that include widget_progress).
        if (cfg.has("progress")) {
            safe(views, R.id.widget_progress, () -> {
                int progress = cfg.optInt("progress", 0);
                int max = cfg.optInt("progressMax", 100);
                views.setInt(R.id.widget_progress, "setMax", Math.max(1, max));
                views.setInt(R.id.widget_progress, "setProgress", Math.max(0, Math.min(progress, max)));
                views.setViewVisibility(R.id.widget_progress, View.VISIBLE);
            });
        } else {
            safe(views, R.id.widget_progress, () -> views.setViewVisibility(R.id.widget_progress, View.GONE));
        }

        // Whole widget tap -> open the app (always works, even when the web bridge is not up yet).
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open != null) {
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                PendingIntent openPi = PendingIntent.getActivity(context, requestCode(kind(), 1), open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                safe(views, R.id.widget_root, () -> views.setOnClickPendingIntent(R.id.widget_root, openPi));
            } catch (Throwable error) {
                Log.e(TAG, "open pending intent failed", error);
            }
        }

        // Optional dedicated action button -> emits nativeWidgetTap with the action payload.
        if (cfg.has("action") && !cfg.optString("action", "").isEmpty()) {
            Intent tap = new Intent(context, getClass()).setAction(ACTION_TAP);
            tap.putExtra("id", appWidgetId);
            tap.putExtra("action", cfg.optString("action"));
            if (cfg.has("actionValue")) tap.putExtra("value", cfg.optString("actionValue"));
            try {
                PendingIntent tapPi = PendingIntent.getBroadcast(context, requestCode(kind(), 2), tap,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                safe(views, R.id.widget_button, () -> {
                    views.setOnClickPendingIntent(R.id.widget_button, tapPi);
                    views.setViewVisibility(R.id.widget_button, View.VISIBLE);
                    // Only override button colors when the developer asks — otherwise a custom
                    // layout's own drawable button (e.g. a rounded gradient) keeps its design.
                    if (cfg.has("buttonTextColor")) views.setTextColor(R.id.widget_button,
                            WidgetStore.color(cfg, "buttonTextColor", 0xFFFFFFFF));
                    if (cfg.has("buttonColor")) views.setInt(R.id.widget_button, "setBackgroundColor",
                            WidgetStore.color(cfg, "buttonColor", 0xFF1E293B));
                    views.setTextViewText(R.id.widget_button, cfg.optString("buttonLabel",
                            context.getString(R.string.nativekit_widget_open)));
                });
            } catch (Throwable error) {
                Log.e(TAG, "opening pending intent failed", error);
            }
        } else {
            safe(views, R.id.widget_button, () -> views.setViewVisibility(R.id.widget_button, View.GONE));
        }

        // Guard the final commit so a process death never results from a bad widget config.
        try {
            manager.updateAppWidget(appWidgetId, views);
        } catch (Throwable error) {
            Log.e(TAG, "updateAppWidget failed for widget " + appWidgetId, error);
        }
    }

    /**
     * Render an HTML/CSS/JS design (inline {@code html} or a bundled {@code page}) to a bitmap and
     * show it in the widget's full-bleed {@code widget_html} ImageView. The layout used is the
     * {@code widget_html} container (or a custom layout carrying {@code widget_html}); the native
     * text/icon/button views are hidden and the whole widget tap opens the app. Rendering is
     * async (offscreen WebView -> bitmap); failure simply leaves the ImageView hidden.
     */
    private void renderHtmlWidget(Context context, AppWidgetManager manager, int appWidgetId, JSONObject cfg) {
        try {
            int widthPx = cfg.optInt("widthPx", 320);
            int heightPx = cfg.optInt("heightPx", 320);
            int layoutRes = resolveHtmlLayout(context, cfg.optString("layout", ""));
            HtmlWidgetRenderer.render(context, cfg, widthPx, heightPx, (bitmap) -> {
                android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
                main.post(() -> {
                    try {
                        RemoteViews views = new RemoteViews(context.getPackageName(), layoutRes);
                        if (bitmap != null) {
                            views.setImageViewBitmap(R.id.widget_html, bitmap);
                            views.setViewVisibility(R.id.widget_html, View.VISIBLE);
                        }
                        // Whole widget tap: if an action is declared, emit nativeWidgetTap (like the
                        // native layout); otherwise open the app. Keeps the HTML widget interactive
                        // at the same level as the preset layouts.
                        String action = cfg.optString("action", "");
                        if (!action.isEmpty()) {
                            Intent tap = new Intent(context, getClass()).setAction(ACTION_TAP);
                            tap.putExtra("id", appWidgetId);
                            tap.putExtra("kind", kind());
                            tap.putExtra("action", action);
                            if (cfg.has("actionValue")) tap.putExtra("value", cfg.optString("actionValue"));
                            try {
                                PendingIntent tapPi = PendingIntent.getBroadcast(context, requestCode(kind(), 2), tap,
                                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                                safe(views, R.id.widget_root, () -> views.setOnClickPendingIntent(R.id.widget_root, tapPi));
                            } catch (Throwable error) {
                                Log.e(TAG, "html widget tap pending intent failed", error);
                            }
                        } else {
                            Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                            if (open != null) {
                                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                try {
                                    PendingIntent openPi = PendingIntent.getActivity(context, requestCode(kind(), 1), open,
                                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                                    safe(views, R.id.widget_root, () -> views.setOnClickPendingIntent(R.id.widget_root, openPi));
                                } catch (Throwable error) {
                                    Log.e(TAG, "html widget open pending intent failed", error);
                                }
                            }
                        }
                        manager.updateAppWidget(appWidgetId, views);
                    } catch (Throwable error) {
                        Log.e(TAG, "html widget update failed for " + appWidgetId, error);
                    }
                });
            });
        } catch (Throwable error) {
            Log.e(TAG, "renderHtmlWidget failed for widget " + appWidgetId, error);
        }
    }

    /** Pick the container layout for an HTML widget; defaults to the bundled {@code widget_html}. */
    private int resolveHtmlLayout(Context context, String layoutName) {
        if (layoutName != null && !layoutName.isEmpty()) {
            try {
                int id = context.getResources().getIdentifier(layoutName, "layout", context.getPackageName());
                if (id != 0) return id;
            } catch (Throwable error) {
                Log.e(TAG, "resolveHtmlLayout failed for '" + layoutName + "'", error);
            }
        }
        return R.layout.widget_html;
    }

    /**
     * Resolve a layout by name. The bundled presets (small|medium|large) map to our layouts. Any
     * other name is looked up in the app's merged resources via getIdentifier so a developer can
     * ship their own RemoteViews design (free design) and reference it by resource name. Falls back
     * to medium when unknown.
     */
    private int resolveLayout(Context context, String layoutName) {
        switch (layoutName) {
            case "small": return R.layout.widget_small;
            case "large": return R.layout.widget_large;
            case "medium": return R.layout.widget_medium;
            default:
                if (layoutName != null && !layoutName.isEmpty()) {
                    try {
                        int id = context.getResources().getIdentifier(layoutName, "layout", context.getPackageName());
                        if (id != 0) return id;
                    } catch (Throwable error) {
                        Log.e(TAG, "resolveLayout failed for '" + layoutName + "'", error);
                    }
                }
                return R.layout.widget_medium;
        }
    }

    /** Apply a real image (drawable name or base64 bitmap) to @+id/widget_image; safe when absent. */
    private void applyImage(RemoteViews views, Context context, JSONObject cfg) {
        String resName = cfg.optString("image", "");
        if (!resName.isEmpty()) {
            safe(views, R.id.widget_image, () -> {
                int res = context.getResources().getIdentifier(resName, "drawable", context.getPackageName());
                if (res != 0) {
                    views.setImageViewResource(R.id.widget_image, res);
                    views.setViewVisibility(R.id.widget_image, View.VISIBLE);
                } else {
                    views.setViewVisibility(R.id.widget_image, View.GONE);
                }
            });
        } else if (cfg.has("imageData")) {
            safe(views, R.id.widget_image, () -> {
                Bitmap bmp = decodeBase64Image(cfg.optString("imageData", ""));
                if (bmp != null) {
                    views.setImageViewBitmap(R.id.widget_image, bmp);
                    views.setViewVisibility(R.id.widget_image, View.VISIBLE);
                } else {
                    views.setViewVisibility(R.id.widget_image, View.GONE);
                }
            });
        } else {
            safe(views, R.id.widget_image, () -> views.setViewVisibility(R.id.widget_image, View.GONE));
        }
    }

    /** Decode a base64 image (with or without a "data:" URI prefix) to a Bitmap, or null on failure. */
    private static Bitmap decodeBase64Image(String data) {
        try {
            if (data == null) return null;
            String s = data;
            int comma = data.indexOf(',');
            boolean isDataUri = data.startsWith("data:") && comma >= 0;
            if (isDataUri) s = data.substring(comma + 1);
            byte[] raw = android.util.Base64.decode(s, android.util.Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(raw, 0, raw.length);
        } catch (Throwable error) {
            Log.e(TAG, "decode base64 image failed (skipped)", error);
            return null;
        }
    }

    /** Apply a view action but never throw (a missing view id / bad value is logged and skipped). */
    private void safe(RemoteViews views, int id, Runnable action) {
        try {
            action.run();
        } catch (Throwable error) {
            Log.e(TAG, "widget view " + id + " operation failed (skipped)", error);
        }
    }

    /** Set a text view, hiding it when {@code visible} is false; never throw. */
    private void setText(RemoteViews views, int id, String text, boolean visible) {
        safe(views, id, () -> {
            views.setTextViewText(id, text == null ? "" : text);
            views.setViewVisibility(id, visible ? View.VISIBLE : View.GONE);
        });
    }

    private static int requestCode(String kind, int salt) {
        return (kind + ":" + salt).hashCode() & 0x7fffffff;
    }
}
