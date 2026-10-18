package dev.nativekit.isolatedbrowser;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SafeBrowsingResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebViewRenderProcess;
import androidx.webkit.WebViewRenderProcessClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

public final class IsolatedBrowserActivity extends Activity {
    static final String EXTRA_SESSION_ID = "sessionId";
    static final String EXTRA_TOKEN = "token";
    static final String EXTRA_RENDERER_TOKEN = "rendererToken";
    static final String EXTRA_APP_ID = "appId";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_INTEGRITY = "integrity";
    static final String EXTRA_ENTRY = "entry";
    static final String EXTRA_BOOTSTRAP = "bootstrap";
    static final String EXTRA_ALLOWED_HOSTS = "allowedHosts";
    static final String EXTRA_ALLOW_DIRECT_NETWORK = "allowDirectNetwork";
    static final String EXTRA_HANG_DELAY = "hangTerminationDelayMs";
    static final String EXTRA_NETWORK_MODE = "networkMode";
    static final String EXTRA_COLOR_SCHEME = "colorScheme";
    static final String EXTRA_MEDIA_AUTOPLAY = "mediaAutoplay";
    private static final String MODE_SANDBOXED = "sandboxed";
    private static final String MODE_HOSTS = "hosts";
    private static final String MODE_FULL = "full";

    private static final int MAX_RESPONSE_TRANSFERS = 8;
    private static final String RPC_CHANNEL = "nativekit-app-browser-v1";
    private static final Pattern ALLOWED_HOST_RULE = Pattern.compile("^(?:\\*\\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::(?:[1-9][0-9]{0,4}))?$");

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<Message> pendingMessages = new ArrayList<>();
    private final OrderedChunkAccumulator incomingResponses = new OrderedChunkAccumulator(
        IsolatedBrowserBrokerService.MAX_IPC_CHUNK_CHARS,
        IsolatedBrowserBrokerService.MAX_MESSAGE_CHARS,
        32,
        MAX_RESPONSE_TRANSFERS,
        0,
        30_000L
    );
    private Messenger broker;
    private Messenger incoming;
    private boolean bound;
    private WebView webView;
    private FrameLayout content;
    // PageAgent host (null when disabled/unsupported): the in-page agent runs in
    // EVERY mini app; its LLM calls are relayed natively so the mini app's
    // network sandbox and CSP stay fully intact.
    private PageAgentHost pageAgent;
    // Loading cover shown until the WebView commits its first visible frame; the
    // shell background (not white) shows through any launch/swap gap.
    private FrameLayout cover;
    private TextView shellTitle;
    private boolean shellBuilt;
    private boolean revealed;
    private JavaScriptReplyProxy replyProxy;
    private String sessionId;
    private String token;
    private String rendererToken;
    private String appId;
    private String origin;
    private String originHost;
    private String startUrl;
    private String entry;
    private File packageRoot;
    private Set<String> allowedHosts = Collections.emptySet();
    private boolean allowDirectNetwork;
    private String networkMode = MODE_SANDBOXED;
    private boolean mediaAutoplay;
    private long hangTerminationDelayMs;
    private int networkRequests;
    private final Map<String, Integer> networkHosts = new HashMap<>();
    private Runnable pendingTermination;
    private AlertDialog permissionDialog;
    private Runnable permissionTimeout;
    private String permissionRequestId;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) {
            broker = new Messenger(service);
            bound = true;
            sendRegistration();
            for (Message pending : new ArrayList<>(pendingMessages)) sendMessage(pending);
            pendingMessages.clear();
            createWebView();
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            bound = false;
            broker = null;
            showFailure("Host broker connection was lost", false);
        }
    };

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT < 28) {
            finish();
            return;
        }
        try { WebView.setDataDirectorySuffix("nativekit-isolated-v1"); }
        catch (IllegalStateException ignored) { /* This process already initialized WebView with the same fixed suffix. */ }
        // A real session is taking over this process: hand the warm-up WebView's
        // memory back immediately (the expensive provider init already happened).
        IsolatedBrowserWarmupService.releaseForSession();
        incoming = new Messenger(new Handler(Looper.getMainLooper(), message -> {
            Bundle data = message.getData();
            String target = data.getString("sessionId", "");
            String targetRenderer = data.getString("rendererToken", "");
            if (!safeEquals(sessionId, target) || !constantTimeEquals(rendererToken, targetRenderer)) return true;
            if (message.what == IsolatedBrowserBrokerService.MSG_RESPONSE_CHUNK) {
                acceptResponseChunk(data);
            } else if (message.what == IsolatedBrowserBrokerService.MSG_PERMISSION_PROMPT) {
                showPermissionPrompt(data);
            } else if (message.what == IsolatedBrowserBrokerService.MSG_PERMISSION_DISMISS) {
                dismissPermissionPrompt(data.getString("requestId", ""));
            } else if (message.what == IsolatedBrowserBrokerService.MSG_CLOSE) {
                finish();
            }
            return true;
        }));
        initializeFromIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        sendStatus("closed", "replaced by another isolated app session");
        destroyWebView(false);
        incomingResponses.clear();
        if (bound) unbindService(connection);
        bound = false;
        broker = null;
        initializeFromIntent(intent);
    }

    // FULLSCREEN IMMERSIVE: if the mini-app enters HTML5 fullscreen (video etc.),
    // hide the system bars so the phone nav buttons never float on top of the
    // page's own controls. Swipe reveals them translucently (standard UX).
    private boolean decorWatcherArmed = false;
    private View fullscreenView = null;

    private void installImmersiveWatcher() {
        final ViewGroup decorView = (ViewGroup) getWindow().getDecorView();
        decorView.setOnHierarchyChangeListener(new ViewGroup.OnHierarchyChangeListener() {
            @Override public void onChildViewAdded(View parent, View child) {
                if (!decorWatcherArmed || child == decorView) return;
                if (!isTrueFullscreenOverlay(child)) return;
                fullscreenView = child;
                applyImmersive(true);
            }
            @Override public void onChildViewRemoved(View parent, View child) {
                if (!decorWatcherArmed) return;
                if (child == fullscreenView) {
                    fullscreenView = null;
                    applyImmersive(false);
                    applySystemBars(getIntent().getStringExtra(EXTRA_COLOR_SCHEME));
                }
            }
        });
        decorView.post(() -> decorWatcherArmed = true);
    }

    private boolean isTrueFullscreenOverlay(View child) {
        if (child.getVisibility() != View.VISIBLE) return false;
        int h = getWindow().getDecorView().getHeight();
        int w = getWindow().getDecorView().getWidth();
        if (h <= 0 || w <= 0) {
            h = getResources().getDisplayMetrics().heightPixels;
            w = getResources().getDisplayMetrics().widthPixels;
        }
        ViewGroup.LayoutParams lp = child.getLayoutParams();
        if (lp == null) return false;
        boolean matchH = lp.height == ViewGroup.LayoutParams.MATCH_PARENT || lp.height >= (int) (h * 0.7f);
        boolean matchW = lp.width == ViewGroup.LayoutParams.MATCH_PARENT || lp.width >= (int) (w * 0.7f);
        return matchH && matchW;
    }

    private void applyImmersive(boolean active) {
        WindowInsetsControllerCompat ic = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        if (active) {
            ic.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            ic.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            ic.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    // BLEND MODE: transparent bars + icon contrast from the app's colorScheme.
    // The mini-app's page colors flow under the bars instead of a fixed strip.
    private void applySystemBars(String scheme) {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsControllerCompat ic = new WindowInsetsControllerCompat(window, window.getDecorView());
        boolean lightPage = "light".equals(scheme);
        ic.setAppearanceLightStatusBars(lightPage);
        ic.setAppearanceLightNavigationBars(lightPage);
    }

    private void showPermissionPrompt(Bundle data) {
        String requestId = data.getString("requestId", "");
        String appName = data.getString("appName", "Installed app");
        String capability = data.getString("capability", "native API");
        String method = data.getString("method", "unknown");
        String argumentSummary = data.getString("argumentSummary", "");
        long timeoutMs = Math.max(1_000L, Math.min(120_000L, data.getLong("timeoutMs", 90_000L)));
        if (requestId.isEmpty() || requestId.length() > 100 || permissionDialog != null) {
            if (!requestId.isEmpty()) sendPermissionResult(requestId, "block_once");
            return;
        }
        permissionRequestId = requestId;
        String title = appName + " requests native access";
        String message = "Capability: " + capability + "\nMethod: " + method + (argumentSummary.isEmpty() ? "" : "\nArguments: " + argumentSummary) + "\n\nOnly approve if you trust this installed app and expect this action.";
        String[] actions = new String[] { "Allow once", "Always allow this method", "Block once", "Always block this method" };
        permissionDialog = new AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setItems(actions, (dialog, which) -> {
                String action = which == 0 ? "allow_once" : which == 1 ? "allow_always" : which == 2 ? "block_once" : "block_always";
                completePermissionPrompt(requestId, action);
            })
            .setCancelable(false)
            .create();
        permissionDialog.setOnDismissListener(dialog -> {
            if (requestId.equals(permissionRequestId)) completePermissionPrompt(requestId, "block_once");
        });
        permissionTimeout = () -> {
            if (requestId.equals(permissionRequestId)) completePermissionPrompt(requestId, "block_once");
        };
        handler.postDelayed(permissionTimeout, timeoutMs);
        permissionDialog.show();
    }

    private void completePermissionPrompt(String requestId, String action) {
        if (!requestId.equals(permissionRequestId)) return;
        permissionRequestId = null;
        if (permissionTimeout != null) handler.removeCallbacks(permissionTimeout);
        permissionTimeout = null;
        AlertDialog dialog = permissionDialog;
        permissionDialog = null;
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
        sendPermissionResult(requestId, action);
    }

    private void dismissPermissionPrompt(String requestId) {
        if (!requestId.equals(permissionRequestId)) return;
        permissionRequestId = null;
        if (permissionTimeout != null) handler.removeCallbacks(permissionTimeout);
        permissionTimeout = null;
        AlertDialog dialog = permissionDialog;
        permissionDialog = null;
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
    }

    private void sendPermissionResult(String requestId, String action) {
        Message result = Message.obtain(null, IsolatedBrowserBrokerService.MSG_PERMISSION_RESULT);
        Bundle data = sessionBundle();
        data.putString("requestId", requestId);
        data.putString("action", action);
        result.setData(data);
        sendMessage(result);
    }

    private void initializeFromIntent(Intent intent) {
        applySystemBars(intent.getStringExtra(EXTRA_COLOR_SCHEME));
        if (!decorWatcherArmed) installImmersiveWatcher();
        try {
            sessionId = required(intent, EXTRA_SESSION_ID);
            token = required(intent, EXTRA_TOKEN);
            rendererToken = required(intent, EXTRA_RENDERER_TOKEN);
            appId = required(intent, EXTRA_APP_ID);
            String title = required(intent, EXTRA_TITLE);
            String integrity = required(intent, EXTRA_INTEGRITY);
            entry = IsolatedAppStore.validatePath(required(intent, EXTRA_ENTRY));
            packageRoot = IsolatedAppStore.committedDirectory(this, appId, integrity);
            if (!packageRoot.isDirectory() || !IsolatedAppStore.resolveInside(packageRoot, entry).isFile()) throw new IllegalStateException("Staged package is missing");
            originHost = IsolatedAppStore.originHost(appId);
            origin = "https://" + originHost;
            startUrl = origin + "/" + entry;
            allowDirectNetwork = intent.getBooleanExtra(EXTRA_ALLOW_DIRECT_NETWORK, false);
            {
                String mode = intent.getStringExtra(EXTRA_NETWORK_MODE);
                if (MODE_FULL.equals(mode) || MODE_HOSTS.equals(mode) || MODE_SANDBOXED.equals(mode)) networkMode = mode;
                else networkMode = allowDirectNetwork ? MODE_HOSTS : MODE_SANDBOXED;
                // Owner policy always wins over the bundle's global direct-network flag.
                if (!allowDirectNetwork && !MODE_FULL.equals(networkMode)) networkMode = MODE_SANDBOXED;
            }
            mediaAutoplay = intent.getBooleanExtra(EXTRA_MEDIA_AUTOPLAY, false);
            hangTerminationDelayMs = Math.max(1_000L, Math.min(30_000L, intent.getLongExtra(EXTRA_HANG_DELAY, 4_000L)));
            String[] hosts = intent.getStringArrayExtra(EXTRA_ALLOWED_HOSTS);
            Set<String> parsedHosts = new HashSet<>();
            if (hosts != null) {
                for (String host : hosts) parsedHosts.add(validateAllowedHost(host));
            }
            allowedHosts = Collections.unmodifiableSet(parsedHosts);
            buildShell(title);
            // Create + start loading the WebView immediately instead of waiting for
            // the broker bind round-trip: status messages queue in pendingMessages
            // until the connection lands, so ordering is preserved while one serial
            // IPC hop disappears from the perceived launch path.
            createWebView();
            Intent brokerIntent = new Intent(this, IsolatedBrowserBrokerService.class);
            if (!bindService(brokerIntent, connection, Context.BIND_AUTO_CREATE)) throw new IllegalStateException("Could not bind isolated browser broker");
        } catch (Exception error) {
            buildShell("Isolated app");
            showFailure(error.getMessage() == null ? "Invalid isolated app launch" : error.getMessage(), false);
        }
    }

    private static String required(Intent intent, String key) {
        String value = intent.getStringExtra(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing " + key);
        return value;
    }

    private void buildShell(String title) {
        if (shellBuilt) {
            // Session swap (onNewIntent): reuse the existing shell so setContentView
            // never flashes the window background mid-swap. Only the title and the
            // content area (cleared + re-covered by createWebView) change.
            if (shellTitle != null) shellTitle.setText(title);
            return;
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(7, 17, 31));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(14), dp(8), dp(8), dp(8));
        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextColor(Color.WHITE);
        heading.setTextSize(16);
        heading.setSingleLine(true);
        shellTitle = heading;
        toolbar.addView(heading, new LinearLayout.LayoutParams(0, dp(44), 1));
        Button close = new Button(this);
        close.setText("Close");
        close.setOnClickListener(view -> finish());
        toolbar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(44)));
        root.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(60)));

        content = new FrameLayout(this);
        // Dark shell ground (matches the theme windowBackground): every state the
        // user can see before the first paint is this color, never white.
        content.setBackgroundColor(Color.rgb(7, 17, 31));
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        shellBuilt = true;
        ImeInsetsHelper.apply(root);
    }

    // Dark branded loading cover with a spinner, layered ON TOP of the WebView.
    // The WebView beneath stays INVISIBLE until its first committed frame, so the
    // pre-paint white surface can never reach the screen.
    private void installCover() {
        FrameLayout layout = new FrameLayout(this);
        layout.setBackgroundColor(Color.rgb(7, 17, 31));
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.addView(new ProgressBar(this), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView label = new TextView(this);
        label.setText("Loading isolated app…");
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

    // Reveal the WebView only after it committed a visible frame (or finished
    // loading, as a fallback): a short fade hides the last seams.
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
    private void createWebView() {
        if (isFinishing() || webView != null) return;
        revealed = false;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            sendStatus("unsupported", "Android System WebView lacks document-start messaging support");
            showFailure("Android System WebView must be updated before this isolated app can run.", false);
            return;
        }
        webView = new WebView(this);
        webView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void setFullscreen(final boolean on) {
                runOnUiThread(() -> applyImmersive(on));
            }
        }, "NativeKitImmersive");
        boolean profilePartition = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
        if (profilePartition) {
            try { WebViewCompat.setProfile(webView, IsolatedAppStore.profileName(appId)); }
            catch (Exception error) {
                profilePartition = false;
                sendStatus("partitionFallback", "per-app WebView profile unavailable; using isolated virtual origin");
            }
        }
        content.removeAllViews();
        content.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Pre-paint surface color: the WebView stays INVISIBLE under the loading
        // cover until its first committed frame, and this dark ground prevents
        // any sub-frame white from ever escaping during the swap.
        webView.setBackgroundColor(Color.rgb(7, 17, 31));
        webView.setVisibility(View.INVISIBLE);
        webView.setAlpha(0f);
        // IMPORTANT while this activity is visible, waived as soon as it is not:
        // when the user leaves, the isolated renderer yields its memory instead of
        // pressuring the (kill-protected) host process.
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
        settings.setMediaPlaybackRequiresUserGesture(!mediaAutoplay);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> startDownload(url));
        webView.setWebViewClient(new GuardedClient());

        Set<String> origins = Collections.singleton(origin);
        WebViewCompat.addWebMessageListener(webView, "NativeKitIsolatedTransport", origins, this::onPageMessage);
        WebViewCompat.addDocumentStartJavaScript(webView, required(getIntent(), EXTRA_BOOTSTRAP), origins);
        installRendererWatchdog();
        sendStatus("partitionReady", profilePartition ? "per-app Android WebView profile" : "per-app virtual origin; third-party cookies disabled");
        sendStatus("loading", startUrl);
        installCover();
        // In-page agent for mini apps too ("sob jaigai jeno kaj kore"). The relay
        // is a WebView message channel, NOT page networking, so the sandboxed
        // network mode and the CSP are untouched; DOM actions stay in-page, and
        // any native capability a mini app requests mid-run still goes through
        // the existing broker permission prompts.
        pageAgent = PageAgentHost.install(
            webView,
            getApplicationContext(),
            getIntent().getBooleanExtra(PageAgentHost.EXTRA_ENABLED, true),
            getIntent().getStringExtra(PageAgentHost.EXTRA_LANGUAGE));
        webView.loadUrl(startUrl);
    }

    private void onPageMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin, boolean isMainFrame, @NonNull JavaScriptReplyProxy proxy) {
        if (!isMainFrame || !origin.equals(sourceOrigin.toString()) || view != webView) return;
        String data = message.getData();
        if (data == null || data.length() > 2_800_000) {
            sendStatus("protocolError", "invalid page message size");
            return;
        }
        try {
            JSONObject request = new JSONObject(data);
            if (!RPC_CHANNEL.equals(request.optString("channel")) || !constantTimeEquals(token, request.optString("token"))) throw new SecurityException("invalid bridge identity");
            replyProxy = proxy;
            sendRequestChunks(data, sourceOrigin.toString());
        } catch (Exception error) {
            sendStatus("protocolError", error.getMessage() == null ? "invalid bridge message" : error.getMessage());
        }
    }

    private void sendRequestChunks(String value, String sourceOrigin) {
        String transferId = UUID.randomUUID().toString();
        int size = IsolatedBrowserBrokerService.MAX_IPC_CHUNK_CHARS;
        int count = Math.max(1, (value.length() + size - 1) / size);
        for (int index = 0; index < count; index++) {
            int start = index * size;
            int end = Math.min(value.length(), start + size);
            Bundle data = sessionBundle();
            data.putString("origin", sourceOrigin);
            data.putString("transferId", transferId);
            data.putInt("index", index);
            data.putInt("count", count);
            data.putString("chunk", value.substring(start, end));
            Message output = Message.obtain(null, IsolatedBrowserBrokerService.MSG_REQUEST_CHUNK);
            output.setData(data);
            sendMessage(output);
        }
    }

    private void acceptResponseChunk(Bundle data) {
        int index = data.getInt("index", -1);
        try {
            OrderedChunkAccumulator.Result result = incomingResponses.accept(
                data.getString("transferId", ""),
                "",
                index,
                data.getInt("count", -1),
                data.getString("chunk"),
                SystemClock.elapsedRealtime()
            );
            if (result.complete) {
                deliverToPage(result.value);
            } else if (index == 0) {
                handler.postDelayed(() -> {
                    if (incomingResponses.pruneExpired(SystemClock.elapsedRealtime()) > 0) {
                        sendStatus("transportError", "response transfer timed out");
                    }
                }, 30_001L);
            }
        } catch (IllegalArgumentException error) {
            sendStatus("transportError", error.getMessage() == null ? "invalid response transfer" : error.getMessage());
        }
    }

    private final class GuardedClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            Uri url = request.getUrl();
            if (isLocal(url)) return false;
            sendStatus("navigationBlocked", url.toString());
            return true;
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri parsed = Uri.parse(url);
            if (isLocal(parsed)) return false;
            sendStatus("navigationBlocked", url);
            return true;
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (isLocal(url)) return serveLocal(url, request.isForMainFrame());
            String scheme = url.getScheme();
            if (MODE_FULL.equals(networkMode) && ("https".equalsIgnoreCase(scheme) || "wss".equalsIgnoreCase(scheme))) { trackNetwork(url); return null; }
            if (MODE_HOSTS.equals(networkMode) && "https".equalsIgnoreCase(scheme) && hostAllowed(url)) { trackNetwork(url); return null; }
            if ("data".equalsIgnoreCase(scheme) || "blob".equalsIgnoreCase(scheme)) return null;
            return blockedResponse();
        }

        @Override public void onPageCommitVisible(WebView view, String url) {
            // Earliest point guaranteed to draw the NEW page (not the old content /
            // pre-paint surface) — the safe signal to reveal + fade in.
            reveal();
        }

        @Override public void onPageFinished(WebView view, String url) {
            if (startUrl.equals(url) || isLocal(Uri.parse(url))) sendStatus("ready", origin);
            // Fallback reveal: some error/sparse pages never commit visibly in a
            // way apps expect; never leave the user stuck on the loading cover.
            reveal();
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            boolean crash = detail.didCrash();
            sendStatus("rendererGone", crash ? "renderer crashed" : "renderer was terminated after becoming unresponsive");
            if (view == webView) {
                destroyWebView(true);
                showFailure(crash ? "The isolated renderer crashed." : "The isolated renderer stopped responding and was terminated.", true);
            }
            return true;
        }

        @Override public void onSafeBrowsingHit(WebView view, WebResourceRequest request, int threatType, SafeBrowsingResponse callback) {
            callback.backToSafety(true);
            sendStatus("safeBrowsingBlocked", request.getUrl().toString());
        }
    }

    private void installRendererWatchdog() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_CLIENT_BASIC_USAGE)) return;
        WebViewCompat.setWebViewRenderProcessClient(webView, new WebViewRenderProcessClient() {
            @Override public void onRenderProcessUnresponsive(@NonNull WebView view, WebViewRenderProcess renderer) {
                sendStatus("rendererUnresponsive", "Android WebView reported an unresponsive renderer");
                if (pendingTermination != null) handler.removeCallbacks(pendingTermination);
                pendingTermination = () -> {
                    if (renderer != null) renderer.terminate();
                    pendingTermination = null;
                };
                handler.postDelayed(pendingTermination, hangTerminationDelayMs);
            }

            @Override public void onRenderProcessResponsive(@NonNull WebView view, WebViewRenderProcess renderer) {
                if (pendingTermination != null) handler.removeCallbacks(pendingTermination);
                pendingTermination = null;
                sendStatus("rendererResponsive", "renderer recovered before forced termination");
            }
        });
    }

    private WebResourceResponse serveLocal(Uri url, boolean mainFrame) {
        try {
            String path = url.getPath();
            path = path == null ? "" : Uri.decode(path).replaceFirst("^/+", "");
            if (path.isEmpty()) path = entry;
            File file;
            try { file = IsolatedAppStore.resolveInside(packageRoot, path); }
            catch (Exception invalid) { return notFoundResponse(); }
            if (!file.isFile() && mainFrame) file = IsolatedAppStore.resolveInside(packageRoot, entry);
            if (!file.isFile() || file.getName().startsWith(".")) return notFoundResponse();
            String mime = IsolatedAppStore.mimeType(path);
            String encoding = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") ? "utf-8" : null;
            WebResourceResponse response = new WebResourceResponse(mime, encoding, new FileInputStream(file));
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Content-Security-Policy", contentSecurityPolicy());
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Referrer-Policy", "no-referrer");
            response.setResponseHeaders(headers);
            return response;
        } catch (Exception error) {
            return notFoundResponse();
        }
    }

    private static WebResourceResponse notFoundResponse() {
        return textResponse(404, "Not Found", "Package resource not found");
    }

    private static WebResourceResponse blockedResponse() {
        return textResponse(403, "Forbidden", "Direct web request blocked by NativeKit policy");
    }

    private static WebResourceResponse textResponse(int status, String reason, String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers, new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private String contentSecurityPolicy() {
        if (MODE_FULL.equals(networkMode)) {
            return "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data: blob: https:; connect-src 'self' https: wss: data: blob:; worker-src 'self' blob: data:; frame-src 'self' data: blob: https:; form-action 'self' https:; base-uri 'none'; object-src 'none'";
        }
        if (MODE_SANDBOXED.equals(networkMode) || allowedHosts.isEmpty()) {
            return "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' data: blob:; form-action 'none'; base-uri 'none'; object-src 'none'";
        }
        StringBuilder https = new StringBuilder();
        StringBuilder wss = new StringBuilder();
        for (String host : allowedHosts) {
            https.append(" https://").append(host);
            wss.append(" wss://").append(host);
        }
        return "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:" + https + "; media-src 'self' data: blob:" + https + "; font-src 'self' data: blob:; connect-src 'self'" + https + wss + "; worker-src 'self' blob:; frame-src 'self' data: blob:; form-action 'none'; base-uri 'none'; object-src 'none'";
    }

    private void trackNetwork(Uri url) {
        networkRequests += 1;
        String host = url.getHost();
        if (host != null) {
            String key = host.toLowerCase(Locale.US);
            Integer current = networkHosts.get(key);
            networkHosts.put(key, (current == null ? 0 : current) + 1);
        }
        if (networkRequests % 10 == 0) flushNetworkStats();
    }

    private void flushNetworkStats() {
        if (networkRequests == 0) return;
        try {
            java.util.List<Map.Entry<String, Integer>> entries = new ArrayList<>(networkHosts.entrySet());
            entries.sort((a, b) -> b.getValue() - a.getValue());
            JSONObject hosts = new JSONObject();
            for (int i = 0; i < Math.min(10, entries.size()); i++) hosts.put(entries.get(i).getKey(), entries.get(i).getValue());
            JSONObject payload = new JSONObject();
            payload.put("add", networkRequests);
            payload.put("hosts", hosts);
            sendStatus("netStats", payload.toString());
            networkRequests = 0;
        } catch (Exception ignored) {}
    }

    private void startDownload(String rawUrl) {
        Uri uri = Uri.parse(rawUrl);
        boolean permitted = "https".equalsIgnoreCase(uri.getScheme())
            && (MODE_FULL.equals(networkMode) || (MODE_HOSTS.equals(networkMode) && hostAllowed(uri)));
        if (!permitted) { sendStatus("blocked", "web download blocked by network mode; use NativeKit fileTransfer"); return; }
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(rawUrl).openConnection();
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(30_000);
                connection.setInstanceFollowRedirects(true);
                connection.connect();
                if (connection.getResponseCode() / 100 != 2) throw new IOException("HTTP " + connection.getResponseCode());
                String path = uri.getPath();
                String name = (path == null || path.isEmpty()) ? "download.bin" : new File(path.endsWith("/") ? path.substring(0, path.length() - 1) : path).getName();
                if (name.isEmpty() || name.length() > 120) name = "download.bin";
                File dir = new File(getFilesDir(), "isolated-downloads/" + appId);
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("Download folder could not be created");
                File target = new File(dir, name);
                long total = 0;
                try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(target)) {
                    byte[] buffer = new byte[16_384];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        total += read;
                        if (total > 200L * 1024 * 1024) throw new IOException("Download exceeds the 200 MiB cap");
                    }
                }
                trackNetwork(uri);
                sendStatus("downloadComplete", name + " (" + total + " bytes → app private files)");
            } catch (Exception error) {
                sendStatus("downloadFailed", error.getMessage() == null ? "download failed" : error.getMessage());
            } finally { if (connection != null) connection.disconnect(); }
        }, "nativekit-download").start();
    }

    private boolean isLocal(Uri url) {
        return "https".equalsIgnoreCase(url.getScheme()) && originHost.equalsIgnoreCase(url.getHost()) && (url.getPort() == -1 || url.getPort() == 443);
    }

    private boolean hostAllowed(Uri url) {
        String host = url.getHost();
        if (host == null) return false;
        host = host.toLowerCase();
        int actualPort = url.getPort() < 0 ? 443 : url.getPort();
        for (String rule : allowedHosts) {
            String normalized = rule.toLowerCase();
            int separator = normalized.lastIndexOf(':');
            String patternHost = separator < 0 ? normalized : normalized.substring(0, separator);
            int patternPort;
            try { patternPort = separator < 0 ? 443 : Integer.parseInt(normalized.substring(separator + 1)); }
            catch (NumberFormatException invalid) { continue; }
            boolean hostMatches = patternHost.startsWith("*.")
                ? host.endsWith(patternHost.substring(1)) && !host.equals(patternHost.substring(2))
                : host.equals(patternHost);
            if (hostMatches && actualPort == patternPort) return true;
        }
        return false;
    }

    private void sendRegistration() {
        Message message = Message.obtain(null, IsolatedBrowserBrokerService.MSG_REGISTER);
        message.replyTo = incoming;
        message.setData(sessionBundle());
        sendMessage(message);
    }

    private void sendStatus(String state, String reason) {
        if (sessionId == null || token == null) return;
        Bundle data = sessionBundle();
        data.putString("state", state);
        data.putString("reason", reason == null ? "" : reason);
        Message output = Message.obtain(null, IsolatedBrowserBrokerService.MSG_STATUS);
        output.setData(data);
        sendMessage(output);
    }

    private Bundle sessionBundle() {
        Bundle data = new Bundle();
        data.putString("sessionId", sessionId);
        data.putString("rendererToken", rendererToken);
        return data;
    }

    private void sendMessage(Message message) {
        if (!bound || broker == null) {
            pendingMessages.add(message);
            return;
        }
        try { broker.send(message); }
        catch (RemoteException error) { showFailure("Could not reach the host NativeKit broker", false); }
    }

    private void deliverToPage(String payload) {
        JavaScriptReplyProxy proxy = replyProxy;
        if (proxy == null || payload == null || payload.length() > 2_800_000) return;
        try { proxy.postMessage(payload); }
        catch (Exception error) { sendStatus("transportError", "page response channel is unavailable"); }
    }

    private void showFailure(String message, boolean canReload) {
        if (content == null) return;
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(24), dp(24), dp(24), dp(24));
        TextView text = new TextView(this);
        text.setText(message);
        text.setTextColor(Color.rgb(30, 41, 59));
        text.setTextSize(17);
        text.setGravity(Gravity.CENTER);
        panel.addView(text, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        if (canReload) {
            Button reload = new Button(this);
            reload.setText("Reload isolated app");
            reload.setOnClickListener(view -> createWebView());
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            params.topMargin = dp(18);
            panel.addView(reload, params);
        }
        content.removeAllViews();
        content.addView(panel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void destroyWebView(boolean rendererGone) {
        if (pendingTermination != null) handler.removeCallbacks(pendingTermination);
        pendingTermination = null;
        replyProxy = null;
        incomingResponses.clear();
        WebView current = webView;
        webView = null;
        if (current != null) {
            if (!rendererGone) {
                try { current.stopLoading(); } catch (Exception ignored) {}
                try { current.loadUrl("about:blank"); } catch (Exception ignored) {}
            }
            try { current.removeAllViews(); } catch (Exception ignored) {}
            if (current.getParent() instanceof ViewGroup) ((ViewGroup) current.getParent()).removeView(current);
            try { current.destroy(); } catch (Exception ignored) {}
        }
    }

    @Override protected void onDestroy() {
        if (permissionRequestId != null) completePermissionPrompt(permissionRequestId, "block_once");
        flushNetworkStats();
        if (!isChangingConfigurations()) sendStatus("closed", "isolated activity closed");
        destroyWebView(false);
        if (bound) unbindService(connection);
        bound = false;
        super.onDestroy();
    }

    private static String validateAllowedHost(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        if (value.length() > 260 || !ALLOWED_HOST_RULE.matcher(value).matches()) throw new IllegalArgumentException("Invalid allowed host");
        int separator = value.lastIndexOf(':');
        if (separator >= 0) {
            int port;
            try { port = Integer.parseInt(value.substring(separator + 1)); }
            catch (NumberFormatException error) { throw new IllegalArgumentException("Invalid allowed host port"); }
            if (port < 1 || port > 65_535) throw new IllegalArgumentException("Invalid allowed host port");
        }
        String hostname = (separator < 0 ? value : value.substring(0, separator)).replaceFirst("^\\*\\.", "");
        if (hostname.length() > 253) throw new IllegalArgumentException("Invalid allowed host");
        return value;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private static boolean safeEquals(String left, String right) { return left != null && left.equals(right); }

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
