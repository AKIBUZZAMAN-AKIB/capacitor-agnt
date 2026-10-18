import type { CapacitorConfig } from '@capacitor/cli';
import appConfig from './app.config.json' with { type: 'json' };

const { app, web, network, security, backgroundRunner } = appConfig;

const config: CapacitorConfig = {
  appId: app.id,
  appName: app.name,
  webDir: web.nativeStagingDir,
  loggingBehavior: 'debug',
  // Match the WebView surface to the app ground color (--bg in styles.css): the
  // webview paints this instead of white while booting, so a process-death
  // relaunch or cold start never flashes a white screen before the page draws.
  backgroundColor: '#060b16',
  // Production uses the bundled webDir. There is deliberately no server.url.
  // Keep the whole server block absent while secure defaults are sufficient.
  ...((network.allowCleartext || security.allowNavigation.length > 0)
    ? {
        server: {
          cleartext: network.allowCleartext,
          allowNavigation: security.allowNavigation,
        },
      }
    : {}),
  android: {
    minWebViewVersion: 60,
    webContentsDebuggingEnabled: false,
    allowMixedContent: false,
  },
  ios: {
    scheme: 'App',
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    CapacitorHttp: {
      // Capacitor's global patch currently enables fetch and XHR together.
      // Explicit NativeKit.http.request remains available when this is false.
      enabled: network.nativeHttp && (network.patchFetch || network.patchXMLHttpRequest),
    },
    Keyboard: {
      // iOS: resize the whole native WebView so viewport units track the keyboard.
      resize: 'native',
      // Android: never resize the WebView from the plugin — Capacitor 8 core
      // SystemBars already pads for the IME via WindowInsets with edge-to-edge.
      resizeOnFullScreen: false,
      // iOS: tint the area revealed behind the keyboard from the page background
      // so the keyboard never "blinks" a mismatched color while sliding up.
      autoBackdropColor: 'dom',
    },
    SystemBars: {
      // Fully deterministic mode: the plugin installs NO inset listener, pads NOTHING
      // and injects nothing. MainActivity reads insets itself and publishes them as
      // --safe-area-inset-* CSS variables; the IME is left to the OS/Chrome, so the
      // viewport can never be shrunk twice (that double-shrink left keyboard-sized gaps).
      insetsHandling: 'disable',
      // App UI is always dark: force light status/nav bar icons even in day mode.
      style: 'DARK',
    },
    BackgroundRunner: {
      label: backgroundRunner.label,
      src: 'runners/background-runner.js',
      event: backgroundRunner.event,
      repeat: backgroundRunner.repeat,
      interval: backgroundRunner.intervalMinutes,
      autoStart: backgroundRunner.autoStart,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_nativekit',
      iconColor: '#2563EB',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    NearbyConnections: {
      endpointName: app.name,
      // Best practice: serviceID must uniquely identify the app — use the package id.
      serviceID: app.id,
      // Strategy is set at runtime (initialize()) so the TestLab UI can switch
      // star / cluster / pointToPoint on the fly.
    },
  },
};

export default config;
