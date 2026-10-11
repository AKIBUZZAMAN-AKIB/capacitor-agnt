// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NativekitWidget",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "NativekitWidget",
            targets: ["NativeKitWidgetPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3")
    ],
    targets: [
        .target(
            name: "NativeKitWidgetPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/NativeKitWidgetPlugin")
    ]
)
