package com.t6x.plugins.phonebuddy;

import com.sun.jna.Callback;
import com.sun.jna.Pointer;

/** `typedef void (*PbLlmRequestCallback)(const char *request_id, const char *request_json, void *user_data);` */
public interface PbLlmRequestCallback extends Callback {
    void invoke(String requestId, String requestJson, Pointer userData);
}
