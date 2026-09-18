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
