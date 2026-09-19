package com.t6x.plugins.phonebuddy;

import com.sun.jna.Callback;
import com.sun.jna.Pointer;

/** `typedef void (*PbHostToolCallback)(const char *call_id, const char *name, const char *arguments_json, void *user_data);` */
public interface PbHostToolCallback extends Callback {
    void invoke(String callId, String name, String argumentsJson, Pointer userData);
}
