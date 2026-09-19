// swift-tools-version: 5.9
//
// NOTE: this manifest deliberately declares NO dependency on capacitor-lancedb.
// The LanceDB-backed memory provider is optional and its Swift sources are
// guarded with `#if canImport(CapacitorLanceDB)`; a hard local-path dependency
// here would break SwiftPM resolution for every host app that does not vendor
// the lancedb plugin (backported fix — docs/AGENT-ENGINE-0.5.2-BACKPORT.bn.md).
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
        .target(
            name: "NativeAgentPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "NativeAgentFFI"
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
