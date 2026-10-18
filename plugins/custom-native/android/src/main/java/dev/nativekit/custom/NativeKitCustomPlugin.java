package dev.nativekit.custom;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
// zxing-android-embedded keeps the IntentIntegrator/IntentResult helpers in
// the original zxing integration package (verified against the 4.3.0 aar).
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "NativeKitCustom", permissions = {
    @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "recordAudio"),
    @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera")
})
public class NativeKitCustomPlugin extends Plugin {
    private final Map<String, Call> streams = new ConcurrentHashMap<>();
    private OkHttpClient http;
    private SecureStore secureStore;
    private BroadcastReceiver eventReceiver;
    // Text-to-speech engine, initialised lazily; calls that arrive before the
    // engine is ready are parked and replayed from the onInit callback.
    private TextToSpeech tts;
    private boolean ttsReady;
    private final List<Object[]> pendingTts = new ArrayList<>();

    @Override public void load() {
        secureStore = new SecureStore(getContext());
        http = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();
        eventReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (AlarmReceiver.FIRED_BROADCAST.equals(intent.getAction())) {
                    JSObject value = new JSObject();
                    value.put("id", intent.getStringExtra("alarmId"));
                    notifyListeners("nativeAlarmFired", value, true);
                } else if (LocationTrackingService.LOCATION_BROADCAST.equals(intent.getAction())) {
                    try { notifyListeners("nativeLocation", new JSObject(intent.getStringExtra("location")), true); }
                    catch (Exception ignored) {}
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(AlarmReceiver.FIRED_BROADCAST);
        filter.addAction(LocationTrackingService.LOCATION_BROADCAST);
        if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(eventReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(eventReceiver, filter);
    }

    @Override public Boolean shouldOverrideLoad(Uri url) {
        if (url == null) return null;
        String scheme = url.getScheme();
        Uri appUri = Uri.parse(getBridge().getAppUrl());
        boolean localAppUrl = appUri.getHost() != null && appUri.getHost().equalsIgnoreCase(url.getHost())
            && appUri.getScheme() != null && appUri.getScheme().equalsIgnoreCase(scheme)
            && appUri.getPort() == url.getPort();
        if (localAppUrl) return null;
        if (("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
            && url.getHost() != null && getBridge().getAppAllowNavigationMask().matches(url.getHost())) return null;
        if ("about:srcdoc".equalsIgnoreCase(url.toString())) return null;
        // Prevent opaque App Browser frames from resetting their CSP through data/blob navigation,
        // making an unbrokered network request, or launching an external intent. Trusted code should
        // use an explicit native API (for example the Browser plugin) for external navigation.
        return true;
    }

    @Override protected void handleOnDestroy() {
        for (Call call : streams.values()) call.cancel();
        streams.clear();
        if (eventReceiver != null) {
            try { getContext().unregisterReceiver(eventReceiver); } catch (Exception ignored) {}
        }
        super.handleOnDestroy();
    }

    /**
     * Gate for biometric-gated tool approvals ("always_ask_biometric"). The
     * engine emits requireBiometric with the approval request; the workspace
     * calls this BEFORE responding, so a policy can no longer be satisfied by
     * a plain tap from whoever is holding the phone. Fails closed: any error,
     * missing hardware or a lockout rejects instead of approving.
     */
    @PluginMethod public void verifyBiometric(PluginCall call) {
        android.app.Activity activity = getActivity();
        if (activity == null || !(activity instanceof androidx.fragment.app.FragmentActivity)) {
            call.reject("Biometric verification is unavailable (no activity)");
            return;
        }
        try {
            androidx.biometric.BiometricManager manager = androidx.biometric.BiometricManager.from(getContext());
            int strength = android.os.Build.VERSION.SDK_INT >= 30
                ? androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
                : androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK;
            int can = manager.canAuthenticate(strength);
            if (can != androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS) {
                String reason = biometricUnavailableText(can);
                call.reject("Biometric verification is unavailable: " + reason);
                return;
            }
            String title = call.getString("reason", "Confirm to continue");
            androidx.biometric.BiometricPrompt.PromptInfo info =
                new androidx.biometric.BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle("Agent tool approval")
                    .setAllowedAuthenticators(strength)
                    .setConfirmationRequired(false)
                    .build();
            androidx.biometric.BiometricPrompt prompt = new androidx.biometric.BiometricPrompt(
                (androidx.fragment.app.FragmentActivity) activity,
                androidx.core.content.ContextCompat.getMainExecutor(getContext()),
                new androidx.biometric.BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(androidx.biometric.BiometricPrompt.AuthenticationResult result) {
                        JSObject out = new JSObject();
                        out.put("verified", true);
                        call.resolve(out);
                    }
                    @Override public void onAuthenticationError(int errorCode, CharSequence message) {
                        call.reject("Biometric verification failed (" + errorCode + "): " + message);
                    }
                });
            prompt.authenticate(info);
        } catch (Exception error) {
            call.reject("Biometric verification failed: " + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()), error);
        }
    }

    private static String biometricUnavailableText(int code) {
        switch (code) {
            case androidx.biometric.BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE: return "no biometric hardware on this device";
            case androidx.biometric.BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE: return "biometric hardware is unavailable";
            case androidx.biometric.BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED: return "no fingerprint or face is enrolled";
            case androidx.biometric.BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED: return "a security update is required first";
            default: return "biometrics are locked out or unavailable (code " + code + ")";
        }
    }

    @PluginMethod public void checkAlarmCapabilities(PluginCall call) {
        AlarmScheduler scheduler = new AlarmScheduler(getContext());
        boolean fullScreen = true;
        if (Build.VERSION.SDK_INT >= 34) fullScreen = getContext().getSystemService(NotificationManager.class).canUseFullScreenIntent();
        JSObject result = new JSObject();
        result.put("platform", "android");
        result.put("exact", scheduler.canScheduleExact());
        result.put("fullScreen", fullScreen);
        result.put("alarmKit", false);
        result.put("fallback", scheduler.canScheduleExact() ? "none" : "inexact-native-alarm");
        call.resolve(result);
    }

    @PluginMethod public void requestExactAlarmAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || new AlarmScheduler(getContext()).canScheduleExact()) { call.resolve(); return; }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) { call.reject("Unable to open exact alarm settings", error); }
    }

    @PluginMethod public void requestFullScreenIntentAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT < 34) { call.resolve(); return; }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) { call.reject("Unable to open full-screen intent settings", error); }
    }

    @PluginMethod public void scheduleAlarm(PluginCall call) {
        String id = required(call, "id");
        String title = required(call, "title");
        Long at = call.getLong("at");
        if (id == null || title == null || at == null) { call.reject("id, title and numeric at are required"); return; }
        try {
            JSONObject alarm = new JSONObject();
            alarm.put("id", id);
            alarm.put("title", title);
            alarm.put("body", call.getString("body", ""));
            alarm.put("scheduledAt", at);
            alarm.put("repeatIntervalMinutes", call.getLong("repeatIntervalMinutes", 0L));
            alarm.put("fullScreen", call.getBoolean("fullScreen", false));
            alarm.put("sound", call.getString("sound", "default"));
            JSObject extra = call.getObject("extra");
            if (extra != null) alarm.put("extra", extra);
            JSONObject result = new AlarmScheduler(getContext()).schedule(alarm, true);
            call.resolve(new JSObject(result.toString()));
        } catch (Exception error) { call.reject("Alarm could not be scheduled: " + error.getMessage(), error); }
    }

    @PluginMethod public void cancelAlarm(PluginCall call) {
        String id = required(call, "id");
        if (id == null) return;
        new AlarmScheduler(getContext()).cancel(id);
        call.resolve();
    }

    @PluginMethod public void listAlarms(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("alarms", new JSArray(new AlarmScheduler(getContext()).listJson().toString()));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Stored alarms could not be read", error);
        }
    }

    @PluginMethod public void stopRinging(PluginCall call) {
        getContext().startService(new Intent(getContext(), AlarmService.class).setAction(AlarmService.ACTION_STOP).putExtra("alarmId", call.getString("id", "")));
        call.resolve();
    }

    @PluginMethod public void startSSE(PluginCall pluginCall) {
        String url = required(pluginCall, "url");
        if (url == null) return;
        Uri parsed = Uri.parse(url);
        if (!("https".equals(parsed.getScheme()) || "http".equals(parsed.getScheme()))) { pluginCall.reject("Only HTTP(S) streams are allowed"); return; }
        String streamId = pluginCall.getString("streamId", UUID.randomUUID().toString());
        String method = pluginCall.getString("method", "GET").toUpperCase();
        String format = pluginCall.getString("format", "sse");
        Request.Builder builder = new Request.Builder().url(url);
        JSObject headers = pluginCall.getObject("headers");
        if (headers != null) {
            java.util.Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                builder.addHeader(key, String.valueOf(headers.opt(key)));
            }
        }
        if ("sse".equals(format) && (headers == null || !headers.has("Accept"))) builder.addHeader("Accept", "text/event-stream");
        String body = pluginCall.getString("body");
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            MediaType type = MediaType.parse(headers == null ? "application/json; charset=utf-8" : headers.optString("Content-Type", "application/json; charset=utf-8"));
            builder.method(method, RequestBody.create(body == null ? "" : body, type));
        } else builder.method(method, null);

        OkHttpClient streamClient = pluginCall.getBoolean("disableRedirects", false)
            ? http.newBuilder().followRedirects(false).followSslRedirects(false).build()
            : http;
        Call stream = streamClient.newCall(builder.build());
        streams.put(streamId, stream);
        stream.enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException error) {
                if (streams.remove(streamId) == null) return;
                JSObject event = streamEvent(streamId, format);
                event.put("message", error.getMessage());
                notifyListeners("nativeSSEError", event, true);
            }

            @Override public void onResponse(Call call, Response response) {
                try (ResponseBody responseBody = response.body()) {
                    if (!response.isSuccessful() || responseBody == null) {
                        JSObject event = streamEvent(streamId, format);
                        event.put("message", "HTTP " + response.code());
                        event.put("status", response.code());
                        notifyListeners("nativeSSEError", event, true);
                        return;
                    }
                    if ("text".equals(format)) readText(streamId, responseBody.source(), format);
                    else readLines(streamId, responseBody.source(), format);
                    if (streams.containsKey(streamId)) {
                        JSObject event = streamEvent(streamId, format);
                        event.put("status", response.code());
                        notifyListeners("nativeSSEEnd", event, true);
                    }
                } catch (Exception error) {
                    if (streams.containsKey(streamId)) {
                        JSObject event = streamEvent(streamId, format);
                        event.put("message", String.valueOf(error.getMessage()));
                        event.put("status", response.code());
                        notifyListeners("nativeSSEError", event, true);
                    }
                } finally { streams.remove(streamId); }
            }
        });
        JSObject result = new JSObject();
        result.put("streamId", streamId);
        pluginCall.resolve(result);
    }

    private void readText(String id, BufferedSource source, String format) throws IOException {
        Buffer buffer = new Buffer();
        while (streams.containsKey(id) && source.read(buffer, 8192) != -1) {
            String chunk = buffer.readUtf8();
            JSObject event = streamEvent(id, format);
            event.put("data", chunk);
            notifyListeners("nativeSSEData", event, true);
        }
    }

    private void readLines(String id, BufferedSource source, String format) throws IOException {
        if ("ndjson".equals(format)) {
            String line;
            while (streams.containsKey(id) && (line = source.readUtf8Line()) != null) {
                if (!line.trim().isEmpty()) {
                    JSObject event = streamEvent(id, format); event.put("data", line); notifyListeners("nativeSSEData", event, true);
                }
            }
            return;
        }
        StringBuilder data = new StringBuilder();
        String eventName = null;
        String eventId = null;
        String line;
        while (streams.containsKey(id) && (line = source.readUtf8Line()) != null) {
            if (line.isEmpty()) {
                if (data.length() > 0 || eventName != null || eventId != null) {
                    JSObject event = streamEvent(id, format);
                    event.put("data", data.length() > 0 ? data.substring(0, data.length() - 1) : "");
                    if (eventName != null) event.put("event", eventName);
                    if (eventId != null) event.put("id", eventId);
                    notifyListeners("nativeSSEData", event, true);
                }
                data.setLength(0); eventName = null; eventId = null; continue;
            }
            if (line.startsWith(":")) continue;
            int colon = line.indexOf(':');
            String field = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1).replaceFirst("^ ", "");
            if ("data".equals(field)) data.append(value).append('\n');
            else if ("event".equals(field)) eventName = value;
            else if ("id".equals(field)) eventId = value;
        }
    }

    @PluginMethod public void stopSSE(PluginCall call) {
        String id = required(call, "streamId");
        if (id == null) return;
        Call stream = streams.remove(id);
        if (stream != null) stream.cancel();
        call.resolve();
    }

    @PluginMethod public void secureSet(PluginCall call) {
        String key = required(call, "key"); String value = required(call, "value");
        if (key == null || value == null) return;
        try { secureStore.set(key, value); call.resolve(); } catch (Exception error) { call.reject("Secure storage write failed", error); }
    }

    @PluginMethod public void secureGet(PluginCall call) {
        String key = required(call, "key"); if (key == null) return;
        try { JSObject result = new JSObject(); result.put("value", secureStore.get(key)); call.resolve(result); }
        catch (Exception error) { call.reject("Secure storage read failed", error); }
    }

    @PluginMethod public void secureRemove(PluginCall call) { String key = required(call, "key"); if (key != null) { secureStore.remove(key); call.resolve(); } }
    @PluginMethod public void secureClear(PluginCall call) { secureStore.clear(); call.resolve(); }

    @PluginMethod public void startBackgroundLocation(PluginCall call) {
        boolean foreground = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!foreground) { call.reject("Foreground location permission is required first"); return; }
        if (Build.VERSION.SDK_INT >= 29 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Grant 'Allow all the time' location access in app settings before starting background tracking"); return;
        }
        Intent service = new Intent(getContext(), LocationTrackingService.class).setAction(LocationTrackingService.ACTION_START)
            .putExtra("minTimeMs", call.getLong("minTimeMs", 30_000L))
            .putExtra("minDistanceM", call.getFloat("minDistanceM", 10f))
            .putExtra("maxBuffer", call.getInt("maxBuffer", 100));
        ContextCompat.startForegroundService(getContext(), service);
        JSObject result = new JSObject(); result.put("running", true); call.resolve(result);
    }

    @PluginMethod public void stopBackgroundLocation(PluginCall call) {
        getContext().startService(new Intent(getContext(), LocationTrackingService.class).setAction(LocationTrackingService.ACTION_STOP));
        call.resolve();
    }

    @PluginMethod public void getBackgroundLocationStatus(PluginCall call) {
        boolean foreground = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean background = Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        JSObject result = new JSObject();
        result.put("running", getContext().getSharedPreferences("nativekit_location_store", Context.MODE_PRIVATE).getBoolean("running", false));
        result.put("permission", foreground && background ? "granted" : foreground ? "foreground-only" : "denied");
        result.put("platform", "android");
        call.resolve(result);
    }

    @PluginMethod public void getBufferedLocations(PluginCall call) {
        String raw = getContext().getSharedPreferences("nativekit_location_store", Context.MODE_PRIVATE).getString("locations", "[]");
        JSObject result = new JSObject();
        try { result.put("locations", new JSArray(raw)); } catch (Exception ignored) { result.put("locations", new JSArray()); }
        call.resolve(result);
    }

    @PluginMethod public void clearBufferedLocations(PluginCall call) {
        getContext().getSharedPreferences("nativekit_location_store", Context.MODE_PRIVATE).edit().remove("locations").apply();
        call.resolve();
    }

    @PluginMethod public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) { call.reject("Unable to open app settings", error); }
    }

    // ───────────────────────────────────────────────────────────────────────
    // Phase 2: speech, scanning and device-hardware tools
    // ───────────────────────────────────────────────────────────────────────

    @PluginMethod
    public void ttsSpeak(PluginCall call) {
        final String text = required(call, "text");
        if (text == null) return;
        if (text.length() > 5000) { call.reject("text is limited to 5000 characters"); return; }
        final String language = call.getString("language", "bn-BD");
        final double pitch = call.getDouble("pitch", 1.0);
        final double rate = call.getDouble("rate", 1.0);
        whenTtsReady(call, () -> {
            try {
                int availability = tts.setLanguage(Locale.forLanguageTag(language));
                if (availability == TextToSpeech.LANG_MISSING_DATA || availability == TextToSpeech.LANG_NOT_SUPPORTED) {
                    // Speaking anyway would play garbage or silence; report the
                    // missing voice so the caller can guide the user instead.
                    JSObject out = new JSObject();
                    out.put("queued", false);
                    out.put("languageSupported", false);
                    call.resolve(out);
                    return;
                }
                tts.setPitch((float) pitch);
                tts.setSpeechRate((float) rate);
                int result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "nativekit-agent-" + System.currentTimeMillis());
                if (result == TextToSpeech.ERROR) { call.reject("The text-to-speech engine refused to speak"); return; }
                JSObject out = new JSObject();
                out.put("queued", true);
                out.put("languageSupported", true);
                call.resolve(out);
            } catch (Exception error) { call.reject("Speech failed: " + error.getMessage(), error); }
        });
    }

    /** Runs action once the TTS engine is ready; parks the call while the engine initialises. */
    private void whenTtsReady(PluginCall call, Runnable action) {
        if (ttsReady) { action.run(); return; }
        synchronized (pendingTts) { pendingTts.add(new Object[] { call, action }); }
        if (tts != null) return; // initialisation already in flight
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (!ttsReady) tts = null; // allow a later call to re-initialise the engine
            List<Object[]> drained;
            synchronized (pendingTts) { drained = new ArrayList<>(pendingTts); pendingTts.clear(); }
            for (Object[] pair : drained) {
                PluginCall pending = (PluginCall) pair[0];
                if (pending == null) continue;
                if (!ttsReady) { pending.reject("Text-to-speech engine failed to initialise"); continue; }
                ((Runnable) pair[1]).run();
            }
        });
    }

    @PluginMethod
    public void ttsStop(PluginCall call) {
        try {
            if (tts != null) tts.stop();
            call.resolve();
        } catch (Exception error) { call.reject("Speech could not be stopped", error); }
    }

    @PluginMethod
    public void listenSpeech(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("No foreground activity is available"); return; }
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) { call.reject("Speech recognition is not available on this device"); return; }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("recordAudio", call, "listenAfterPermission");
            return;
        }
        startListening(call);
    }

    @PermissionCallback
    private void listenAfterPermission(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startListening(call);
        } else {
            call.reject("Microphone permission was denied");
        }
    }

    /** Maps SpeechRecognizer error codes to a message a person can act on. */
    private static String speechErrorText(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH: return "no speech was matched — try speaking again a little louder";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "no speech input was detected in time";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "microphone permission is missing";
            case SpeechRecognizer.ERROR_AUDIO: return "the microphone could not be recorded (another app may hold it)";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "the recognition service is busy; try again shortly";
            case SpeechRecognizer.ERROR_NETWORK: return "the recognition service needs network access which is unavailable";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "the recognition service timed out on the network";
            case SpeechRecognizer.ERROR_SERVER: return "the recognition service returned a server error";
            case SpeechRecognizer.ERROR_CLIENT: return "the recognition client hit an internal error";
            default: return "speech recognition error " + error;
        }
    }

    private void startListening(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("No foreground activity is available"); return; }
        final String language = call.getString("language", "bn-BD");
        double requested = call.getDouble("timeoutMs", 12000.0);
        final long timeoutMs = (long) Math.max(2000.0, Math.min(60000.0, requested));
        activity.runOnUiThread(() -> {
            try {
                final SpeechRecognizer recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                final AtomicBoolean settled = new AtomicBoolean(false);
                final Handler handler = new Handler(Looper.getMainLooper());
                final Runnable timeout = () -> {
                    if (settled.compareAndSet(false, true)) {
                        recognizer.destroy();
                        call.reject("No speech was recognised before the timeout");
                    }
                };
                recognizer.setRecognitionListener(new RecognitionListener() {
                    @Override
                    public void onResults(Bundle results) {
                        if (!settled.compareAndSet(false, true)) return;
                        handler.removeCallbacks(timeout);
                        recognizer.destroy();
                        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        float[] scores = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                        JSObject out = new JSObject();
                        out.put("text", texts != null && !texts.isEmpty() ? texts.get(0) : "");
                        if (scores != null && scores.length > 0) out.put("confidence", (double) scores[0]);
                        call.resolve(out);
                    }

                    @Override
                    public void onError(int error) {
                        if (!settled.compareAndSet(false, true)) return;
                        recognizer.destroy();
                        call.reject("Speech recognition failed: " + speechErrorText(error));
                    }

                    @Override public void onReadyForSpeech(Bundle params) {}
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float rmsdB) {}
                    @Override public void onBufferReceived(byte[] buffer) {}
                    @Override public void onEndOfSpeech() {}
                    @Override public void onPartialResults(Bundle partialResults) {}
                    @Override public void onEvent(int eventType, Bundle params) {}
                });
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
                recognizer.startListening(intent);
                handler.postDelayed(timeout, timeoutMs);
            } catch (Exception error) { call.reject("Speech recognition failed to start: " + error.getMessage(), error); }
        });
    }

    @PluginMethod
    public void scanQrCode(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("No foreground activity is available"); return; }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("camera", call, "scanAfterPermission");
            return;
        }
        launchScanner(call);
    }

    @PermissionCallback
    private void scanAfterPermission(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchScanner(call);
        } else {
            call.reject("Camera permission was denied");
        }
    }

    private void launchScanner(PluginCall call) {
        try {
            Intent intent = new IntentIntegrator(getActivity())
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setBeepEnabled(true)
                .setPrompt("")
                .createScanIntent();
            startActivityForResult(call, intent, "scanQrResult");
        } catch (ActivityNotFoundException error) {
            call.reject("No barcode scanner is available on this device", error);
        } catch (Exception error) {
            call.reject("Scanner failed to start: " + error.getMessage(), error);
        }
    }

    @ActivityCallback
    private void scanQrResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) { call.reject("Scan was cancelled"); return; }
        IntentResult scan = IntentIntegrator.parseActivityResult(result.getResultCode(), result.getData());
        if (scan == null || scan.getContents() == null) { call.reject("Scan was cancelled"); return; }
        JSObject out = new JSObject();
        out.put("text", scan.getContents());
        out.put("format", scan.getFormatName());
        call.resolve(out);
    }

    @PluginMethod
    public void dialPhone(PluginCall call) {
        String number = required(call, "number");
        if (number == null) return;
        if (!number.replaceAll("[+\\d\\s().-]", "").isEmpty()) { call.reject("number may only contain digits, +, spaces and ( ) . -"); return; }
        Activity activity = getActivity();
        if (activity == null) { call.reject("No foreground activity is available"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + number.trim().replaceAll("\\s+", "")));
            activity.startActivity(intent);
            call.resolve();
        } catch (Exception error) { call.reject("Dialer could not be opened", error); }
    }

    /**
     * Opens a URL in the app chosen by the system (normally the browser).
     * Unlike window.open() from the WebView — which Android drops silently
     * unless a WebChromeClient implements onCreateWindow — this either opens
     * the URL or rejects the call so the tool can report a real error.
     * The JS caller has already validated the https: scheme.
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = required(call, "url");
        if (url == null) return;
        Activity activity = getActivity();
        if (activity == null) { call.reject("No foreground activity is available"); return; }
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            String tabsPackage = ("http".equals(scheme) || "https".equals(scheme)) ? customTabsPackage(activity) : null;
            if (tabsPackage != null) {
                // Custom Tab: in-app look (app-colored toolbar) + bottom-sheet slide
                // instead of a full app switch into the browser. Deliberately no
                // session/warmup AIDL — that would need the androidx.browser
                // dependency; this plain-intent path keeps dependencies at zero.
                intent.setPackage(tabsPackage);
                intent.putExtra("android.support.customtabs.extra.SESSION", (android.os.Parcelable) null);
                intent.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", 0xFF07111F);
            }
            try {
                android.app.ActivityOptions options = android.app.ActivityOptions.makeCustomAnimation(
                    activity, R.anim.nativekit_ct_slide_up_in, R.anim.nativekit_ct_none);
                activity.startActivity(intent, options.toBundle());
            } catch (Exception animationFailure) {
                activity.startActivity(intent);
            }
            call.resolve();
        } catch (Exception error) { call.reject("No app on this device could open that URL", error); }
    }

    // Default browser first (so cookies/sessions behave as the user expects), then
    // any installed Custom Tabs provider; null means plain ACTION_VIEW fallback.
    private static String customTabsPackage(android.content.Context context) {
        try {
            android.content.pm.PackageManager pm = context.getPackageManager();
            Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
            android.content.pm.ResolveInfo defaultHandler = pm.resolveActivity(view, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
            if (defaultHandler != null && defaultHandler.activityInfo != null
                && !"android".equals(defaultHandler.activityInfo.packageName)
                && supportsCustomTabs(pm, defaultHandler.activityInfo.packageName)) {
                return defaultHandler.activityInfo.packageName;
            }
            Intent service = new Intent("android.support.customtabs.action.CustomTabsService");
            java.util.List<android.content.pm.ResolveInfo> services = pm.queryIntentServices(service, 0);
            if (services != null) {
                for (android.content.pm.ResolveInfo info : services) {
                    if (info.serviceInfo != null && !"android".equals(info.serviceInfo.packageName)) {
                        return info.serviceInfo.packageName;
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private static boolean supportsCustomTabs(android.content.pm.PackageManager pm, String packageName) {
        try {
            Intent service = new Intent("android.support.customtabs.action.CustomTabsService");
            service.setPackage(packageName);
            java.util.List<android.content.pm.ResolveInfo> handlers = pm.queryIntentServices(service, 0);
            return handlers != null && !handlers.isEmpty();
        } catch (Exception error) { return false; }
    }

    @PluginMethod
    public void composeSms(PluginCall call) {
        String number = required(call, "number");
        if (number == null) return;
        String body = call.getString("body", "");
        Activity activity = getActivity();
        if (activity == null) { call.reject("No foreground activity is available"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + number.trim().replaceAll("\\s+", "")));
            if (body != null && !body.isEmpty()) intent.putExtra("sms_body", body);
            activity.startActivity(intent);
            call.resolve();
        } catch (Exception error) { call.reject("SMS composer could not be opened", error); }
    }

    @PluginMethod
    public void setTorch(PluginCall call) {
        Boolean on = call.getBoolean("on");
        if (on == null) { call.reject("on (boolean) is required"); return; }
        try {
            CameraManager cameras = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            if (cameras == null) { call.reject("No camera service is available"); return; }
            String chosen = null;
            for (String id : cameras.getCameraIdList()) {
                CameraCharacteristics characteristics = cameras.getCameraCharacteristics(id);
                Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK
                        && Boolean.TRUE.equals(characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE))) { chosen = id; break; }
            }
            if (chosen == null) { call.reject("No back camera with a flash unit was found"); return; }
            cameras.setTorchMode(chosen, on);
            call.resolve();
        } catch (Exception error) { call.reject("Torch could not be toggled: " + error.getMessage(), error); }
    }

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        try {
            JSObject out = new JSObject();
            Intent battery = getContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                if (level >= 0 && scale > 0) out.put("percent", level * 100 / scale);
                int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                out.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
                int plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1);
                out.put("plugged", plugged == BatteryManager.BATTERY_PLUGGED_AC || plugged == BatteryManager.BATTERY_PLUGGED_USB || plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS);
            }
            BatteryManager manager = (BatteryManager) getContext().getSystemService(Context.BATTERY_SERVICE);
            if (manager != null && !out.has("percent")) {
                Integer capacity = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                if (capacity != null && capacity > 0 && capacity <= 100) out.put("percent", capacity.intValue());
            }
            call.resolve(out);
        } catch (Exception error) { call.reject("Battery status could not be read", error); }
    }

    @PluginMethod
    public void pickDocument(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) { call.reject("No foreground activity is available"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            startActivityForResult(call, intent, "pickDocumentResult");
        } catch (Exception error) { call.reject("Document picker could not be opened", error); }
    }

    @ActivityCallback
    private void pickDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("No file was picked"); return; }
        // The copy can reach 25 MB; ActivityResult callbacks arrive on the main
        // thread, so the stream work moves to a worker thread (PluginCall
        // resolve/reject is thread-safe).
        final Uri data = result.getData().getData();
        Thread copier = new Thread(() -> copyPickedDocument(call, data), "nativekit-pick-copy");
        copier.setDaemon(true);
        copier.start();
    }

    private void copyPickedDocument(PluginCall call, Uri uri) {
        try {
            if (uri == null) { call.reject("No file was picked"); return; }
            String name = "picked-" + Long.toHexString(System.currentTimeMillis());
            Cursor cursor = null;
            try {
                cursor = getContext().getContentResolver().query(uri, null, null, null, null);
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (nameIndex >= 0) {
                        String displayName = cursor.getString(nameIndex);
                        if (displayName != null && !displayName.trim().isEmpty()) name = displayName.trim();
                    }
                }
            } finally {
                if (cursor != null) cursor.close();
            }
            String safe = name.replaceAll("[^A-Za-z0-9 ._()-]", "_");
            if (safe.isEmpty()) safe = "picked.bin";
            if (safe.length() > 120) {
                int dot = safe.lastIndexOf('.');
                String ext = dot > 0 ? safe.substring(dot) : "";
                safe = safe.substring(0, Math.max(1, 110 - ext.length())) + ext;
            }
            File dir = new File(getContext().getFilesDir(), "agent/workspace/picked");
            if (!dir.exists() && !dir.mkdirs()) { call.reject("Could not create the workspace picked directory"); return; }
            File target = new File(dir, safe);
            if (target.exists()) target = new File(dir, Long.toHexString(System.currentTimeMillis()) + "-" + safe);
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 OutputStream out = new FileOutputStream(target)) {
                if (in == null) { call.reject("The picked file could not be opened"); return; }
                byte[] buffer = new byte[16384];
                long total = 0;
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                    total += read;
                    if (total > 26214400L) throw new java.io.IOException("picked file exceeds the 25 MB limit");
                }
            }
            JSObject out2 = new JSObject();
            out2.put("path", "picked/" + target.getName());
            out2.put("bytes", target.length());
            call.resolve(out2);
        } catch (Exception error) { call.reject("The picked file could not be saved: " + error.getMessage(), error); }
    }

    @PluginMethod
    public void clipboardSetText(PluginCall call) {
        String text = required(call, "text");
        if (text == null) return;
        try {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null) { call.reject("No clipboard service is available"); return; }
            clipboard.setPrimaryClip(ClipData.newPlainText("agent", text));
            call.resolve();
        } catch (Exception error) { call.reject("Clipboard write failed: " + error.getMessage(), error); }
    }

    @PluginMethod
    public void clipboardGetText(PluginCall call) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            JSObject out = new JSObject();
            out.put("text", "");
            if (clipboard != null && clipboard.hasPrimaryClip()) {
                android.content.ClipDescription description = clipboard.getPrimaryClipDescription();
                if (description != null && description.hasMimeType(android.content.ClipDescription.MIMETYPE_TEXT_PLAIN)) {
                    CharSequence text = clipboard.getPrimaryClip().getItemAt(0).coerceToText(getContext());
                    if (text != null) out.put("text", text.toString());
                }
            }
            call.resolve(out);
        } catch (Exception error) { call.reject("Clipboard read failed: " + error.getMessage(), error); }
    }

    private String required(PluginCall call, String key) {
        String value = call.getString(key);
        if (value == null || value.isEmpty()) { call.reject(key + " is required"); return null; }
        return value;
    }

    private JSObject streamEvent(String streamId, String format) {
        JSObject event = new JSObject(); event.put("streamId", streamId); event.put("format", format); return event;
    }
}
