// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0"),
        .package(name: "CapacitorCommunitySqlite", path: "../../../node_modules/@capacitor-community/sqlite"),
        .package(name: "CapacitorTranceeNearbyConnections", path: "../../../node_modules/@capacitor-trancee/nearby-connections"),
        .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app"),
        .package(name: "CapacitorBackgroundRunner", path: "../../../node_modules/@capacitor/background-runner"),
        .package(name: "CapacitorCamera", path: "../../../node_modules/@capacitor/camera"),
        .package(name: "CapacitorFileTransfer", path: "../../../node_modules/@capacitor/file-transfer"),
        .package(name: "CapacitorFilesystem", path: "../../../node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorGeolocation", path: "../../../node_modules/@capacitor/geolocation"),
        .package(name: "CapacitorHaptics", path: "../../../node_modules/@capacitor/haptics"),
        .package(name: "CapacitorKeyboard", path: "../../../node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorLocalNotifications", path: "../../../node_modules/@capacitor/local-notifications"),
        .package(name: "CapacitorNetwork", path: "../../../node_modules/@capacitor/network"),
        .package(name: "CapacitorPreferences", path: "../../../node_modules/@capacitor/preferences"),
        .package(name: "CapacitorPushNotifications", path: "../../../node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorShare", path: "../../../node_modules/@capacitor/share"),
        .package(name: "CapgoCapacitorInappbrowser", path: "../../../node_modules/@capgo/capacitor-inappbrowser"),
        .package(name: "NativekitCustomNative", path: "../../../plugins/custom-native"),
        .package(name: "NativekitIsolatedBrowser", path: "../../../plugins/isolated-browser"),
        .package(name: "NativekitPhonebuddyAgent", path: "../../../plugins/phonebuddy-agent"),
        .package(name: "NativekitWidget", path: "../../../plugins/widget"),
        .package(name: "CapacitorNativeAgent", path: "../../../plugins/native-agent")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorCommunitySqlite", package: "CapacitorCommunitySqlite"),
                .product(name: "CapacitorTranceeNearbyConnections", package: "CapacitorTranceeNearbyConnections"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBackgroundRunner", package: "CapacitorBackgroundRunner"),
                .product(name: "CapacitorCamera", package: "CapacitorCamera"),
                .product(name: "CapacitorFileTransfer", package: "CapacitorFileTransfer"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorGeolocation", package: "CapacitorGeolocation"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorLocalNotifications", package: "CapacitorLocalNotifications"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapgoCapacitorInappbrowser", package: "CapgoCapacitorInappbrowser"),
                .product(name: "NativekitCustomNative", package: "NativekitCustomNative"),
                .product(name: "NativekitIsolatedBrowser", package: "NativekitIsolatedBrowser"),
                .product(name: "NativekitPhonebuddyAgent", package: "NativekitPhonebuddyAgent"),
                .product(name: "NativekitWidget", package: "NativekitWidget"),
                .product(name: "CapacitorNativeAgent", package: "CapacitorNativeAgent")
            ]
        )
    ]
)
