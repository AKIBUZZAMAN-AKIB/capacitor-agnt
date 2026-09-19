# PhoneBuddy agent plugin — R8/ProGuard rules exported to host apps.

# JNA reaches com.sun.jna.* reflectively; without these rules a minified release
# build fails at runtime with NoClassDefFoundError / UnsatisfiedLinkError.
-keep class com.sun.jna.** { *; }
-keep interface com.sun.jna.** { *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# The FFI interface and its callbacks are implemented in Kotlin and invoked from
# native code through JNA's callback proxy — keep their names and signatures.
-keep class com.t6x.plugins.phonebuddy.PhoneBuddyLib { *; }
-keep interface com.t6x.plugins.phonebuddy.PhoneBuddyLib { *; }
-keep interface com.t6x.plugins.phonebuddy.Pb*Callback { *; }
-keep class com.t6x.plugins.phonebuddy.PhoneBuddyAgentPlugin { *; }

# The wake JobService is instantiated by the OS from the manifest.
-keep class com.t6x.plugins.phonebuddy.PhoneBuddyWakeService { *; }
