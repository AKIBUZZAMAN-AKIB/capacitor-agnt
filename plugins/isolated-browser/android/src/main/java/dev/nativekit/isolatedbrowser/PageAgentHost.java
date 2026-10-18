package dev.nativekit.isolatedbrowser;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Host-side plumbing for the vendored PageAgent bundle (assets/pageagent/).
 *
 * Injects config + bundle + bootstrap at document start and exposes the
 * "NativeKitPageAgent" WebMessageListener channel the bootstrap relays model
 * calls through. Every relayed call is answered by THIS class performing the
 * HTTP POST itself on a worker thread — the page never touches the network for
 * the LLM, so page CSP cannot break the agent and no provider secret is ever
 * exposed to page JavaScript.
 *
 * Hard security properties:
 *  - The endpoint is a compile-time constant (the app's free anonymous route).
 *    Neither the page nor the launching config can redirect it elsewhere.
 *  - Every relay message must carry this session's token (embedded only in the
 *    document-start config script, same trust boundary as the existing
 *    NativeKit transport).
 *  - Only main-frame messages are honoured, and usage is capped per session.
 */
public final class PageAgentHost {
    public static final String JS_OBJECT = "NativeKitPageAgent";
    static final String EXTRA_ENABLED = "pageAgentEnabled";
    static final String EXTRA_LANGUAGE = "pageAgentLanguage";

    private static final String BUNDLE_ASSET = "pageagent/page-agent.iife.js";
    private static final String BOOTSTRAP_ASSET = "pageagent/bootstrap.js";
    // The free anonymous OpenAI-compatible route the whole app already uses.
    private static final String LLM_ENDPOINT = "https://api.kilo.ai/api/gateway/chat/completions";
    private static final String LLM_BASE_URL = "https://api.kilo.ai/api/gateway";
    private static final String LLM_MODEL = "kilo-auto/free";
    private static final int MAX_CALLS_DEFAULT = 60;
    private static final int MAX_REQUEST_CHARS = 2_000_000;
    private static final int MAX_RESPONSE_CHARS = 2_000_000;

    private static volatile String cachedInjection;
    // One shared worker for the whole process keeps relay calls serialized.
    private static final ExecutorService NETWORK = Executors.newSingleThreadExecutor(
        runnable -> {
            Thread thread = new Thread(runnable, "nativekit-page-agent-relay");
            thread.setDaemon(true);
            return thread;
        });

    private final Handler main = new Handler(Looper.getMainLooper());
    private final String token = UUID.randomUUID().toString();
    private final int maxCalls;
    private int calls;
    private boolean installed;

    private PageAgentHost(int maxCalls) {
        this.maxCalls = maxCalls;
    }

    public static boolean supported() {
        return Build.VERSION.SDK_INT >= 28
            && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
    }

    /**
     * Injects the vendored PageAgent bundle and installs the LLM relay on the
     * given WebView. Returns null (and injects nothing) when disabled or
     * unsupported — callers treat that as a no-op.
     */
    public static PageAgentHost install(WebView webView, Context context, boolean enabled, String language) {
        if (webView == null || !enabled || !supported()) return null;
        try {
            String injection = cachedInjection(context);
            if (injection == null) return null;
            PageAgentHost host = new PageAgentHost(MAX_CALLS_DEFAULT);
            JSONObject cfg = new JSONObject();
            cfg.put("bridge", JS_OBJECT);
            cfg.put("token", host.token);
            cfg.put("baseURL", LLM_BASE_URL);
            cfg.put("model", LLM_MODEL);
            cfg.put("language", language == null || language.isEmpty() ? "en-US" : language);
            cfg.put("autoShow", true);
            String configScript = "window.__NATIVEKIT_PAGE_AGENT__=" + cfg.toString() + ";";
            // Origin rules "*" is safe here: the relay additionally requires the
            // main frame, the per-session token, the fixed endpoint and the call
            // cap — and letting it follow all navigations/redirects is exactly
            // what a browsing surface needs.
            WebViewCompat.addDocumentStartJavaScript(
                webView, configScript + injection, Collections.singleton("*"));
            WebViewCompat.addWebMessageListener(
                webView, JS_OBJECT, Collections.singleton("*"), host::onPageMessage);
            host.installed = true;
            return host;
        } catch (Throwable error) {
            return null;
        }
    }

    private void onPageMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin, boolean isMainFrame, @NonNull JavaScriptReplyProxy proxy) {
        if (!installed || !isMainFrame) return;
        String data = message.getData();
        if (data == null || data.length() > MAX_REQUEST_CHARS) return;
        final String id;
        final String body;
        try {
            JSONObject request = new JSONObject(data);
            if (request.optInt("v", 0) != 1 || !"llm".equals(request.optString("kind"))) return;
            if (!constantTimeEquals(token, request.optString("token"))) {
                reply(proxy, errorResponse(request.optString("id"), "unauthorized"));
                return;
            }
            if (!LLM_ENDPOINT.equals(request.optString("url"))) {
                reply(proxy, errorResponse(request.optString("id"), "endpoint not allowed"));
                return;
            }
            id = request.optString("id", "");
            body = request.optString("body", "");
            if (id.isEmpty() || body.isEmpty() || body.length() > MAX_REQUEST_CHARS) {
                reply(proxy, errorResponse(id, "invalid request"));
                return;
            }
        } catch (Throwable error) {
            return;
        }
        if (calls >= maxCalls) {
            reply(proxy, errorResponse(id, "page agent call cap reached for this session"));
            return;
        }
        calls += 1;
        NETWORK.execute(() -> relay(id, body, proxy));
    }

    private void relay(String id, String body, JavaScriptReplyProxy proxy) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(LLM_ENDPOINT).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(120_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            InputStream stream = status / 100 == 2 ? connection.getInputStream() : connection.getErrorStream();
            String text = readCapped(stream);
            JSONObject response = new JSONObject();
            response.put("v", 1);
            response.put("kind", "llm-resp");
            response.put("id", id);
            response.put("ok", true);
            response.put("status", status);
            response.put("body", text);
            reply(proxy, response.toString());
        } catch (Throwable error) {
            reply(proxy, errorResponse(id, error.getMessage() == null ? "relay failed" : error.getMessage()));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readCapped(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[16_384];
        int read;
        int total = 0;
        while ((read = stream.read(chunk)) != -1) {
            total += read;
            if (total > MAX_RESPONSE_CHARS) throw new IllegalStateException("LLM response exceeds the relay cap");
            buffer.write(chunk, 0, read);
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String errorResponse(String id, String message) {
        try {
            JSONObject response = new JSONObject();
            response.put("v", 1);
            response.put("kind", "llm-resp");
            response.put("id", id == null ? "" : id);
            response.put("ok", false);
            response.put("error", message);
            return response.toString();
        } catch (Throwable error) {
            return "{\"v\":1,\"kind\":\"llm-resp\",\"ok\":false,\"error\":\"relay failed\"}";
        }
    }

    private void reply(JavaScriptReplyProxy proxy, String payload) {
        main.post(() -> {
            try { proxy.postMessage(payload); } catch (Throwable ignored) {}
        });
    }

    private static String cachedInjection(Context context) {
        String cached = cachedInjection;
        if (cached != null) return cached;
        try {
            String bundle = readAsset(context, BUNDLE_ASSET);
            String bootstrap = readAsset(context, BOOTSTRAP_ASSET);
            if (bundle == null || bootstrap == null) return null;
            cached = bundle + "\n" + bootstrap;
            cachedInjection = cached;
            return cached;
        } catch (Throwable error) {
            return null;
        }
    }

    private static String readAsset(Context context, String name) {
        try (InputStream stream = context.getAssets().open(name)) {
            return readCapped(stream) + "\n";
        } catch (Throwable error) {
            return null;
        }
    }

    private static boolean constantTimeEquals(String left, String right) {
        if (left == null || right == null) return false;
        int difference = left.length() ^ right.length();
        int maximum = Math.max(left.length(), right.length());
        for (int index = 0; index < maximum; index++) {
            char a = index < left.length() ? left.charAt(index) : 0;
            char b = index < right.length() ? right.charAt(index) : 0;
            difference |= a ^ b;
        }
        return difference == 0;
    }
}
