# UniFFI (JNA-based) FFI surface must survive R8 in host release builds.
# JNA resolves cdylib symbols through generated Library interfaces and
# instantiates callbacks reflectively — shrinking breaks both silently.
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.Callback { *; }
-keep class uniffi.** { *; }
-keep class com.t6x.plugins.nativeagent.** { *; }
