package dev.nativekit.isolatedbrowser;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
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
 *  - Only main-frame messages are honoured, and LLM usage is capped per session
 *    (state/history mirroring never counts toward that cap).
 *  - The session store (task/status/compact history) is in-memory per host and
 *    only ever flows back to pages of this same WebView session.
 */
public final class PageAgentHost {
    public static final String JS_OBJECT = "NativeKitPageAgent";
    private static final String TAG = "NativeKitPageAgent";
    static final String EXTRA_ENABLED = "pageAgentEnabled";
    static final String EXTRA_LANGUAGE = "pageAgentLanguage";

    private static final String BUNDLE_ASSET = "pageagent/page-agent.iife.js";
    private static final String BOOTSTRAP_ASSET = "pageagent/bootstrap.js";
    // MUST run before the bundle: sites enforcing Trusted Types (YouTube,
    // Google sign-in) throw on the bundle's innerHTML panel building unless
    // this shim wraps the HTML sinks first.
    private static final String TT_SHIM_ASSET = "pageagent/tt-shim.js";
    // The free anonymous OpenAI-compatible route the whole app already uses.
    private static final String LLM_ENDPOINT = "https://api.kilo.ai/api/gateway/chat/completions";
    private static final String LLM_BASE_URL = "https://api.kilo.ai/api/gateway";
    private static final String LLM_MODEL = "kilo-auto/free";
    private static final int MAX_CALLS_DEFAULT = 60;
    private static final int MAX_REQUEST_CHARS = 2_000_000;
    private static final int MAX_RESPONSE_CHARS = 2_000_000;
    private static final int MAX_HISTORY_CHARS = 131_072;

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
    // Session continuity store: the page (and the agent UI living in it) dies
    // on every real navigation — this host does not. The page mirrors
    // {task, status, compact history} here as a run progresses, and the next
    // page asks it back to resume in-flight work. See bootstrap.js.
    private String sessionTask;
    private String sessionStatus;
    private String sessionHistory;

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
        final String kind;
        try {
            JSONObject request = new JSONObject(data);
            if (request.optInt("v", 0) != 1) return;
            kind = request.optString("kind", "");
            if (!constantTimeEquals(token, request.optString("token"))) return;
            if ("llm".equals(kind)) {
                handleLlm(request, proxy);
            } else if ("state".equals(kind)) {
                handleState(request);
            } else if ("history".equals(kind)) {
                handleHistory(request);
            } else if ("restore".equals(kind)) {
                handleRestore(proxy);
            }
        } catch (Throwable error) {
            return;
        }
    }

    private void handleLlm(JSONObject request, JavaScriptReplyProxy proxy) {
        if (!LLM_ENDPOINT.equals(request.optString("url"))) {
            reply(proxy, errorResponse(request.optString("id"), "endpoint not allowed"));
            return;
        }
        final String id = request.optString("id", "");
        final String body = request.optString("body", "");
        if (id.isEmpty() || body.isEmpty() || body.length() > MAX_REQUEST_CHARS) {
            reply(proxy, errorResponse(id, "invalid request"));
            return;
        }
        if (calls >= maxCalls) {
            reply(proxy, errorResponse(id, "page agent call cap reached for this session"));
            return;
        }
        calls += 1;
        NETWORK.execute(() -> relay(id, body, proxy));
    }

    // Mirrors the in-page agent's task/status so the next page can resume.
    // Not an LLM call: it never counts toward the call cap.
    private void handleState(JSONObject request) {
        String task = request.optString("task", null);
        if (task != null) sessionTask = task.length() > 2000 ? task.substring(0, 2000) : task;
        String status = request.optString("status", null);
        if (status != null) sessionStatus = status.length() > 40 ? status.substring(0, 40) : status;
    }

    private void handleHistory(JSONObject request) {
        String body = request.optString("body", "");
        if (body.isEmpty()) return;
        sessionHistory = body.length() > MAX_HISTORY_CHARS ? body.substring(0, MAX_HISTORY_CHARS) : body;
    }

    private void handleRestore(JavaScriptReplyProxy proxy) {
        try {
            JSONObject response = new JSONObject();
            response.put("v", 1);
            response.put("kind", "state-resp");
            response.put("task", sessionTask == null ? "" : sessionTask);
            response.put("status", sessionStatus == null ? "" : sessionStatus);
            response.put("history", sessionHistory == null ? "" : sessionHistory);
            reply(proxy, response.toString());
        } catch (Throwable error) {
            reply(proxy, errorResponse("", "restore failed"));
        }
    }

    private void relay(String id, String body, JavaScriptReplyProxy proxy) {
        try {
            String currentBody = body;
            PostResult result = null;
            int attempts = 0;
            final int maxAttempts = 4; // 1 initial + 3 retries
            final long[] backoffs = {0L, 300L, 900L, 2000L};

            while (true) {
                attempts++;
                if (attempts > 1) {
                    long delay = attempts - 1 < backoffs.length ? backoffs[attempts - 1] : 2000L;
                    try { Thread.sleep(delay); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                }

                PostResult attemptResult = post(currentBody);
                result = attemptResult;

                if (attemptResult.status / 100 == 2) {
                    replyOk(proxy, id, attemptResult.status, attemptResult.text);
                    return;
                }

                // First 400 -> try sanitized wire-filter
                if (attempts == 1 && attemptResult.status == 400) {
                    String sanitized = sanitizeRequest(currentBody);
                    if (sanitized != null && !sanitized.equals(currentBody)) {
                        Log.i(TAG, "wire-filter sanitized request (attempt 1 -> 2), retrying");
                        currentBody = sanitized;
                        PostResult second = post(currentBody);
                        attempts++;
                        result = second;
                        if (second.status / 100 == 2) {
                            replyOk(proxy, id, second.status, second.text);
                            return;
                        }
                        // fall through to retryable check with sanitized body
                    }
                }

                if (attempts >= maxAttempts || !isRetryable(result.status, result.text)) {
                    break;
                }

                Log.w(TAG, "retryable gateway error HTTP " + result.status + " attempt " + attempts + "/" + maxAttempts + ": " + snippet(result.text, 400) + " -> retrying same body");
            }

            // All attempts failed -> surface full diagnostics
            Log.w(TAG, "free route HTTP " + (result != null ? result.status : -1) + " after " + attempts + " attempts: " + snippet(result != null ? result.text : "", 600));
            String wrapped = wrapGatewayErrorWithDiagnostics(result != null ? result.status : 0, result != null ? result.text : "", attempts);
            replyOk(proxy, id, result != null ? result.status : 400, wrapped);
        } catch (Throwable error) {
            reply(proxy, errorResponse(id, error.getMessage() == null ? "relay failed" : error.getMessage()));
        }
    }

    private static final class PostResult {

        final int status;
        final String text;
        PostResult(int status, String text) {
            this.status = status;
            this.text = text;
        }
    }

    private PostResult post(String body) throws Exception {
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
            return new PostResult(status, readCapped(stream));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Mirrors what the bundle's modelPatch does for other providers: relax the
     *  strict tool-calling fields the kilo free pool tends to reject.
     *  Now expanded to a full wire-filter for AtlasCloud and other free providers. */
    private static String adaptRequest(String body) {
        return sanitizeRequest(body);
    }

    private static boolean isRetryable(int status, String body) {
        if (status == 429) return true;
        if (status >= 500 && status < 600) return true;
        if (status == 400 && body != null) {
            String lower = body.toLowerCase();
            // Kilo free-pool transient: gateway wraps provider error
            if (lower.contains("upstream_error")) return true;
            if (lower.contains("provider returned error")) return true;
            if (lower.contains("bad request")) return true;
            if (lower.contains("invalid request params")) return true;
            if (lower.contains("rate limit")) return true;
            if (lower.contains("temporarily unavailable")) return true;
            if (lower.contains("overloaded")) return true;
        }
        return false;
    }

    private static String sanitizeRequest(String body) {
        try {
            org.json.JSONObject request = new org.json.JSONObject(body);
            boolean changed = false;

            // --- top-level disallowed fields (Kilo docs only allow model,messages,tools,tool_choice,response_format,user,seed,stream) ---
            String[] disallowed = new String[]{
                "parallel_tool_calls",
                "thinking",
                "enable_thinking",
                "reasoning",
                "reasoning_effort",
                "verbosity",
                "temperature",
                "top_p",
                "top_k",
                "top_logprobs",
                "logprobs",
                "logit_bias",
                "store",
                "metadata",
                "safety_identifier",
                "prompt_cache_key",
                "max_tokens",
                "max_completion_tokens",
                "n",
                "presence_penalty",
                "frequency_penalty",
                "stop",
                "stream_options",
                "service_tier",
                "seed" // keep? kilo docs allow seed, but some providers reject it - remove to be safe
            };
            for (String key : disallowed) {
                if (request.has(key)) {
                    request.remove(key);
                    changed = true;
                }
            }
            // Remove any key starting with reasoning_ or thinking_
            java.util.Iterator<String> keys = request.keys();
            java.util.List<String> toRemove = new java.util.ArrayList<>();
            while (keys.hasNext()) {
                String k = keys.next();
                if (k.startsWith("reasoning_") || k.startsWith("thinking_")) {
                    toRemove.add(k);
                }
            }
            for (String k : toRemove) {
                request.remove(k);
                changed = true;
            }

            // --- model must be kilo-auto/free ---
            if (request.has("model")) {
                String m = request.optString("model", "");
                if (!LLM_MODEL.equals(m)) {
                    request.put("model", LLM_MODEL);
                    changed = true;
                }
            }

            // --- tool_choice: required or object -> auto (AtlasCloud does not support required/named) ---
            if (request.has("tool_choice")) {
                Object tc = request.opt("tool_choice");
                if (tc instanceof String) {
                    String s = (String) tc;
                    if ("required".equals(s) || s.contains("function")) {
                        request.put("tool_choice", "auto");
                        changed = true;
                    }
                } else if (tc instanceof org.json.JSONObject) {
                    // named tool choice -> auto for free pool compatibility
                    request.put("tool_choice", "auto");
                    changed = true;
                }
            }

            // --- response_format: remove if json_schema (many free providers reject) ---
            if (request.has("response_format")) {
                try {
                    Object rf = request.opt("response_format");
                    if (rf instanceof org.json.JSONObject) {
                        org.json.JSONObject rfo = (org.json.JSONObject) rf;
                        String type = rfo.optString("type", "");
                        if (type.contains("json_schema") || rfo.has("json_schema")) {
                            request.remove("response_format");
                            changed = true;
                        }
                    }
                } catch (Throwable ignored) {
                    request.remove("response_format");
                    changed = true;
                }
            }

            // --- tools: strip strict and unsupported fields ---
            if (request.has("tools")) {
                try {
                    org.json.JSONArray tools = request.optJSONArray("tools");
                    if (tools != null) {
                        for (int i = 0; i < tools.length(); i++) {
                            org.json.JSONObject tool = tools.optJSONObject(i);
                            if (tool == null) continue;
                            if (tool.has("function")) {
                                org.json.JSONObject func = tool.optJSONObject("function");
                                if (func != null) {
                                    if (func.has("strict")) {
                                        func.remove("strict");
                                        changed = true;
                                    }
                                    // remove additionalProperties that some providers reject if not boolean
                                    // keep only name, description, parameters
                                    // parameters should be valid JSON schema
                                }
                            }
                        }
                    }
                } catch (Throwable ignored) {}
            }

            // --- messages: sanitize name field (AtlasCloud validates ^[a-zA-Z0-9_-]{1,64}$) ---
            if (request.has("messages")) {
                try {
                    org.json.JSONArray msgs = request.optJSONArray("messages");
                    if (msgs != null) {
                        for (int i = 0; i < msgs.length(); i++) {
                            org.json.JSONObject msg = msgs.optJSONObject(i);
                            if (msg == null) continue;
                            if (msg.has("name")) {
                                String name = msg.optString("name", "");
                                if (!name.matches("^[a-zA-Z0-9_-]{1,64}$")) {
                                    msg.remove("name");
                                    changed = true;
                                }
                            }
                            // remove disallowed message fields like cache_control, etc.
                            if (msg.has("cache_control")) { msg.remove("cache_control"); changed = true; }
                        }
                    }
                } catch (Throwable ignored) {}
            }

            return changed ? request.toString() : null;
        } catch (Throwable error) {
            return null;
        }
    }

    private static String wrapGatewayErrorWithDiagnostics(int status, String rawBody, int attempts) {
        try {
            String provider = "unknown";
            String requestId = "";
            String msg = "";
            String rawSnippet = snippet(rawBody, 600);
            try {
                org.json.JSONObject root = new org.json.JSONObject(rawBody);
                if (root.has("error")) {
                    org.json.JSONObject err = root.optJSONObject("error");
                    if (err != null) {
                        msg = err.optString("message", "");
                        if (err.has("metadata")) {
                            org.json.JSONObject meta = err.optJSONObject("metadata");
                            if (meta != null) {
                                provider = meta.optString("provider_name", provider);
                                String raw = meta.optString("raw", "");
                                requestId = meta.optString("request_id", "");
                                if (raw.isEmpty()) raw = meta.optString("raw", "");
                                // try parse raw as JSON for inner code/msg
                                try {
                                    org.json.JSONObject inner = new org.json.JSONObject(raw);
                                    String innerMsg = inner.optString("msg", "");
                                    String innerCode = inner.optString("code", "");
                                    if (!innerMsg.isEmpty()) msg = msg + " | inner: " + innerMsg + " (" + innerCode + ")";
                                    if (inner.has("request_id")) requestId = inner.optString("request_id", requestId);
                                } catch (Throwable ignored) {}
                                if (!raw.isEmpty()) rawSnippet = snippet(raw, 400);
                            }
                        }
                        if (err.has("code")) {
                            msg = msg + " [code " + err.opt("code") + "]";
                        }
                    }
                }
            } catch (Throwable ignored) {}

            StringBuilder detailed = new StringBuilder();
            detailed.append("gateway HTTP ").append(status).append(" after ").append(attempts).append(" attempts");
            if (!provider.equals("unknown")) detailed.append(" (provider ").append(provider).append(")");
            if (!requestId.isEmpty()) detailed.append(" [req ").append(requestId).append("]");
            detailed.append(": ").append(msg.isEmpty() ? rawSnippet : msg);
            detailed.append(" | wire-filter sanitized + retry with backoff applied");

            org.json.JSONObject wrapped = new org.json.JSONObject();
            wrapped.put("error", new org.json.JSONObject().put("message", detailed.toString()));
            return wrapped.toString();
        } catch (Throwable error) {
            return "{\"error\":{\"message\":\"gateway HTTP " + status + " after " + attempts + " attempts\"}}";
        }
    }


    private static String snippet(String text, int limit) {
        if (text == null) return "";
        String flat = text.replace('\n', ' ');
        return flat.length() > limit ? flat.substring(0, limit) : flat;
    }

    /** Rewrap a non-2xx gateway body so the in-page agent's error extraction
     *  (``HTTP <status>: <error.message>``) shows the real reason. */
    private static String wrapGatewayError(int status, String rawBody) {
        try {
            String message = "gateway HTTP " + status + ": " + snippet(rawBody, 400);
            JSONObject wrapped = new JSONObject();
            wrapped.put("error", new JSONObject().put("message", message));
            return wrapped.toString();
        } catch (Throwable error) {
            return "{\"error\":{\"message\":\"gateway HTTP " + status + "\"}}";
        }
    }

    private void replyOk(JavaScriptReplyProxy proxy, String id, int status, String text) {
        try {
            JSONObject response = new JSONObject();
            response.put("v", 1);
            response.put("kind", "llm-resp");
            response.put("id", id);
            response.put("ok", true);
            response.put("status", status);
            response.put("body", text);
            reply(proxy, response.toString());
        } catch (Throwable error) {
            // fall through: the page times out and retries on its own
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
            String shim = readAsset(context, TT_SHIM_ASSET);
            cached = (shim == null ? "" : shim + "\n") + bundle + "\n" + bootstrap;
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
