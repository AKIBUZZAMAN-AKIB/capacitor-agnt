package com.t6x.plugins.phonebuddy;

import com.sun.jna.Callback;

/** `typedef void (*PbLogCallback)(int32_t level, const char *target, const char *message);` */
public interface PbLogCallback extends Callback {
    void invoke(int level, String target, String message);
}
