import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await fs.readFile(path.join(root, 'app.config.json'), 'utf8'));
const wc = config.widget ?? { enabled: false, homeScreen: { enabled: false, resizeEnabled: true, updatePeriodMinutes: 30, kinds: [] }, floating: { enabled: false, title: '', page: '', width: 240, height: 220, startOnLaunch: false } };

// Must match NativeAgentBackgroundTask.taskIdentifier in the native-agent plugin
// (plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentBackgroundTask.swift).
const AGENT_WAKE_TASK_ID = 'io.t6x.nativeagent.wake';
// The identifier is only whitelisted (and the launch handler only registered)
// when the registrar really ships with the plugin: whitelisting an id nobody
// registers would promise iOS background agent runs that can never happen, and
// registering an id that is not whitelisted kills the process. The check keeps
// the two halves locked together.
const agentWakeTaskFile = path.join(
  root,
  'plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentBackgroundTask.swift',
);
const agentWakeSupported = config.features.agent === true && existsSync(agentWakeTaskFile);

const xml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const exists = async (target) => fs.access(target).then(() => true).catch(() => false);

async function findFiles(dir, fileName) {
  if (!(await exists(dir))) return [];
  const found = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...await findFiles(target, fileName));
    else if (item.name === fileName) found.push(target);
  }
  return found;
}

function androidPermissions() {
  const f = config.features;
  const a = config.android;
  const permissions = new Set([
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE'
  ]);

  if (f.camera) permissions.add('android.permission.CAMERA');
  if (f.location || f.backgroundLocation) {
    permissions.add('android.permission.ACCESS_COARSE_LOCATION');
    permissions.add('android.permission.ACCESS_FINE_LOCATION');
  }
  if (f.localNotifications || f.pushNotificationsReady || f.advancedAlarms || f.backgroundLocation) {
    permissions.add('android.permission.POST_NOTIFICATIONS');
  }
  if (f.advancedAlarms) {
    permissions.add('android.permission.VIBRATE');
    permissions.add('android.permission.WAKE_LOCK');
    permissions.add('android.permission.RECEIVE_BOOT_COMPLETED');
    permissions.add('android.permission.FOREGROUND_SERVICE');
    permissions.add('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
    if (a.exactAlarmPermissionMode === 'schedule') permissions.add('android.permission.SCHEDULE_EXACT_ALARM');
    if (a.exactAlarmPermissionMode === 'use') permissions.add('android.permission.USE_EXACT_ALARM');
    if (a.fullScreenAlarm) permissions.add('android.permission.USE_FULL_SCREEN_INTENT');
  }
  if (f.backgroundLocation && a.backgroundLocationForegroundService) {
    permissions.add('android.permission.ACCESS_BACKGROUND_LOCATION');
    permissions.add('android.permission.FOREGROUND_SERVICE');
    permissions.add('android.permission.FOREGROUND_SERVICE_LOCATION');
  }
  return [...permissions];
}

function androidManifest() {
  const permissions = androidPermissions().map((name) => `    <uses-permission android:name="${name}" />`).join('\n');
  // @capacitor/filesystem refuses public/external storage calls unless these are DECLARED
  // (its manifest check ignores maxSdkVersion, so caps keep them Play-safe and no-op on
  // modern Android). App-scoped directories (Data/Library) need no permission at all.
  const legacyStorage = config.features.filesystem
    ? '\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />'
      + '\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />'
    : '';
  const widgetFeature = config.features.widget && wc.enabled;
  // Home-screen widgets need one <receiver> per declared kind. Each kind gets its own
  // generated provider subclass (a stable ComponentName is required by Android), plus a
  // provider-info XML we write into android/app/src/main/res/xml in configureWidgets().
  const widgetReceivers = widgetFeature && wc.homeScreen.enabled
    ? wc.homeScreen.kinds.map((kind) => {
        const cls = `${config.app.id}.Widget_${sanitizeKind(kind.id)}`;
        return '\n\n        <receiver' +
               '\n            android:name="' + cls + '"' +
               '\n            android:enabled="true"' +
               '\n            android:exported="true"' +
               '\n            android:label="@string/app_name">' +
               '\n            <intent-filter>' +
               '\n                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />' +
               '\n            </intent-filter>' +
               '\n            <meta-data' +
               '\n                android:name="android.appwidget.provider"' +
               '\n                android:resource="@xml/' + sanitizeKind(kind.id) + '_widget_provider" />' +
               '\n        </receiver>';
      }).join('')
    : '';
  const floatingService = widgetFeature && wc.floating.enabled
    ? '\n\n        <service' +
      '\n            android:name="dev.nativekit.widget.FloatingWidgetService"' +
      '\n            android:exported="false"' +
      '\n            android:foregroundServiceType="specialUse"' +
      '\n            android:stopWithTask="false">' +
      '\n            <property' +
      '\n                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"' +
      '\n                android:value="floating widget overlay" />' +
      '\n        </service>'
    : '';
  const floatingPermissions = widgetFeature && wc.floating.enabled
    ? '\n    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />' +
      '\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />' +
      '\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />'
    : '';
  const cameraFeature = config.features.camera
    ? '\n    <uses-feature android:name="android.hardware.camera" android:required="false" />'
    : '';
  const locationFeature = (config.features.location || config.features.backgroundLocation)
    ? '\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />'
    : '';
  // Nearby Connections (feature: nearby) — the @capacitor-trancee/nearby-connections plugin
  // ships an EMPTY manifest, so every BT/Wi-Fi transport permission has to be declared here.
  // neverForLocation on SCAN + NEARBY_WIFI_DEVICES keeps us out of the location-prompt path
  // on Android 12+ (location itself is still declared for older devices via features.location).
  const nearbyPermissions = config.features.nearby
    ? '\n    <!-- Nearby Connections: Bluetooth + Wi-Fi transports (plugin manifest is empty; we declare everything) -->'
      + '\n    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />'
      + '\n    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />'
      + '\n    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />'
      + '\n    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />'
      + '\n    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />'
      + '\n    <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" />'
      + '\n    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />'
      + '\n    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />'
      + '\n    <uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />'
      + '\n    <uses-feature android:name="android.hardware.bluetooth" android:required="false" />'
      + '\n    <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />'
      + '\n    <uses-feature android:name="android.hardware.wifi.aware" android:required="false" />'
    : '';

  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
${permissions}${legacyStorage}${nearbyPermissions}${floatingPermissions}${cameraFeature}${locationFeature}

    <application
        android:allowBackup="false"
        android:enableOnBackInvokedCallback="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:usesCleartextTraffic="${config.network.allowCleartext}">

        <meta-data android:name="dev.nativekit.ALARM_CHANNEL_ID" android:value="${xml(config.android.alarmChannelId)}" />
        <meta-data android:name="dev.nativekit.LOCATION_CHANNEL_ID" android:value="nativekit_location" />
        <meta-data android:name="dev.nativekit.FLOATING_START_ON_LAUNCH" android:value="${config.widget.floating.startOnLaunch}" />

        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:exported="true"
            android:label="@string/title_activity_main"
            android:launchMode="singleTask"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
        ${widgetReceivers}${floatingService}
    </application>
</manifest>
`;
}

function appDelegate() {
  const backgroundImport = config.features.backgroundRunner ? '\nimport CapacitorBackgroundRunner' : '';
  const backgroundLaunch = config.features.backgroundRunner ? `
        BackgroundRunnerPlugin.registerBackgroundTask()
        BackgroundRunnerPlugin.handleApplicationDidFinishLaunching(launchOptions: launchOptions)` : '';
  // BGTaskScheduler requires the launch handler to be registered before the app
  // finishes launching — the plugin cannot do it from load() (too late) and a
  // background launch has no WebView at all. Registering twice with the same
  // identifier kills the process, so the plugin guards it with a static flag.
  const agentImport = agentWakeSupported ? '\nimport CapacitorNativeAgent' : '';
  const agentLaunch = agentWakeSupported ? `
        NativeAgentBackgroundTask.registerIfNeeded()` : '';
  const remoteNotification = config.features.backgroundRunner ? `

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        BackgroundRunnerPlugin.dispatchEvent(event: "remoteNotification", eventArgs: userInfo) { result in
            switch result {
            case .success: completionHandler(.newData)
            case .failure: completionHandler(.failed)
            }
        }
    }` : '';

  return `import UIKit
import Capacitor${backgroundImport}${agentImport}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {${backgroundLaunch}${agentLaunch}
        return true
    }${remoteNotification}

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let scene = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        scene.delegateClass = SceneDelegate.self
        return scene
    }
}
`;
}

const plistValue = (value) => {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Array.isArray(value)) return `<array>\n${value.map((item) => `\t\t<string>${xml(item)}</string>`).join('\n')}\n\t</array>`;
  return `<string>${xml(value)}</string>`;
};

function infoPlist() {
  const entries = new Map([
    ['CAPACITOR_DEBUG', '$(CAPACITOR_DEBUG)'],
    ['CFBundleDevelopmentRegion', '$(DEVELOPMENT_LANGUAGE)'],
    ['CFBundleDisplayName', config.app.name],
    ['CFBundleExecutable', '$(EXECUTABLE_NAME)'],
    ['CFBundleIdentifier', '$(PRODUCT_BUNDLE_IDENTIFIER)'],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleName', '$(PRODUCT_NAME)'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '$(MARKETING_VERSION)'],
    ['CFBundleVersion', '$(CURRENT_PROJECT_VERSION)'],
    ['LSRequiresIPhoneOS', true],
    ['UILaunchStoryboardName', 'LaunchScreen'],
    ['UIMainStoryboardFile', 'Main'],
    ['UISupportedInterfaceOrientations', [
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight'
    ]],
    ['UISupportedInterfaceOrientations~ipad', [
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight'
    ]],
    ['UIViewControllerBasedStatusBarAppearance', true]
  ]);

  if (config.features.camera) {
    entries.set('NSCameraUsageDescription', config.permissions.camera);
    entries.set('NSPhotoLibraryUsageDescription', config.permissions.photos);
    entries.set('NSPhotoLibraryAddUsageDescription', config.permissions.photos);
  }
  if (config.features.location || config.features.backgroundLocation) {
    entries.set('NSLocationWhenInUseUsageDescription', config.permissions.locationWhenInUse);
  }
  if (config.features.backgroundLocation) {
    entries.set('NSLocationAlwaysAndWhenInUseUsageDescription', config.permissions.locationAlways);
    entries.set('NSLocationAlwaysUsageDescription', config.permissions.locationAlways);
  }
  if (config.features.advancedAlarms && config.ios.alarmKitOnIOS26) {
    entries.set('NSAlarmKitUsageDescription', config.permissions.alarmKit);
  }
  // BGTaskScheduler refuses to register an identifier that is not whitelisted here,
  // so every background task owner must contribute its id to the SAME array.
  const bgTaskIds = [];
  if (config.features.backgroundRunner) bgTaskIds.push(config.backgroundRunner.taskIdentifier);
  // On-device agent: cron jobs / heartbeat wakes are driven by a BGProcessingTask.
  // Without this identifier scheduleBackgroundWakes() resolves jobScheduled:false
  // and every scheduled agent job silently never runs on iOS.
  if (config.features.agent && agentWakeSupported) bgTaskIds.push(AGENT_WAKE_TASK_ID);
  if (bgTaskIds.length) {
    entries.set('BGTaskSchedulerPermittedIdentifiers', [...new Set(bgTaskIds)]);
  }
  // Nearby Connections (feature: nearby) — the plugin's iOS implementation (Google's
  // Swift port) needs Bluetooth + Local Network usage strings or CoreBluetooth/NW
  // refuse to start (README declares both as required).
  if (config.features.nearby) {
    entries.set('NSBluetoothAlwaysUsageDescription', 'কাছের ডিভাইসের সাথে অফলাইন সংযোগ ও ফাইল/চ্যাট আদান-প্রদান করতে Bluetooth প্রয়োজন।');
    entries.set('NSLocalNetworkUsageDescription', 'একই লোকাল নেটওয়ার্কের ডিভাইসের সাথে ছবি/ফাইল/চ্যাট পাঠাতে লোকাল নেটওয়ার্ক অ্যাক্সেস প্রয়োজন।');
  }

  const modes = [];
  if (config.ios.backgroundFetch) modes.push('fetch');
  // The agent's wake task is a BGProcessingTask, which requires the 'processing'
  // background mode even if the host app did not opt into backgroundProcessing.
  if (config.ios.backgroundProcessing || agentWakeSupported) modes.push('processing');
  if (config.features.backgroundLocation && config.ios.backgroundLocation) modes.push('location');
  if (config.ios.pushCapabilityConfigured) modes.push('remote-notification');
  if (modes.length) entries.set('UIBackgroundModes', modes);

  const simpleEntries = [...entries].map(([key, value]) => `\t<key>${key}</key>\n\t${plistValue(value)}`).join('\n');
  const ats = config.network.allowCleartext ? `
\t<key>NSAppTransportSecurity</key>
\t<dict><key>NSAllowsArbitraryLoads</key><true/></dict>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${simpleEntries}${ats}
\t<key>CFBundleURLTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>CFBundleURLName</key><string>${xml(config.app.id)}</string>
\t\t\t<key>CFBundleURLSchemes</key><array><string>${xml(config.app.urlScheme)}</string></array>
\t\t</dict>
\t</array>
\t<key>UIApplicationSceneManifest</key>
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key><false/>
\t\t<key>UISceneConfigurations</key>
\t\t<dict>
\t\t\t<key>UIWindowSceneSessionRoleApplication</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>UISceneConfigurationName</key><string>Default Configuration</string>
\t\t\t\t\t<key>UISceneDelegateClassName</key><string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
\t\t\t\t\t<key>UISceneStoryboardFile</key><string>Main</string>
\t\t\t\t</dict>
\t\t\t</array>
\t\t</dict>
\t</dict>
</dict>
</plist>
`;
}

function sanitizeKind(kind) {
  const cleaned = String(kind).replace(/[^A-Za-z0-9_]/g, '_') || 'W';
  return /^[0-9]/.test(cleaned) ? 'N' + cleaned : cleaned;
}

async function configureWidgets() {
  const widgetFeature = config.features.widget && wc.enabled;
  if (!widgetFeature || !wc.homeScreen.enabled) return;
  const androidDir = path.join(root, 'android');
  const resXmlDir = path.join(androidDir, 'app/src/main/res/xml');
  await fs.mkdir(resXmlDir, { recursive: true });
  const javaRoot = path.join(androidDir, 'app/src/main/java', ...config.app.id.split('.'));
  const resize = wc.homeScreen.resizeEnabled ? 'horizontal|vertical' : 'none';
  const period = wc.homeScreen.updatePeriodMinutes * 60_000;
  for (const kind of wc.homeScreen.kinds) {
    const name = sanitizeKind(kind.id);
    const info = [
      '<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"',
      `    android:minWidth="${kind.minWidthDp}dp"`,
      `    android:minHeight="${kind.minHeightDp}dp"`,
      `    android:minResizeWidth="${kind.minWidthDp}dp"`,
      `    android:minResizeHeight="${kind.minHeightDp}dp"`,
      `    android:targetCellWidth="${kind.targetCellWidth}"`,
      `    android:targetCellHeight="${kind.targetCellHeight}"`,
      `    android:updatePeriodMillis="${period}"`,
      `    android:initialLayout="@layout/widget_${kind.layout}"`,
      `    android:previewLayout="@layout/widget_${kind.layout}"`,
      `    android:resizeMode="${resize}"`,
      '    android:widgetCategory="home_screen"',
      '    android:description="@string/nativekit_widget_description"',
      '/>',
    ].join('\n');
    await fs.writeFile(path.join(resXmlDir, `${name}_widget_provider.xml`), `${info}\n`);

    const classFile = path.join(javaRoot, `Widget_${name}.java`);
    await fs.mkdir(path.dirname(classFile), { recursive: true });
    const escaped = String(kind.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const stub = `package ${config.app.id};\n\n`
      + `import dev.nativekit.widget.NativeKitWidgetProvider;\n\n`
      + `/** Generated by NativeKit for home-screen widget kind '${kind.id}'. */\n`
      + `public final class Widget_${name} extends NativeKitWidgetProvider {\n`
      + `    @Override public String kind() { return "${escaped}"; }\n`
      + `}\n`;
    await fs.writeFile(classFile, stub);
  }
}

async function configureAndroid() {
  const androidDir = path.join(root, 'android');
  if (!(await exists(androidDir))) throw new Error('android/ নেই—আগে npm run native:init চালান।');

  await fs.writeFile(path.join(androidDir, 'app/src/main/AndroidManifest.xml'), androidManifest());

  const valuesPath = path.join(androidDir, 'app/src/main/res/values/strings.xml');
  let values = await fs.readFile(valuesPath, 'utf8');
  values = values
    .replace(/<string name="app_name">[\s\S]*?<\/string>/, `<string name="app_name">${xml(config.app.name)}</string>`)
    .replace(/<string name="title_activity_main">[\s\S]*?<\/string>/, `<string name="title_activity_main">${xml(config.app.name)}</string>`);
  await fs.writeFile(valuesPath, values);

  const varsPath = path.join(androidDir, 'variables.gradle');
  let vars = await fs.readFile(varsPath, 'utf8');
  vars = vars
    .replace(/minSdkVersion\s*=\s*\d+/, `minSdkVersion = ${config.android.minSdk}`)
    .replace(/compileSdkVersion\s*=\s*\d+/, `compileSdkVersion = ${config.android.compileSdk}`)
    .replace(/targetSdkVersion\s*=\s*\d+/, `targetSdkVersion = ${config.android.targetSdk}`);
  await fs.writeFile(varsPath, vars);

  const buildPath = path.join(androidDir, 'app/build.gradle');
  let build = await fs.readFile(buildPath, 'utf8');
  build = build
    .replace(/namespace\s*=\s*"[^"]+"/, `namespace = "${config.app.id}"`)
    .replace(/applicationId\s+"[^"]+"/, `applicationId "${config.app.id}"`)
    .replace(/versionCode\s+\d+/, `versionCode ${config.app.versionCode}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${config.app.versionName}"`);

  if (!build.includes('@capacitor/background-runner/android/src/main/libs')) {
    build = build.replace(
      "dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'",
      "dirs '../capacitor-cordova-android-plugins/src/main/libs', '../../node_modules/@capacitor/background-runner/android/src/main/libs', 'libs'"
    );
  }

  const signingPreamble = `def nativeKitKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
def nativeKitSigningReady = nativeKitKeystorePath && System.getenv("ANDROID_KEYSTORE_PASSWORD") && System.getenv("ANDROID_KEY_ALIAS") && System.getenv("ANDROID_KEY_PASSWORD")`;
  // Rebuild this generated preamble on every sync so interrupted/older mutations cannot corrupt Gradle syntax.
  build = build.replace(/^(apply plugin: 'com\.android\.application')[\s\S]*?^android \{/m, `$1\n\n${signingPreamble}\n\nandroid {`);

  if (!build.includes('NATIVEKIT_SIGNING_START')) {
    build = build.replace("android {", `android {
    // NATIVEKIT_SIGNING_START
    signingConfigs {
        release {
            if (nativeKitSigningReady) {
                storeFile file(nativeKitKeystorePath)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }
    // NATIVEKIT_SIGNING_END`);
    build = build.replace('release {\n            minifyEnabled', 'release {\n            if (nativeKitSigningReady) signingConfig signingConfigs.release\n            minifyEnabled');
  }
  await fs.writeFile(buildPath, build);

  const javaRoot = path.join(androidDir, 'app/src/main/java');
  const mainFiles = await findFiles(javaRoot, 'MainActivity.java');
  const target = path.join(javaRoot, ...config.app.id.split('.'), 'MainActivity.java');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, mainActivity(config.app.id));
  for (const file of mainFiles) if (path.resolve(file) !== path.resolve(target)) await fs.rm(file);

  // Widget providers (receiver + provider-info XML + generated subclass) + floating service.
  await configureWidgets();
}

function mainActivity(appId) {
  return `package ${appId};

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    private int lastInsetTop = 0;
    private int lastInsetRight = 0;
    private int lastInsetBottom = 0;
    private int lastInsetLeft = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        installCrashLogger();
        super.onCreate(savedInstanceState);

        // BLEND MODE (owner-tested): transparent system bars must carry the PAGE
        // colors, so the window is full edge-to-edge here. Without this the decor's
        // dark windowBackground showed through the transparent bars — users saw a
        // permanent dark strip instead of the page.
        applyBlendWindow();
        installFullscreenImmersiveWatcher();
        installImmersiveJsBridge();

        // Deterministic safe-area bridge: we ONLY read insets here and publish them as
        // --safe-area-inset-* CSS variables. Nothing pads or resizes for the IME
        // (SystemBars insetsHandling=disable), so the keyboard can never shrink the
        // viewport twice — that double-shrink used to leave a keyboard-sized gap.
        View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            lastInsetTop = bars.top;
            lastInsetRight = bars.right;
            lastInsetBottom = bars.bottom;
            lastInsetLeft = bars.left;
            injectSafeAreaCss();
            return insets;
        });
        ViewCompat.requestApplyInsets(decor);

        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                injectSafeAreaCss();
            }
        });
    }

    // Capture any uncaught exception in the app process to a durable file + Logcat so a
    // background/foreground crash (e.g. a widget provider render or the floating service)
    // can be inspected on-device even though the app "just closes". We write first, then
    // delegate to the previous handler so normal crash reporting still runs.
    private void installCrashLogger() {
        try {
            final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
                try {
                    String nl = System.lineSeparator();
                    StringBuilder sb = new StringBuilder();
                    sb.append("=== NativeKit crash ").append(new java.util.Date()).append(" ===").append(nl);
                    sb.append("thread: ").append(thread == null ? "?" : thread.getName()).append(nl);
                    String stack = android.util.Log.getStackTraceString(throwable);
                    sb.append(stack).append(nl).append(nl);
                    java.io.File dir = getExternalFilesDir(null);
                    if (dir == null) dir = getFilesDir();
                    if (dir != null) {
                        java.io.File f = new java.io.File(dir, "nk_crash.log");
                        java.io.FileWriter writer = null;
                        try {
                            writer = new java.io.FileWriter(f, true);
                            writer.write(sb.toString());
                        } finally {
                            if (writer != null) writer.close();
                        }
                    }
                    android.util.Log.e("NativeKit", "Uncaught exception captured:" + nl + stack);
                } catch (Throwable ignored) {}
                if (previous != null) previous.uncaughtException(thread, throwable);
                else android.os.Process.killProcess(android.os.Process.myPid());
            });
        } catch (Throwable ignored) {}
    }

    private void applyBlendWindow() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            getWindow().getAttributes().layoutInDisplayCutoutMode = 1; // SHORT_EDGES
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        applyBlendWindow(); // re-apply if the theme/system reset bar colors
    }

    // FULLSCREEN IMMERSIVE: when HTML content (e.g. a video) calls the HTML5
    // fullscreen API, Android's WebChromeClient.onShowCustomView adds a NEW top-level
    // view onto the decor. With our transparent bars that overlay would let the
    // phone's nav buttons float ON TOP of the page's own bottom buttons. So while
    // fullscreen is active we hide the system bars (immersive sticky: a swipe
    // reveals them translucently and they auto-hide again).
    private boolean decorWatcherArmed = false;
    private android.view.View fullscreenView = null;

    private void installFullscreenImmersiveWatcher() {
        final ViewGroup decorView = (ViewGroup) getWindow().getDecorView();
        decorView.setOnHierarchyChangeListener(new ViewGroup.OnHierarchyChangeListener() {
            @Override public void onChildViewAdded(View parent, View child) {
                if (!decorWatcherArmed || child == decorView) return;
                if (!isTrueFullscreenOverlay(child)) return;
                fullscreenView = child;
                applyImmersive(true);
            }
            @Override public void onChildViewRemoved(View parent, View child) {
                if (!decorWatcherArmed) return;
                if (child == fullscreenView) {
                    fullscreenView = null;
                    applyImmersive(false);
                    applyBlendWindow();
                }
            }
        });
        decorView.post(() -> decorWatcherArmed = true); // ignore the initial layout children
    }

    private boolean isTrueFullscreenOverlay(android.view.View child) {
        if (child.getVisibility() != android.view.View.VISIBLE) return false;
        int h = getWindow().getDecorView().getHeight();
        int w = getWindow().getDecorView().getWidth();
        if (h <= 0 || w <= 0) {
            h = getResources().getDisplayMetrics().heightPixels;
            w = getResources().getDisplayMetrics().widthPixels;
        }
        ViewGroup.LayoutParams lp = child.getLayoutParams();
        if (lp == null) return false;
        boolean matchH = lp.height == ViewGroup.LayoutParams.MATCH_PARENT || lp.height >= (int) (h * 0.7f);
        boolean matchW = lp.width == ViewGroup.LayoutParams.MATCH_PARENT || lp.width >= (int) (w * 0.7f);
        return matchH && matchW;
    }

    // ELEMENT-FULLSCREEN bridge: Chromium WebView handles requestFullscreen() on a
    // plain element INTERNALLY (no onShowCustomView ever fires), so the page tells
    // us via fullscreenchange → this JS interface. Immersive only on TRUE fullscreen.
    private void installImmersiveJsBridge() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) return;
        wv.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setFullscreen(final boolean on) {
                runOnUiThread(() -> applyImmersive(on));
            }
        }, "NativeKitImmersive");
    }

    private void applyImmersive(boolean active) {
        WindowInsetsControllerCompat ic = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        if (active) {
            ic.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            ic.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            ic.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    private void injectSafeAreaCss() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        float density = getResources().getDisplayMetrics().density;
        int top = Math.round(lastInsetTop / density);
        int right = Math.round(lastInsetRight / density);
        int bottom = Math.round(lastInsetBottom / density);
        int left = Math.round(lastInsetLeft / density);
        String script = String.format(Locale.US,
                "(function(){try{var s=document.documentElement.style;"
                        + "s.setProperty('--safe-area-inset-top','%dpx');"
                        + "s.setProperty('--safe-area-inset-right','%dpx');"
                        + "s.setProperty('--safe-area-inset-bottom','%dpx');"
                        + "s.setProperty('--safe-area-inset-left','%dpx');}catch(e){}})();",
                top, right, bottom, left);
        getBridge().executeOnMainThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }
}
`;
}

async function configureIOS() {
  const iosDir = path.join(root, 'ios/App');
  if (!(await exists(iosDir))) throw new Error('ios/ নেই—আগে npm run native:init চালান।');

  await fs.writeFile(path.join(iosDir, 'App/AppDelegate.swift'), appDelegate());
  await fs.writeFile(path.join(iosDir, 'App/Info.plist'), infoPlist());

  const projectPath = path.join(iosDir, 'App.xcodeproj/project.pbxproj');
  let project = await fs.readFile(projectPath, 'utf8');
  project = project
    .replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${config.app.id};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${config.app.versionName};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${config.app.buildNumber};`)
    .replace(/IPHONEOS_DEPLOYMENT_TARGET = [^;]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${config.ios.deploymentTarget};`);

  project = project.replace(/^\s*DEVELOPMENT_TEAM = .*;\n/gm, '');
  if (config.ios.teamId) {
    project = project.replace(/(CODE_SIGN_STYLE = Automatic;)/g, `$1\n\t\t\t\tDEVELOPMENT_TEAM = ${config.ios.teamId};`);
  }
  await fs.writeFile(projectPath, project);
}

await configureAndroid();
await configureIOS();
console.log('✓ app.config.json থেকে Android ও iOS native configuration লেখা হয়েছে');
