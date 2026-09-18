// swift-tools-version: 5.9
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
        // NOTE: capacitor-lancedb is intentionally NOT a hard dependency here.
        // The previous manifest used `.package(path: "../capacitor-lancedb")`,
        // which made SwiftPM resolution fail for every host that did not have
        // the (optional!) capacitor-lancedb plugin installed as a sibling —
        // the package was then unusable via SwiftPM at all. The LanceDB-backed
        // memory provider degrades gracefully: the sources guard it with
        // `#if canImport(...)` and fall back to a no-op when the module is
        // absent. Hosts that want memory on iOS should integrate
        // capacitor-lancedb themselves and expose its module to this target.
    ],
    targets: [
        .binaryTarget(
            name: "NativeAgentFFI",
            path: "ios/Frameworks/NativeAgentFFI.xcframework"
        ),
        // Exposes the UniFFI C header as a Swift-importable module. The
        // generated native_agent_ffi.swift does `#if canImport(native_agent_ffiFFI)`
        // and its types (RustBuffer, RustCallStatus, ...) come from there.
        // A binaryTarget's headers are NOT automatically importable from Swift
        // under SwiftPM, so without this target the build fails with
        // "cannot find type 'RustBuffer' in scope". The CocoaPods path solves
        // the same problem with an -fmodule-map-file flag in the podspec.
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
