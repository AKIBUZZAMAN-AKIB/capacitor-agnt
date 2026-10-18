package dev.nativekit.isolatedbrowser;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;

import androidx.webkit.WebViewFeature;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NativeKitIsolatedBrowser")
public final class NativeKitIsolatedBrowserPlugin extends Plugin implements IsolatedBrowserBrokerService.Listener {
    private volatile String activeSessionId;
    private volatile String activeRemoteSessionId;

    @Override public void load() {
        IsolatedBrowserBrokerService.setListener(this);
        // Pre-warm the isolated process (RAM permitting) so the first mini-app
        // launch skips the Chromium provider cold init.
        IsolatedBrowserWarmupService.warm(getContext());
    }

    @PluginMethod
    public void runtimeInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", Build.VERSION.SDK_INT >= 28);
        result.put("platform", "android");
        result.put("apiLevel", Build.VERSION.SDK_INT);
        result.put("persistentPartitions", true);
        result.put("profilePartitions", WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE));
        result.put("completeSiteDataDeletion", WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA));
        call.resolve(result);
    }

    @PluginMethod
    public void isStaged(PluginCall call) {
        try {
            String appId = required(call, "appId");
            String integrity = required(call, "integrity");
            JSObject result = new JSObject();
            result.put("staged", IsolatedAppStore.isStaged(getContext(), appId, integrity));
            call.resolve(result);
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void beginStage(PluginCall call) {
        try {
            String stageId = IsolatedAppStore.begin(
                getContext(),
                required(call, "appId"),
                required(call, "integrity"),
                required(call, "entry"),
                requiredInt(call, "fileCount"),
                requiredLong(call, "totalBytes")
            );
            JSObject result = new JSObject();
            result.put("stageId", stageId);
            call.resolve(result);
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void writeStageChunk(PluginCall call) {
        try {
            long bytesWritten = IsolatedAppStore.writeChunk(
                getContext(),
                required(call, "stageId"),
                required(call, "path"),
                requiredLong(call, "offset"),
                call.getString("data", ""),
                Boolean.TRUE.equals(call.getBoolean("final", false))
            );
            JSObject result = new JSObject();
            result.put("bytesWritten", bytesWritten);
            call.resolve(result);
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void commitStage(PluginCall call) {
        try {
            String host = IsolatedAppStore.commit(getContext(), required(call, "stageId"));
            JSObject result = new JSObject();
            result.put("origin", "https://" + host);
            call.resolve(result);
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void abortStage(PluginCall call) {
        try {
            IsolatedAppStore.abort(getContext(), required(call, "stageId"));
            call.resolve();
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void removeStagedApp(PluginCall call) {
        try {
            String appId = required(call, "appId");
            IsolatedAppStore.removeApp(getContext(), appId);
            if (Build.VERSION.SDK_INT < 28) {
                call.resolve();
                return;
            }
            AtomicBoolean completed = new AtomicBoolean(false);
            Handler handler = new Handler(Looper.getMainLooper());
            Runnable timeout = () -> {
                if (completed.compareAndSet(false, true)) call.reject("Timed out while deleting isolated browser data");
            };
            ResultReceiver receiver = new ResultReceiver(handler) {
                @Override protected void onReceiveResult(int resultCode, Bundle resultData) {
                    if (!completed.compareAndSet(false, true)) return;
                    handler.removeCallbacks(timeout);
                    if (resultCode == IsolatedStorageCleanupService.RESULT_OK) call.resolve();
                    else call.reject(resultData == null ? "Could not delete isolated browser data" : resultData.getString("error", "Could not delete isolated browser data"));
                }
            };
            Intent cleanup = new Intent(getContext(), IsolatedStorageCleanupService.class);
            cleanup.putExtra(IsolatedStorageCleanupService.EXTRA_APP_ID, appId);
            cleanup.putExtra(IsolatedStorageCleanupService.EXTRA_RESULT, receiver);
            getContext().startService(cleanup);
            handler.postDelayed(timeout, 20_000L);
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void open(PluginCall call) {
        if (Build.VERSION.SDK_INT < 28) {
            call.reject("Isolated Android WebView requires API 28 or newer");
            return;
        }
        try {
            String sessionId = required(call, "sessionId");
            String token = required(call, "token");
            String appId = required(call, "appId");
            String integrity = required(call, "integrity");
            String entry = required(call, "entry");
            if (!IsolatedAppStore.isStaged(getContext(), appId, integrity)) throw new IllegalStateException("App package is not staged");
            if (activeRemoteSessionId != null || (activeSessionId != null && !activeSessionId.equals(sessionId))) throw new IllegalStateException("Another isolated browser session is already open");
            String rendererToken = UUID.randomUUID().toString();
            IsolatedBrowserBrokerService.registerSession(sessionId, appId, token, rendererToken);
            activeSessionId = sessionId;

            Intent intent = new Intent(getContext(), IsolatedBrowserActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            intent.putExtra(IsolatedBrowserActivity.EXTRA_SESSION_ID, sessionId);
            intent.putExtra(IsolatedBrowserActivity.EXTRA_TOKEN, token);
            intent.putExtra(IsolatedBrowserActivity.EXTRA_RENDERER_TOKEN, rendererToken);
            intent.putExtra(IsolatedBrowserActivity.EXTRA_APP_ID, appId);
            intent.putExtra(IsolatedBrowserActivity.EXTRA_TITLE, required(call, "title"));
            intent.putExtra(IsolatedBrowserActivity.EXTRA_INTEGRITY, integrity);
            intent.putExtra(IsolatedBrowserActivity.EXTRA_ENTRY, entry);
            intent.putExtra(IsolatedBrowserActivity.EXTRA_BOOTSTRAP, required(call, "bootstrap"));
            intent.putExtra(IsolatedBrowserActivity.EXTRA_ALLOWED_HOSTS, stringArray(call.getArray("allowedHosts")));
            intent.putExtra(IsolatedBrowserActivity.EXTRA_ALLOW_DIRECT_NETWORK, Boolean.TRUE.equals(call.getBoolean("allowDirectNetwork", false)));
            intent.putExtra(IsolatedBrowserActivity.EXTRA_NETWORK_MODE, call.getString("networkMode", ""));
            intent.putExtra(IsolatedBrowserActivity.EXTRA_COLOR_SCHEME, call.getString("colorScheme", "dark"));
            intent.putExtra(IsolatedBrowserActivity.EXTRA_MEDIA_AUTOPLAY, Boolean.TRUE.equals(call.getBoolean("mediaAutoplay", false)));
            intent.putExtra(IsolatedBrowserActivity.EXTRA_HANG_DELAY, requiredLong(call, "hangTerminationDelayMs"));
            getContext().startActivity(intent);
            // Kill-protect the host process while the mini app is in front —
            // without this, low-RAM devices cold-restart the agent app on close.
            IsolatedSessionKeepAliveService.start(getContext());
            JSObject result = new JSObject();
            result.put("origin", "https://" + IsolatedAppStore.originHost(appId));
            call.resolve(result);
        } catch (Exception error) {
            String sessionId = call.getString("sessionId", "");
            if (!sessionId.isEmpty()) IsolatedBrowserBrokerService.unregisterSession(sessionId, false);
            if (sessionId.equals(activeSessionId)) activeSessionId = null;
            call.reject(message(error), error);
        }
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        try {
            String sessionId = required(call, "sessionId");
            if (!sessionId.equals(activeSessionId)) throw new IllegalStateException("The isolated app session is not active");
            String requestId = required(call, "requestId");
            String appName = required(call, "appName");
            String capability = required(call, "capability");
            String method = required(call, "method");
            String argumentSummary = call.getString("argumentSummary", "");
            long timeoutMs = requiredLong(call, "timeoutMs");
            boolean shown = IsolatedBrowserBrokerService.requestPermission(
                sessionId, requestId, appName, capability, method, argumentSummary, timeoutMs,
                (action, error) -> {
                    if (error != null) {
                        call.reject(error);
                        return;
                    }
                    JSObject result = new JSObject();
                    result.put("shown", true);
                    result.put("action", action);
                    call.resolve(result);
                }
            );
            if (!shown) call.reject("Trusted permission UI is unavailable for this isolated session");
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void dismissPermission(PluginCall call) {
        try {
            String sessionId = required(call, "sessionId");
            String requestId = required(call, "requestId");
            if (!sessionId.equals(activeSessionId)) { call.resolve(); return; }
            IsolatedBrowserBrokerService.dismissPermission(sessionId, requestId);
            call.resolve();
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        if (Build.VERSION.SDK_INT < 28) { call.reject("Browser-only isolated Android WebView requires API 28 or newer"); return; }
        try {
            if (activeSessionId != null || activeRemoteSessionId != null) throw new IllegalStateException("Another isolated browser session is already open");
            String sessionId = required(call, "sessionId");
            String url = required(call, "url");
            android.net.Uri parsed = android.net.Uri.parse(url);
            if (!"https".equalsIgnoreCase(parsed.getScheme()) || parsed.getHost() == null || parsed.getUserInfo() != null) throw new IllegalArgumentException("Remote URL mode accepts HTTPS URLs without embedded credentials only");
            String title = call.getString("title", parsed.getHost());
            String[] allowedHosts = stringArray(call.getArray("allowedHosts"));
            ResultReceiver receiver = new ResultReceiver(new Handler(Looper.getMainLooper())) {
                @Override protected void onReceiveResult(int resultCode, Bundle data) {
                    String state = data == null ? "unknown" : data.getString("state", "unknown");
                    JSObject event = new JSObject();
                    event.put("sessionId", sessionId);
                    event.put("state", state);
                    event.put("reason", data == null ? "" : data.getString("reason", ""));
                    notifyListeners("remoteBrowserStatus", event, true);
                    if (("closed".equals(state) || "failed".equals(state)) && sessionId.equals(activeRemoteSessionId)) {
                        activeRemoteSessionId = null;
                        endSessionHousekeeping();
                    }
                }
            };
            Intent intent = new Intent(getContext(), RemoteBrowserActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            intent.putExtra(RemoteBrowserActivity.EXTRA_SESSION_ID, sessionId);
            intent.putExtra(RemoteBrowserActivity.EXTRA_URL, url);
            intent.putExtra(RemoteBrowserActivity.EXTRA_TITLE, title);
            intent.putExtra(RemoteBrowserActivity.EXTRA_ALLOWED_HOSTS, allowedHosts);
            intent.putExtra(RemoteBrowserActivity.EXTRA_RESULT, receiver);
            activeRemoteSessionId = sessionId;
            getContext().startActivity(intent);
            IsolatedSessionKeepAliveService.start(getContext());
            JSObject result = new JSObject(); result.put("sessionId", sessionId); call.resolve(result);
        } catch (Exception error) { activeRemoteSessionId = null; call.reject(message(error), error); }
    }

    @PluginMethod
    public void closeUrl(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        if (!sessionId.isEmpty() && sessionId.equals(activeRemoteSessionId)) {
            Intent intent = new Intent(getContext(), RemoteBrowserActivity.class);
            intent.setAction(RemoteBrowserActivity.ACTION_CLOSE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            intent.putExtra(RemoteBrowserActivity.EXTRA_SESSION_ID, sessionId);
            getContext().startActivity(intent);
            activeRemoteSessionId = null;
            endSessionHousekeeping();
        }
        call.resolve();
    }

    @PluginMethod
    public void postMessage(PluginCall call) {
        try {
            String sessionId = required(call, "sessionId");
            String message = required(call, "message");
            if (!IsolatedBrowserBrokerService.deliver(sessionId, message)) throw new IllegalStateException("Isolated renderer response channel is unavailable");
            call.resolve();
        } catch (Exception error) { call.reject(message(error), error); }
    }

    @PluginMethod
    public void close(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        if (!sessionId.isEmpty()) IsolatedBrowserBrokerService.unregisterSession(sessionId, true);
        if (sessionId.equals(activeSessionId)) activeSessionId = null;
        endSessionHousekeeping();
        call.resolve();
    }

    @Override public void onRequest(String sessionId, String appId, String token, String origin, String request) {
        JSObject event = new JSObject();
        event.put("sessionId", sessionId);
        event.put("appId", appId);
        event.put("token", token);
        event.put("origin", origin);
        event.put("request", request);
        notifyListeners("isolatedBrowserRequest", event, true);
    }

    @Override public void onStatus(String sessionId, String appId, String state, String reason) {
        JSObject event = new JSObject();
        event.put("sessionId", sessionId);
        event.put("appId", appId);
        event.put("state", state);
        event.put("reason", reason);
        notifyListeners("isolatedBrowserStatus", event, true);
        if ("closed".equals(state)) {
            IsolatedBrowserBrokerService.unregisterSession(sessionId, false);
            if (sessionId.equals(activeSessionId)) activeSessionId = null;
            endSessionHousekeeping();
        }
    }

    // Session over: release the kill-protection and (RAM permitting) pre-warm the
    // isolated process again so the NEXT open is warm too.
    private void endSessionHousekeeping() {
        IsolatedSessionKeepAliveService.stop(getContext());
        IsolatedBrowserWarmupService.warm(getContext());
    }

    @Override protected void handleOnDestroy() {
        IsolatedBrowserBrokerService.setListener(null);
        super.handleOnDestroy();
    }

    private static String required(PluginCall call, String key) {
        String value = call.getString(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing " + key);
        return value;
    }

    private static int requiredInt(PluginCall call, String key) {
        Integer value = call.getInt(key);
        if (value == null) throw new IllegalArgumentException("Missing " + key);
        return value;
    }

    private static long requiredLong(PluginCall call, String key) {
        Object value = call.getData().opt(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException("Missing " + key);
        return ((Number) value).longValue();
    }

    private static String[] stringArray(JSArray input) throws Exception {
        if (input == null) return new String[0];
        List<String> result = new ArrayList<>();
        for (int index = 0; index < input.length(); index++) result.add(input.getString(index));
        return result.toArray(new String[0]);
    }

    private static String message(Exception error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }
}
