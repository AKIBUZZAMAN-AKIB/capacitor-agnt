package com.t6x.plugins.phonebuddy;

import com.sun.jna.Callback;
import com.sun.jna.Pointer;

/** `typedef void (*PbWebViewFetchCallback)(const char *call_id, const char *request_json, void *user_data);` */
public interface PbWebViewFetchCallback extends Callback {
    void invoke(String callId, String requestJson, Pointer userData);
}
