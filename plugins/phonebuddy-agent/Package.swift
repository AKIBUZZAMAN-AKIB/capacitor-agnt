// swift-tools-version: 5.9
//
// PhoneBuddy agent engine for iOS — SwiftPM manifest.
//
// The Rust static library comes from the PUBLIC SDK source
// (github.com/APUS-AI-Lab/PhoneBuddySDK, pinned tag v0.2.0, Apache-2.0) and is
// rebuilt on demand by:
//
//   tools/agent-ffi/build-phonebuddy-ios-xcframework.sh
//   .github/workflows/phonebuddy-ios.yml        (macOS runner, commits the result)
//
// into ios/Frameworks/PhoneBuddyFFI.xcframework.
//
// Why a separate `phone_buddy_ffi` C target instead of importing the
// xcframework's headers directly: under SwiftPM the headers of a `binaryTarget`
// are NOT importable as a module from Swift (same reason the pinned native-agent
// plugin carries a `native_agent_ffiFFI` shim target). The C target here
// re-exports the cbindgen header as the module `phone_buddy_ffi` (kept
// byte-identical to native/include/phone_buddy.h — a test enforces that), and
// depends on the binary target so the Swift code and the linked Rust library can
// never disagree about the ABI.
//
// Both the binary target and the C target are declared ONLY when the
// xcframework exists: SwiftPM refuses to resolve a package whose binaryTarget
// path is missing, which would break `npm run sync` and the iOS CI job on any
// checkout where the framework has not been built yet. Until then the Swift
// plugin compiles its `#else` half and answers `unavailable` / `available: false`
// instead of pretending — the JS bridge then falls back to its documented
// envelope instead of promising background work that would never run.
import Foundation
import PackageDescription

let ffiFrameworkPath = "ios/Frameworks/PhoneBuddyFFI.xcframework"
let hasFFI = FileManager.default.fileExists(atPath: ffiFrameworkPath)

var targets: [Target] = []

if hasFFI {
    targets.append(.binaryTarget(name: "PhoneBuddyFFI", path: ffiFrameworkPath))
    targets.append(
        .target(
            name: "phone_buddy_ffi",
            dependencies: ["PhoneBuddyFFI"],
            path: "ios/Sources/phone_buddy_ffi",
            publicHeadersPath: "include"
        )
    )
}

targets.append(
    .target(
        name: "PhoneBuddyAgentPlugin",
        dependencies: [
            .product(name: "Capacitor", package: "capacitor-swift-pm"),
            .product(name: "Cordova", package: "capacitor-swift-pm"),
        ] + (hasFFI ? [.target(name: "phone_buddy_ffi")] : []),
        path: "ios/Sources/PhoneBuddyAgentPlugin",
        linkerSettings: [.linkedLibrary("iconv")]
    )
)

let package = Package(
    name: "NativekitPhonebuddyAgent",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "NativekitPhonebuddyAgent",
            targets: ["PhoneBuddyAgentPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0")
    ],
    targets: targets
)
