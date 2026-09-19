# UniFFI + JNA dynamic mapping: keep the generated bindings, callbacks and the
# JNA dispatcher classes reachable when the host app minifies.
-keep class uniffi.** { *; }
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-keep class com.t6x.plugins.nativeagent.** { *; }
-dontwarn java.awt.**
