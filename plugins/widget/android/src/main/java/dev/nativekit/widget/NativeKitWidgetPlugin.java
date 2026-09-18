package dev.nativekit.widget;

import android.appwidget.AppWidgetManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

@CapacitorPlugin(name = "NativeKitWidget")
public class NativeKitWidgetPlugin extends Plugin {

    private static final String ACTION_WIDGET_TAP = "dev.nativekit.widget.ACTION_WIDGET_TAP";
    private static final String ACTION_FLOATING_MESSAGE = "dev.nativekit.widget.ACTION_FLOATING_MESSAGE";
    private static final String ACTION_FLOATING_COMMAND = "dev.nativekit.widget.ACTION_FLOATING_COMMAND";
    private BroadcastReceiver eventReceiver;

    @Override
    public void load() {
        WidgetStore store = new WidgetStore(getContext());
        // If a widget kind is configured before the bridge ever calls setConfig, there is
        // nothing to render; the provider already falls back to a sensible default spec.
        eventReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_WIDGET_TAP.equals(intent.getAction())) {
                    JSObject value = new JSObject();
                    value.put("kind", intent.getStringExtra("kind"));
                    if (intent.hasExtra("action")) value.put("action", intent.getStringExtra("action"));
                    if (intent.hasExtra("value")) value.put("value", intent.getStringExtra("value"));
                    if (intent.hasExtra("id")) value.put("widgetId", intent.getIntExtra("id", 0));
                    notifyListeners("nativeWidgetTap", value, true);
                } else if (ACTION_FLOATING_MESSAGE.equals(intent.getAction())) {
                    JSObject value = new JSObject();
                    String message = intent.getStringExtra("data");
                    try {
                        if (message != null && message.startsWith("{")) value = new JSObject(message);
                        else value.put("data", message);
                    } catch (Exception ignored) {
                        value.put("data", message);
                    }
                    notifyListeners("nativeFloatingMessage", value, true);
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_WIDGET_TAP);
        filter.addAction(ACTION_FLOATING_MESSAGE);
        try {
            if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(eventReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            else getContext().registerReceiver(eventReceiver, filter);
        } catch (Throwable error) {
            // Registering the dynamic receiver can fail on some OEM builds; never let a plugin
            // load step crash the whole app at startup.
            android.util.Log.e("NativeKitWidget", "registerReceiver failed", error);
        }
        // config.widget.floating.startOnLaunch (baked into the manifest at native-sync) lets the
        // bubble appear automatically when the app launches. Guarded: only when the config asks for
        // it AND the overlay permission is already granted AND no bubble is running.
        maybeStartFloatingOnLaunch();
    }

    private void maybeStartFloatingOnLaunch() {
        try {
            if (FloatingWidgetService.isRunning()) return;
            if (!readStartOnLaunch()) return;
            if (!Settings.canDrawOverlays(getContext())) return; // no permission yet; wait for the user
            Intent service = new Intent(getContext(), FloatingWidgetService.class);
            service.setAction(FloatingWidgetService.ACTION_START);
            try {
                ContextCompat.startForegroundService(getContext(), service);
            } catch (Exception error) {
                android.util.Log.e("NativeKitWidget", "startFloatingOnLaunch startForegroundService failed", error);
            }
        } catch (Throwable error) {
            android.util.Log.e("NativeKitWidget", "startFloatingOnLaunch failed", error);
        }
    }

    /** Read config.widget.floating.startOnLaunch from the manifest meta-data baked at native-sync. */
    private boolean readStartOnLaunch() {
        try {
            ApplicationInfo info = getContext().getPackageManager().getApplicationInfo(
                    getContext().getPackageName(), PackageManager.GET_META_DATA);
            if (info != null && info.metaData != null) {
                return info.metaData.getBoolean("dev.nativekit.FLOATING_START_ON_LAUNCH", false);
            }
        } catch (Throwable ignored) {}
        return false;
    }

    @Override
    protected void handleOnDestroy() {
        if (eventReceiver != null) {
            try { getContext().unregisterReceiver(eventReceiver); } catch (Exception ignored) {}
        }
        super.handleOnDestroy();
    }

    // -- Home-screen widget ----------------------------------------------------

    @PluginMethod
    public void setConfig(PluginCall call) {
        String kind = call.getString("kind");
        JSObject config = call.getObject("config");
        if (kind == null || kind.isEmpty()) { call.reject("kind is required"); return; }
        if (config == null) { call.reject("config is required"); return; }
        new WidgetStore(getContext()).setConfig(kind, config);
        JSObject result = new JSObject();
        result.put("kind", kind);
        result.put("saved", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        String kind = call.getString("kind");
        if (kind == null || kind.isEmpty()) { call.reject("kind is required"); return; }
        JSObject result = new JSObject();
        try {
            JSONObject config = new WidgetStore(getContext()).getConfig(kind);
            result.put("kind", kind);
            result.put("config", config == null ? null : new JSObject(config.toString()));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Widget config could not be read", error);
        }
    }

    @PluginMethod
    public void listConfigs(PluginCall call) {
        JSObject result = new JSObject();
        try {
            JSONObject all = new WidgetStore(getContext()).listConfigs();
            Iterator<String> keys = all.keys();
            while (keys.hasNext()) {
                String kind = keys.next();
                JSONObject config = all.optJSONObject(kind);
                if (config != null) result.put(kind, new JSObject(config.toString()));
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Widget configs could not be read", error);
        }
    }

    @PluginMethod
    public void getWidgetIds(PluginCall call) {
        String kind = call.getString("kind");
        if (kind == null || kind.isEmpty()) { call.reject("kind is required"); return; }
        AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
        int[] ids = manager.getAppWidgetIds(providerComponent(kind));
        JSObject result = new JSObject();
        result.put("ids", ids);
        call.resolve(result);
    }

    @PluginMethod
    public void reload(PluginCall call) {
        String kind = call.getString("kind");
        List<String> kinds = new ArrayList<>();
        try {
            if (kind != null && !kind.isEmpty()) kinds.add(kind);
            else {
                JSONObject all = new WidgetStore(getContext()).listConfigs();
                Iterator<String> keys = all.keys();
                while (keys.hasNext()) kinds.add(keys.next());
            }
            int updated = 0;
            for (String current : kinds) updated += requestUpdate(current);
            JSObject result = new JSObject();
            result.put("updated", updated);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Widget reload failed", error);
        }
    }

    @PluginMethod
    public void requestPin(PluginCall call) {
        String kind = call.getString("kind");
        if (kind == null || kind.isEmpty()) { call.reject("kind is required"); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("Home-screen widget pinning requires Android 8.0+");
            return;
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
        boolean requested = manager.requestPinAppWidget(providerComponent(kind), null, null);
        JSObject result = new JSObject();
        result.put("requested", requested);
        // On some launchers (Samsung/MIUI/AOSP) requestPinAppWidget returns false right after a
        // fresh install or when the launcher hasn't refreshed the provider yet. Surface it so the
        // user has a reliable fallback instead of seeing nothing happen.
        if (!requested) result.put("hint",
                "The launcher did not show the pin prompt — long-press the home screen → Widgets → "
                + "add \"" + kind + "\" manually.");
        call.resolve(result);
    }

    // -- Floating overlay widget ------------------------------------------------

    @PluginMethod
    public void checkOverlayPermission(PluginCall call) {
        boolean granted = Settings.canDrawOverlays(getContext());
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(getContext())) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(intent);
                call.resolve();
            } catch (Exception error) {
                call.reject("Unable to open overlay permission settings", error);
            }
        } else {
            call.resolve();
        }
    }

    @PluginMethod
    public void showFloating(PluginCall call) {
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("Display-over-other-apps permission is not granted; call requestOverlayPermission first");
            return;
        }
        // The whole call object is the floating spec (title/page/width/height/collapsed/data).
        // Persist it so the foreground service can rebuild exactly this bubble after a process death.
        JSObject config = call.getData();
        if (config == null) config = new JSObject();
        new WidgetStore(getContext()).setConfig("floating", config);
        Intent service = new Intent(getContext(), FloatingWidgetService.class);
        service.setAction(FloatingWidgetService.ACTION_START);
        try {
            ContextCompat.startForegroundService(getContext(), service);
        } catch (Exception error) {
            android.util.Log.e("NativeKitWidget", "startForegroundService failed", error);
            call.reject("Unable to start floating overlay service", error);
            return;
        }
        // The service attaches the overlay window asynchronously on the main thread. Wait briefly
        // for it to report a real outcome so the caller never sees "running: true" while nothing
        // is on screen (a confusing symptom on Android 10 / low-end devices).
        long deadline = System.currentTimeMillis() + 2500;
        while (!FloatingWidgetService.isAttempted() && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(40); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); break; }
        }
        boolean shown = FloatingWidgetService.isShown();
        String err = FloatingWidgetService.getLastError();
        // Fall back to the durable outcome if the service already tore itself down (low-end
        // devices may kill the process right after a start/attach failure).
        if (!FloatingWidgetService.isAttempted()) {
            org.json.JSONObject diag = FloatingWidgetService.readLastOutcome(getContext());
            if (diag != null) {
                err = diag.optString("error", null);
                shown = diag.optBoolean("shown", false);
            }
        }
        if (!shown && err != null) {
            android.util.Log.e("NativeKitWidget", "floating overlay reported failure: " + err);
        }
        JSObject result = new JSObject();
        result.put("running", FloatingWidgetService.isRunning());
        result.put("shown", shown);
        if (err != null) result.put("error", err);
        call.resolve(result);
    }

    @PluginMethod
    public void hideFloating(PluginCall call) {
        getContext().stopService(new Intent(getContext(), FloatingWidgetService.class));
        JSObject result = new JSObject();
        result.put("visible", false);
        call.resolve(result);
    }

    @PluginMethod
    public void isFloatingVisible(PluginCall call) {
        JSObject result = new JSObject();
        result.put("visible", FloatingWidgetService.isShown());
        if (FloatingWidgetService.getLastError() != null) result.put("error", FloatingWidgetService.getLastError());
        call.resolve(result);
    }

    @PluginMethod
    public void updateFloating(PluginCall call) {
        // Live-update the floating overlay's layout/behavior/chrome/html without restarting the
        // service or rebuilding the WebView. The given options are deep-merged over the previously
        // stored "floating" config, so callers only need to pass the fields they change.
        try {
            JSObject patch = call.getData();
            WidgetStore store = new WidgetStore(getContext());
            JSONObject current = store.getConfig("floating");
            if (current == null) current = new JSONObject();
            mergeJSON(current, patch);
            store.setConfig("floating", current);

            Intent command = new Intent(ACTION_FLOATING_COMMAND);
            command.setPackage(getContext().getPackageName());
            command.putExtra("cmd", "update");
            getContext().sendBroadcast(command);

            boolean running = FloatingWidgetService.isRunning();
            boolean shown = FloatingWidgetService.isShown();
            JSObject result = new JSObject();
            result.put("delivered", running && shown);
            result.put("running", running);
            result.put("shown", shown);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("updateFloating failed", error);
        }
    }

    @PluginMethod
    public void runFloatingJavascript(PluginCall call) {
        String script = call.getString("script");
        if (script == null || script.isEmpty()) {
            call.reject("script is required");
            return;
        }
        Intent command = new Intent(ACTION_FLOATING_COMMAND);
        command.setPackage(getContext().getPackageName());
        command.putExtra("cmd", "js");
        command.putExtra("script", script);
        getContext().sendBroadcast(command);
        boolean shown = FloatingWidgetService.isShown();
        JSObject result = new JSObject();
        result.put("delivered", shown);
        result.put("running", FloatingWidgetService.isRunning());
        call.resolve(result);
    }

    @PluginMethod
    public void sendToFloating(PluginCall call) {
        // Capacitor 8 PluginCall has no get(String); read the whole call and pull "data".
        Object data = call.getData().opt("data");
        if (data == null) data = "";
        Intent command = new Intent(ACTION_FLOATING_COMMAND);
        command.setPackage(getContext().getPackageName());
        command.putExtra("cmd", "send");
        command.putExtra("data", data.toString());
        getContext().sendBroadcast(command);
        // Report whether the command was actually delivered to a live, on-screen bubble. Previously
        // sendToFloating always resolved (nothing) even when no bubble was running, so a developer
        // pushing data saw a silent success. Now they get the real state.
        JSObject result = new JSObject();
        boolean shown = FloatingWidgetService.isShown();
        result.put("delivered", shown);
        result.put("running", FloatingWidgetService.isRunning());
        result.put("shown", shown);
        call.resolve(result);
    }

    // -- Helpers ----------------------------------------------------------------

    /** Deep-merge a patch JSONObject into a target JSONObject (nested objects merge recursively). */
    private static void mergeJSON(JSONObject target, JSONObject patch) throws JSONException {
        if (target == null || patch == null) return;
        @SuppressWarnings("unchecked")
        java.util.Iterator<String> keys = patch.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = patch.opt(key);
            if (value instanceof JSONObject) {
                JSONObject nested = target.optJSONObject(key);
                if (nested == null) nested = new JSONObject();
                target.put(key, nested);
                mergeJSON(nested, (JSONObject) value);
            } else {
                target.put(key, value);
            }
        }
    }

    private ComponentName providerComponent(String kind) {
        String pkg = getContext().getPackageName();
        return new ComponentName(pkg, pkg + ".Widget_" + sanitizeKind(kind));
    }

    /**
     * Sends the standard APPWIDGET_UPDATE broadcast to the given kind's provider so that
     * every live instance re-renders. Returns the number of live widget instances.
     */
    private int requestUpdate(String kind) {
        AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
        ComponentName component = providerComponent(kind);
        int[] ids = manager.getAppWidgetIds(component);
        if (ids.length == 0) return 0;
        Intent update = new Intent(getContext(), providerClass(kind));
        update.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        update.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        getContext().sendBroadcast(update);
        return ids.length;
    }

    private Class<?> providerClass(String kind) {
        try {
            return Class.forName(providerComponent(kind).getClassName());
        } catch (Exception ignored) {
            return NativeKitWidgetProvider.class;
        }
    }

    static String sanitizeKind(String kind) {
        if (kind == null) return "W";
        String cleaned = kind.replaceAll("[^A-Za-z0-9_]", "_");
        if (cleaned.isEmpty()) cleaned = "W";
        if (Character.isDigit(cleaned.charAt(0))) cleaned = "N" + cleaned;
        return cleaned;
    }
}
