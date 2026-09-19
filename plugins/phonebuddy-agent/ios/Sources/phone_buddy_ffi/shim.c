// Intentionally empty: this target only re-exports the PhoneBuddy C header
// (phone_buddy.h) as the Swift module `phone_buddy_ffi` and links the Rust
// static library produced by tools/agent-ffi/build-phonebuddy-ios-xcframework.sh.
// SwiftPM expects one translation unit per C target — without a .c file Xcode
// looks for `phone_buddy_ffi.o`, which is never produced.
