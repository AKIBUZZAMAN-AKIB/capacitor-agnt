package dev.nativekit.isolatedbrowser;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Process;
import android.os.RemoteException;
import android.os.SystemClock;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class IsolatedBrowserBrokerService extends Service {
    static final int MSG_REGISTER = 1;
    static final int MSG_STATUS = 4;
    static final int MSG_CLOSE = 5;
    static final int MSG_REQUEST_CHUNK = 6;
    static final int MSG_RESPONSE_CHUNK = 7;
    static final int MSG_PERMISSION_PROMPT = 8;
    static final int MSG_PERMISSION_RESULT = 9;
    static final int MSG_PERMISSION_DISMISS = 10;
    static final int MSG_EVAL_REQUEST = 11;
    static final int MSG_EVAL_RESPONSE = 12;

    static final int MAX_MESSAGE_CHARS = 2_800_000;
    static final int MAX_IPC_CHUNK_CHARS = 120_000;
    private static final int MAX_TRANSFER_CHUNKS = 32;
    private static final int MAX_ACTIVE_TRANSFERS = 8;
    private static final int MAX_ORIGIN_CHARS = 512;
    private static final long TRANSFER_TIMEOUT_MS = 30_000L;

    interface Listener {
        void onRequest(String sessionId, String appId, String token, String origin, String request);
        void onStatus(String sessionId, String appId, String state, String reason);
    }

    interface PermissionCallback {
        void onResult(String action, String error);
    }

    private static final class PendingPermission {
        final String sessionId;
        final PermissionCallback callback;
        PendingPermission(String sessionId, PermissionCallback callback) {
            this.sessionId = sessionId;
            this.callback = callback;
        }
    }

    private static final class SessionRecord {
        final String sessionId;
        final String appId;
        final String token;
        final String rendererToken;
        final OrderedChunkAccumulator incoming = new OrderedChunkAccumulator(
            MAX_IPC_CHUNK_CHARS, MAX_MESSAGE_CHARS, MAX_TRANSFER_CHUNKS,
            MAX_ACTIVE_TRANSFERS, MAX_ORIGIN_CHARS, TRANSFER_TIMEOUT_MS
        );
        volatile Messenger client;
        volatile IBinder clientBinder;
        volatile IBinder.DeathRecipient deathRecipient;

        SessionRecord(String sessionId, String appId, String token, String rendererToken) {
            this.sessionId = sessionId;
            this.appId = appId;
            this.token = token;
            this.rendererToken = rendererToken;
        }
    }

    private static final Map<String, SessionRecord> sessions = new ConcurrentHashMap<>();
    private static final Map<String, PendingPermission> pendingPermissions = new ConcurrentHashMap<>();
    private static final Map<String, PendingEval> pendingEvals = new ConcurrentHashMap<>();

    interface EvalCallback {
        void onResult(String result, String error);
    }

    private static final class PendingEval {
        final String sessionId;
        final EvalCallback callback;
        PendingEval(String sessionId, EvalCallback callback) { this.sessionId = sessionId; this.callback = callback; }
    }
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static volatile Listener listener;

    static void setListener(Listener next) { listener = next; }

    static void registerSession(String sessionId, String appId, String token, String rendererToken) {
        SessionRecord next = new SessionRecord(sessionId, appId, token, rendererToken);
        SessionRecord previous = sessions.put(sessionId, next);
        if (previous != null) retire(previous, true);
    }

    static void unregisterSession(String sessionId, boolean closeClient) {
        SessionRecord record = sessions.remove(sessionId);
        if (record != null) retire(record, closeClient);
        cancelPermissions(sessionId, "The isolated app session was closed");
        cancelEvals(sessionId, "The isolated app session was closed");
    }

    static boolean requestPermission(
        String sessionId,
        String requestId,
        String appName,
        String capability,
        String method,
        String argumentSummary,
        long timeoutMs,
        PermissionCallback callback
    ) {
        SessionRecord record = sessions.get(sessionId);
        Messenger client;
        IBinder clientBinder;
        if (record == null || requestId.length() > 100 || appName.length() > 120 || capability.length() > 80 || method.length() > 200 || argumentSummary.length() > 1_500) return false;
        synchronized (record) {
            client = record.client;
            clientBinder = record.clientBinder;
            if (sessions.get(sessionId) != record || client == null || clientBinder == null) return false;
        }
        PendingPermission pending = new PendingPermission(sessionId, callback);
        if (pendingPermissions.putIfAbsent(requestId, pending) != null) return false;
        Bundle data = identityBundle(record);
        data.putString("requestId", requestId);
        data.putString("appName", appName);
        data.putString("capability", capability);
        data.putString("method", method);
        data.putString("argumentSummary", argumentSummary);
        data.putLong("timeoutMs", Math.max(1_000L, Math.min(120_000L, timeoutMs)));
        Message output = Message.obtain(null, MSG_PERMISSION_PROMPT);
        output.setData(data);
        try {
            client.send(output);
            mainHandler.postDelayed(() -> {
                PendingPermission expired = pendingPermissions.remove(requestId);
                if (expired == pending) expired.callback.onResult(null, "Trusted permission prompt timed out");
            }, Math.max(1_000L, Math.min(120_000L, timeoutMs)));
            return true;
        } catch (RemoteException error) {
            pendingPermissions.remove(requestId, pending);
            reportProcessGone(record, clientBinder, "permission transport failed");
            return false;
        }
    }

    static boolean dismissPermission(String sessionId, String requestId) {
        SessionRecord record = sessions.get(sessionId);
        if (record == null) return false;
        PendingPermission pending = pendingPermissions.get(requestId);
        if (pending != null && (!pending.sessionId.equals(sessionId) || !pendingPermissions.remove(requestId, pending))) return false;
        if (pending != null) pending.callback.onResult(null, "Permission request was resolved by the trusted host");
        Messenger client;
        synchronized (record) {
            client = record.client;
            if (sessions.get(sessionId) != record || client == null) return false;
        }
        Message output = Message.obtain(null, MSG_PERMISSION_DISMISS);
        Bundle data = identityBundle(record);
        data.putString("requestId", requestId);
        output.setData(data);
        try { client.send(output); return true; }
        catch (RemoteException error) { return false; }
    }

    static boolean requestEval(String sessionId, String evalId, String script, EvalCallback callback) {
        SessionRecord record = sessions.get(sessionId);
        if (record == null || evalId.length() > 100 || script.length() > 200_000) return false;
        Messenger client;
        IBinder clientBinder;
        synchronized (record) {
            client = record.client;
            clientBinder = record.clientBinder;
            if (sessions.get(sessionId) != record || client == null || clientBinder == null) return false;
        }
        PendingEval pending = new PendingEval(sessionId, callback);
        if (pendingEvals.putIfAbsent(evalId, pending) != null) return false;
        Bundle data = identityBundle(record);
        data.putString("evalId", evalId);
        data.putString("script", script);
        Message output = Message.obtain(null, MSG_EVAL_REQUEST);
        output.setData(data);
        try {
            client.send(output);
            mainHandler.postDelayed(() -> {
                PendingEval expired = pendingEvals.remove(evalId);
                if (expired == pending) expired.callback.onResult(null, "Eval timed out");
            }, 15_000L);
            return true;
        } catch (RemoteException error) {
            pendingEvals.remove(evalId, pending);
            reportProcessGone(record, clientBinder, "eval transport failed");
            return false;
        }
    }

    static boolean deliver(String sessionId, String value) {
        SessionRecord record = sessions.get(sessionId);
        Messenger client;
        IBinder clientBinder;
        if (record == null || value == null || value.length() > MAX_MESSAGE_CHARS) return false;
        synchronized (record) {
            client = record.client;
            clientBinder = record.clientBinder;
            if (sessions.get(sessionId) != record || client == null || clientBinder == null) return false;
        }
        String transferId = java.util.UUID.randomUUID().toString();
        int count = Math.max(1, (value.length() + MAX_IPC_CHUNK_CHARS - 1) / MAX_IPC_CHUNK_CHARS);
        try {
            for (int index = 0; index < count; index++) {
                int start = index * MAX_IPC_CHUNK_CHARS;
                int end = Math.min(value.length(), start + MAX_IPC_CHUNK_CHARS);
                Bundle data = identityBundle(record);
                data.putString("transferId", transferId);
                data.putInt("index", index);
                data.putInt("count", count);
                data.putString("chunk", value.substring(start, end));
                Message output = Message.obtain(null, MSG_RESPONSE_CHUNK);
                output.setData(data);
                synchronized (record) {
                    if (sessions.get(sessionId) != record || record.clientBinder != clientBinder || record.client != client) return false;
                }
                client.send(output);
            }
            return true;
        } catch (RemoteException error) {
            reportProcessGone(record, clientBinder, "response transport failed");
            return false;
        }
    }

    private final Handler handler = new Handler(Looper.getMainLooper(), this::handleMessage);
    private final Messenger messenger = new Messenger(handler);

    @Override public IBinder onBind(Intent intent) { return messenger.getBinder(); }

    private boolean handleMessage(Message message) {
        if (message.sendingUid != Process.myUid() && message.sendingUid != 0) return true;
        Bundle data = message.getData();
        String sessionId = data.getString("sessionId", "");
        String rendererToken = data.getString("rendererToken", "");
        SessionRecord record = sessions.get(sessionId);
        if (record == null || !constantTimeEquals(record.rendererToken, rendererToken)) return true;

        if (message.what == MSG_REGISTER) {
            if (message.replyTo == null) return true;
            synchronized (record) {
                if (sessions.get(sessionId) != record) return true;
                unlinkDeath(record);
                record.client = message.replyTo;
                IBinder binder = message.replyTo.getBinder();
                record.clientBinder = binder;
                record.deathRecipient = () -> reportProcessGone(record, binder, "isolated Android process exited");
                try { binder.linkToDeath(record.deathRecipient, 0); }
                catch (RemoteException error) {
                    reportProcessGone(record, binder, "isolated Android process was already dead");
                    return true;
                }
                notifyStatus(record, "connected", "");
            }
            return true;
        }
        if (message.what == MSG_REQUEST_CHUNK) {
            acceptRequestChunk(record, data);
            return true;
        }
        if (message.what == MSG_STATUS) {
            notifyStatus(record, data.getString("state", "unknown"), data.getString("reason", ""));
            return true;
        }
        if (message.what == MSG_EVAL_RESPONSE) {
            String evalId = data.getString("evalId", "");
            String result = data.getString("result", "");
            String error = data.getString("error", "");
            PendingEval pending = pendingEvals.get(evalId);
            if (pending != null && pendingEvals.remove(evalId, pending)) {
                if (error != null && !error.isEmpty()) pending.callback.onResult(null, error);
                else pending.callback.onResult(result, null);
            }
            return true;
        }
        if (message.what == MSG_PERMISSION_RESULT) {
            String requestId = data.getString("requestId", "");
            String action = data.getString("action", "");
            if (!"allow_once".equals(action) && !"allow_always".equals(action) && !"block_once".equals(action) && !"block_always".equals(action)) return true;
            PendingPermission pending = pendingPermissions.get(requestId);
            if (pending != null && pending.sessionId.equals(record.sessionId) && pendingPermissions.remove(requestId, pending)) {
                pending.callback.onResult(action, null);
            }
            return true;
        }
        return true;
    }

    private void acceptRequestChunk(SessionRecord record, Bundle data) {
        String transferId = data.getString("transferId", "");
        String origin = data.getString("origin", "");
        int index = data.getInt("index", -1);
        try {
            OrderedChunkAccumulator.Result result;
            synchronized (record) {
                if (sessions.get(record.sessionId) != record) return;
                result = record.incoming.accept(
                    transferId,
                    origin,
                    index,
                    data.getInt("count", -1),
                    data.getString("chunk"),
                    SystemClock.elapsedRealtime()
                );
            }
            if (result.complete) {
                dispatchRequest(record, origin, result.value);
            } else if (index == 0) {
                handler.postDelayed(() -> {
                    synchronized (record) {
                        if (sessions.get(record.sessionId) == record && record.incoming.pruneExpired(SystemClock.elapsedRealtime()) > 0) {
                            notifyStatus(record, "protocolError", "request transfer timed out");
                        }
                    }
                }, TRANSFER_TIMEOUT_MS + 1L);
            }
        } catch (IllegalArgumentException error) {
            notifyStatus(record, "protocolError", error.getMessage() == null ? "invalid request transfer" : error.getMessage());
        }
    }

    private static void dispatchRequest(SessionRecord record, String origin, String request) {
        if (request.length() < 2 || request.length() > MAX_MESSAGE_CHARS) {
            notifyStatus(record, "protocolError", "request exceeded the IPC envelope limit");
            return;
        }
        synchronized (record) {
            if (sessions.get(record.sessionId) != record) return;
            Listener active = listener;
            if (active != null) active.onRequest(record.sessionId, record.appId, record.token, origin, request);
        }
    }

    private static Bundle identityBundle(SessionRecord record) {
        Bundle data = new Bundle();
        data.putString("sessionId", record.sessionId);
        data.putString("rendererToken", record.rendererToken);
        return data;
    }

    private static void notifyStatus(SessionRecord record, String state, String reason) {
        if (sessions.get(record.sessionId) != record) return;
        Listener active = listener;
        if (active != null) active.onStatus(record.sessionId, record.appId, state, reason);
    }

    private static void reportProcessGone(SessionRecord record, IBinder expectedBinder, String reason) {
        synchronized (record) {
            if (sessions.get(record.sessionId) != record || expectedBinder == null || record.clientBinder != expectedBinder) return;
            unlinkDeath(record);
            record.client = null;
            record.incoming.clear();
            notifyStatus(record, "processGone", reason);
        }
        cancelPermissions(record.sessionId, reason);
    }

    private static void cancelEvals(String sessionId, String reason) {
        for (Map.Entry<String, PendingEval> entry : pendingEvals.entrySet()) {
            PendingEval pending = entry.getValue();
            if (pending.sessionId.equals(sessionId) && pendingEvals.remove(entry.getKey(), pending)) pending.callback.onResult(null, reason);
        }
    }

    private static void cancelPermissions(String sessionId, String reason) {
        for (Map.Entry<String, PendingPermission> entry : pendingPermissions.entrySet()) {
            PendingPermission pending = entry.getValue();
            if (pending.sessionId.equals(sessionId) && pendingPermissions.remove(entry.getKey(), pending)) pending.callback.onResult(null, reason);
        }
        cancelEvals(sessionId, reason);
    }

    private static void retire(SessionRecord record, boolean closeClient) {
        Messenger client;
        synchronized (record) {
            client = record.client;
            unlinkDeath(record);
            record.client = null;
            record.incoming.clear();
        }
        if (closeClient && client != null) {
            Message close = Message.obtain(null, MSG_CLOSE);
            close.setData(identityBundle(record));
            try { client.send(close); } catch (RemoteException ignored) {}
        }
    }

    private static void unlinkDeath(SessionRecord record) {
        synchronized (record) {
            IBinder binder = record.clientBinder;
            IBinder.DeathRecipient recipient = record.deathRecipient;
            if (binder != null && recipient != null) {
                try { binder.unlinkToDeath(recipient, 0); } catch (Exception ignored) {}
            }
            record.clientBinder = null;
            record.deathRecipient = null;
        }
    }

    static boolean constantTimeEquals(String left, String right) {
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
