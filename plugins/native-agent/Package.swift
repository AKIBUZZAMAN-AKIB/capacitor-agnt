// swift-tools-version: 5.9
//
// NOTE: this manifest declares NO dependency on capacitor-lancedb (or any vector
// database). The agent's long-term memory is implemented in-repo by
// MemoryProviderImpl.swift — a file-backed store with lexical search — so the
// plugin has no optional native dependency to resolve.
import PackageDescription

let package = Package(
    name: "CapacitorNativeAgent",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "CapacitorNativeAgent",
            targets: ["NativeAgentPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .binaryTarget(
            name: "NativeAgentFFI",
            path: "ios/Frameworks/NativeAgentFFI.xcframework"
        ),
        // Exposes the UniFFI C header as a Swift-importable module. The generated
        // native_agent_ffi.swift does `#if canImport(native_agent_ffiFFI)` and its
        // low-level types (RustBuffer, RustCallStatus, ...) plus the checksum
        // functions come from there. A binaryTarget's headers are NOT importable
        // from Swift under SwiftPM, so without this target the iOS build fails with
        // "cannot find 'uniffi_native_agent_ffi_checksum_...' in scope".
        // The header here is a byte-for-byte copy of the one inside the
        // xcframework, so it always matches the Rust binary that is linked.
        .target(
            name: "native_agent_ffiFFI",
            dependencies: ["NativeAgentFFI"],
            path: "ios/Sources/native_agent_ffiFFI"
        ),
        .target(
            name: "NativeAgentPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "NativeAgentFFI",
                "native_agent_ffiFFI"
            ],
            path: "ios/Sources/NativeAgentPlugin",
            exclude: [
                "Generated/native_agent_ffiFFI.modulemap",
                "Generated/native_agent_ffiFFI.h"
            ],
            linkerSettings: [
                .linkedLibrary("iconv"),
            ]
        )
    ]
)
