package dev.nativekit.isolatedbrowser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ResultReceiver;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Browser-only HTTPS surface. It intentionally has no NativeKit script, message listener, or broker binding. */
public final class RemoteBrowserActivity extends Activity {
    static final String EXTRA_SESSION_ID = "sessionId";
    static final String EXTRA_URL = "url";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_ALLOWED_HOSTS = "allowedHosts";
    static final String EXTRA_RESULT = "result";
    static final String ACTION_CLOSE = "dev.nativekit.isolatedbrowser.CLOSE_REMOTE";

    private static final Pattern HOST_RULE = Pattern.compile("^(?:\\*\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::(?:[1-9][0-9]{0,4}))?$");
    private String sessionId;
    private ResultReceiver resultReceiver;
    private WebView webView;
    private FrameLayout content;
    // PageAgent host (null when disabled/unsupported): injects the vendored
    // in-page agent and relays its LLM calls through the free route.
    private PageAgentHost pageAgent;
    // Loading cover until the first committed frame + a slim network progress bar
    // (remote pages load over the network — the user must see it is progressing).
    private FrameLayout cover;
    private ProgressBar progress;
    private TextView shellTitle;
    private boolean shellBuilt;
    private boolean revealed;
    private Set<String> allowedHosts = Collections.emptySet();
    private boolean reported;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT < 28) { finish(); return; }
        try { WebView.setDataDirectorySuffix("nativekit-isolated-v1"); }
        catch (IllegalStateException ignored) { /* Shared only with this app's isolated-process browser surfaces. */ }
        // A real session is taking over this process: hand the warm-up WebView's
        // memory back immediately (the expensive provider init already happened).
        IsolatedBrowserWarmupService.releaseForSession();
        initialize(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ACTION_CLOSE.equals(intent.getAction()) && sessionId != null && sessionId.equals(intent.getStringExtra(EXTRA_SESSION_ID))) {
            finish();
            return;
        }
        report("closed", "replaced by another browser-only URL session");
        destroyWebView();
        initialize(intent);
    }

    private void initialize(Intent intent) {
        try {
            sessionId = required(intent, EXTRA_SESSION_ID);
            resultReceiver = intent.getParcelableExtra(EXTRA_RESULT);
            Uri start = validatedHttps(required(intent, EXTRA_URL));
            String[] configured = intent.getStringArrayExtra(EXTRA_ALLOWED_HOSTS);
            Set<String> rules = new HashSet<>();
            if (configured != null) for (String value : configured) rules.add(validateRule(value));
            if (rules.isEmpty()) rules.add(hostAndPort(start));
            allowedHosts = Collections.unmodifiableSet(rules);
            if (!isAllowed(start)) throw new IllegalArgumentException("Initial URL host is not allowed");
            buildShell(intent.getStringExtra(EXTRA_TITLE), start.getHost());
            createWebView(start.toString());
            report("opened", "");
        } catch (Exception error) {
            buildShell("Browser", "Browser");
            showFailure(error.getMessage() == null ? "Invalid HTTPS URL" : error.getMessage());
            report("failed", error.getMessage());
        }
    }

    private void buildShell(String configuredTitle, String fallbackTitle) {
        String title = configuredTitle == null || configuredTitle.trim().isEmpty() ? fallbackTitle : configuredTitle.trim();
        if (shellBuilt) {
            // Session swap (onNewIntent): reuse the shell — no setContentView flash.
            if (shellTitle != null) shellTitle.setText(title);
            return;
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(7, 17, 31));
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(10), dp(8), dp(8), dp(8));
        Button back = new Button(this);
        back.setText("Back");
        back.setOnClickListener(view -> { if (webView != null && webView.canGoBack()) webView.goBack(); });
        toolbar.addView(back, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(16);
        heading.setSingleLine(true);
        heading.setPadding(dp(10), 0, dp(10), 0);
        shellTitle = heading;
        toolbar.addView(heading, new LinearLayout.LayoutParams(0, dp(44), 1));
        Button close = new Button(this);
        close.setText("Close");
        close.setOnClickListener(view -> finish());
        toolbar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgress(0);
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        content = new FrameLayout(this);
        // Dark shell ground (matches the theme windowBackground): the whole
        // pre-paint journey is this color, never white.
        content.setBackgroundColor(Color.rgb(7, 17, 31));
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        shellBuilt = true;
        ImeInsetsHelper.apply(root);
    }

    // Dark branded loading cover layered ON TOP of the WebView until its first
    // committed frame; identical treatment to the mini-app surface.
    private void installCover() {
        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(Color.rgb(7, 17, 31));
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.addView(new ProgressBar(this), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView label = new TextView(this);
        label.setText("Loading page…");
        label.setTextColor(Color.rgb(148, 163, 184));
        label.setTextSize(14);
        label.setPadding(0, dp(14), 0, 0);
        box.addView(label, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        layout.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        cover = layout;
        if (content != null) {
            content.addView(layout, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
    }

    private void reveal() {
        if (revealed || isFinishing()) return;
        revealed = true;
        WebView view = webView;
        FrameLayout loadingCover = cover;
        if (view == null) { removeCover(loadingCover); return; }
        try {
            view.setAlpha(0f);
            view.setVisibility(View.VISIBLE);
            view.animate().alpha(1f).setDuration(150).start();
        } catch (Throwable ignored) {}
        removeCover(loadingCover);
    }

    private void removeCover(FrameLayout loadingCover) {
        if (loadingCover == null) return;
        if (cover == loadingCover) cover = null;
        if (loadingCover.getParent() != content) return;
        try {
            loadingCover.animate().alpha(0f).setDuration(150).withEndAction(() -> {
                if (loadingCover.getParent() == content) content.removeView(loadingCover);
            }).start();
        } catch (Throwable ignored) {}
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView(String startUrl) {
        revealed = false;
        webView = new WebView(this);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { WebViewCompat.setProfile(webView, "nativekit_remote_url_v1"); }
            catch (Exception error) { report("partitionFallback", "remote URL profile partition is unavailable"); }
        }
        content.removeAllViews();
        content.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Pre-paint surface: INVISIBLE under the cover until the first committed
        // frame; dark ground so no sub-frame white can escape.
        webView.setBackgroundColor(Color.rgb(7, 17, 31));
        webView.setVisibility(View.INVISIBLE);
        webView.setAlpha(0f);
        if (Build.VERSION.SDK_INT >= 26) {
            try { webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true); }
            catch (Throwable ignored) {}
        }
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.setDownloadListener((url, userAgent, disposition, type, length) -> report("blocked", "browser download blocked"));
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
            @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) { callback.onReceiveValue(null); return true; }
            @Override public void onProgressChanged(WebView view, int newProgress) {
                ProgressBar bar = progress;
                if (bar == null) return;
                bar.setProgress(Math.max(0, Math.min(100, newProgress)));
                bar.setVisibility(newProgress >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !isAllowed(request.getUrl());
                if (!isAllowed(request.getUrl())) { report("blocked", "navigation outside the HTTPS allowlist was blocked"); return true; }
                return false;
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                // Earliest point guaranteed to draw the NEW page — reveal + fade in.
                reveal();
            }
            @Override public void onPageFinished(WebView view, String url) {
                // Fallback: never leave the user stuck on the loading cover.
                reveal();
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); report("blocked", "TLS certificate error"); }
            @Override public void onSafeBrowsingHit(WebView view, WebResourceRequest request, int threatType, SafeBrowsingResponse callback) { callback.backToSafety(true); }
        });
        installCover();
        // In-page agent on every remote page ("url open korlew jeno agent browser
        // thake"): the bundle is injected at document start and its model calls
        // are relayed natively — the page's own CSP cannot break it.
        pageAgent = PageAgentHost.install(
            webView,
            getApplicationContext(),
            getIntent().getBooleanExtra(PageAgentHost.EXTRA_ENABLED, true),
            getIntent().getStringExtra(PageAgentHost.EXTRA_LANGUAGE));
        webView.loadUrl(startUrl);
    }

    private boolean isAllowed(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        int port = uri.getPort() < 0 ? 443 : uri.getPort();
        for (String rule : allowedHosts) {
            int separator = rule.lastIndexOf(':');
            String pattern = separator < 0 ? rule : rule.substring(0, separator);
            int expectedPort = separator < 0 ? 443 : Integer.parseInt(rule.substring(separator + 1));
            boolean matches = pattern.startsWith("*.")
                ? host.endsWith(pattern.substring(1)) && !host.equals(pattern.substring(2))
                : host.equals(pattern);
            if (matches && port == expectedPort) return true;
        }
        return false;
    }

    private static Uri validatedHttps(String value) {
        Uri uri = Uri.parse(value);
        if (!uri.isHierarchical() || !"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) throw new IllegalArgumentException("Remote URL mode accepts HTTPS URLs without embedded credentials only");
        return uri;
    }

    private static String validateRule(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        if (value.length() > 260 || !HOST_RULE.matcher(value).matches()) throw new IllegalArgumentException("Invalid remote URL host rule");
        int separator = value.lastIndexOf(':');
        if (separator >= 0) {
            int port = Integer.parseInt(value.substring(separator + 1));
            if (port < 1 || port > 65_535) throw new IllegalArgumentException("Invalid remote URL host port");
        }
        return value;
    }

    private static String hostAndPort(Uri uri) {
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return uri.getPort() < 0 || uri.getPort() == 443 ? host : host + ":" + uri.getPort();
    }

    private void report(String state, String reason) {
        if (resultReceiver == null || (reported && "closed".equals(state))) return;
        Bundle data = new Bundle();
        data.putString("sessionId", sessionId);
        data.putString("state", state);
        data.putString("reason", reason == null ? "" : reason);
        resultReceiver.send(0, data);
        if ("closed".equals(state)) reported = true;
    }

    private void showFailure(String message) {
        if (content == null) return;
        TextView text = new TextView(this);
        text.setText(message);
        text.setTextColor(Color.rgb(30, 41, 59));
        text.setTextSize(17);
        text.setGravity(Gravity.CENTER);
        text.setPadding(dp(24), dp(24), dp(24), dp(24));
        content.removeAllViews();
        content.addView(text, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void destroyWebView() {
        WebView current = webView;
        webView = null;
        if (current == null) return;
        try { current.stopLoading(); } catch (Exception ignored) {}
        try { current.loadUrl("about:blank"); } catch (Exception ignored) {}
        if (current.getParent() instanceof ViewGroup) ((ViewGroup) current.getParent()).removeView(current);
        try { current.destroy(); } catch (Exception ignored) {}
    }

    @Override protected void onDestroy() {
        report("closed", "browser-only URL session closed");
        destroyWebView();
        super.onDestroy();
    }

    private static String required(Intent intent, String key) {
        String value = intent.getStringExtra(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing " + key);
        return value;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
