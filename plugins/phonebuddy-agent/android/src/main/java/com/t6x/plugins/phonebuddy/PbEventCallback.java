package com.t6x.plugins.phonebuddy;

import com.sun.jna.Callback;
import com.sun.jna.Pointer;

/**
 * JNA callbacks for the PhoneBuddy C ABI — declared in Java on purpose: Kotlin's
 * SAM conversion only applies to Java interfaces, so a Kotlin `PbEventCallback`
 * made every `PbEventCallback { ... }` call site fail with
 * "Interface 'PbEventCallback : Callback' does not have constructors".
 *
 * Signature (native/include/phone_buddy.h):
 *   typedef void (*PbEventCallback)(const char *event_json, void *user_data);
 *
 * `event_json` is valid only for the duration of the call and JNA may invoke this
 * on an engine worker thread — never touch UI from here. JNA keeps only a weak
 * reference to the callback, so the caller must hold a strong reference for as
 * long as the engine can fire it.
 */
public interface PbEventCallback extends Callback {
    void invoke(String eventJson, Pointer userData);
}
