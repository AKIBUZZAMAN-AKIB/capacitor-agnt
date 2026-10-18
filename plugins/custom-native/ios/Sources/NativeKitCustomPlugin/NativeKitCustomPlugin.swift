import Foundation
import Capacitor
import CoreLocation
import UIKit
import WebKit

@objc(NativeKitCustomPlugin)
public class NativeKitCustomPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "NativeKitCustomPlugin"
    public let jsName = "NativeKitCustom"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkAlarmCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestExactAlarmAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestFullScreenIntentAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listAlarms", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRinging", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSSE", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSSE", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureClear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBackgroundLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBackgroundLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBackgroundLocationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBufferedLocations", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearBufferedLocations", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
    ]

    private final class StreamHandle {
        let session: URLSession
        let task: URLSessionDataTask
        let delegate: NativeStreamDelegate
        init(session: URLSession, task: URLSessionDataTask, delegate: NativeStreamDelegate) {
            self.session = session; self.task = task; self.delegate = delegate
        }
    }

    private let secureStore = NativeKitSecureStore()
    private let alarmAdapter = NativeKitAlarmAdapter()
    private var streams: [String: StreamHandle] = [:]
    private var locationManager: CLLocationManager?
    private var maxLocationBuffer = 100
    private let locationDefaultsKey = "nativekit.buffered.locations"

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, let bridge else { return nil }
        let config = bridge.config
        let sameOrigin = { (candidate: URL, base: URL) in
            candidate.scheme?.lowercased() == base.scheme?.lowercased()
                && candidate.host?.lowercased() == base.host?.lowercased()
                && candidate.port == base.port
        }
        let localAppURL = sameOrigin(url, config.serverURL) || sameOrigin(url, config.localURL)
        if localAppURL || url.absoluteString.lowercased() == "about:srcdoc" { return nil }
        let scheme = url.scheme?.lowercased()
        if (scheme == "http" || scheme == "https"),
           let host = url.host,
           config.shouldAllowNavigation(to: host) { return nil }
        // Prevent opaque App Browser frames from resetting their CSP through data/blob navigation,
        // making an unbrokered network request, or launching an external application. Trusted code
        // should use an explicit native API (for example the Browser plugin) for external navigation.
        return NSNumber(value: true)
    }

    @objc func checkAlarmCapabilities(_ call: CAPPluginCall) {
        call.resolve(alarmAdapter.capabilities())
    }

    @objc func requestExactAlarmAccess(_ call: CAPPluginCall) {
        alarmAdapter.requestAuthorization { result in
            DispatchQueue.main.async {
                switch result { case .success: call.resolve(); case .failure(let error): call.reject(error.localizedDescription, nil, error) }
            }
        }
    }

    @objc func requestFullScreenIntentAccess(_ call: CAPPluginCall) {
        call.resolve() // iOS does not expose Android-style full-screen intent access.
    }

    @objc func scheduleAlarm(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let title = call.getString("title"), let at = call.getDouble("at") else {
            call.reject("id, title and numeric at are required"); return
        }
        var options: [String: Any] = [
            "id": id, "title": title, "at": at,
            "body": call.getString("body") ?? "",
            "repeatIntervalMinutes": call.getDouble("repeatIntervalMinutes") ?? 0,
            "fullScreen": call.getBool("fullScreen") ?? false,
            "sound": call.getString("sound") ?? "default",
        ]
        if let extra = call.getObject("extra") { options["extra"] = extra }
        alarmAdapter.schedule(options: options) { result in
            DispatchQueue.main.async {
                switch result { case .success(let value): call.resolve(value); case .failure(let error): call.reject(error.localizedDescription, nil, error) }
            }
        }
    }

    @objc func cancelAlarm(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required"); return }
        do { try alarmAdapter.cancel(id: id); call.resolve() }
        catch { call.reject(error.localizedDescription, nil, error) }
    }

    @objc func listAlarms(_ call: CAPPluginCall) { call.resolve(["alarms": alarmAdapter.list()]) }
    @objc func stopRinging(_ call: CAPPluginCall) { alarmAdapter.stop(id: call.getString("id")); call.resolve() }

    @objc func startSSE(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            call.reject("A valid HTTP(S) url is required"); return
        }
        let id = call.getString("streamId") ?? UUID().uuidString
        let format = call.getString("format") ?? "sse"
        var request = URLRequest(url: url)
        request.httpMethod = call.getString("method") ?? "GET"
        request.timeoutInterval = 30
        if let headers = call.getObject("headers") {
            for (key, value) in headers { request.setValue(String(describing: value), forHTTPHeaderField: key) }
        }
        if format == "sse" && request.value(forHTTPHeaderField: "Accept") == nil { request.setValue("text/event-stream", forHTTPHeaderField: "Accept") }
        if let body = call.getString("body") { request.httpBody = body.data(using: .utf8) }

        let delegate = NativeStreamDelegate(streamId: id, format: format, allowRedirects: !(call.getBool("disableRedirects") ?? false))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request)
        delegate.onData = { [weak self] value in
            var event = value; event["streamId"] = id
            DispatchQueue.main.async { self?.notifyListeners("nativeSSEData", data: event, retainUntilConsumed: true) }
        }
        delegate.onEnd = { [weak self] status in
            DispatchQueue.main.async {
                guard let self, self.streams.removeValue(forKey: id) != nil else { return }
                self.notifyListeners("nativeSSEEnd", data: ["streamId": id, "status": status as Any], retainUntilConsumed: true)
                session.finishTasksAndInvalidate()
            }
        }
        delegate.onError = { [weak self] message, status in
            DispatchQueue.main.async {
                guard let self, self.streams.removeValue(forKey: id) != nil else { return }
                self.notifyListeners("nativeSSEError", data: ["streamId": id, "message": message, "status": status as Any], retainUntilConsumed: true)
                session.invalidateAndCancel()
            }
        }
        streams[id] = StreamHandle(session: session, task: task, delegate: delegate)
        task.resume()
        call.resolve(["streamId": id])
    }

    @objc func stopSSE(_ call: CAPPluginCall) {
        guard let id = call.getString("streamId") else { call.reject("streamId is required"); return }
        if let handle = streams.removeValue(forKey: id) { handle.task.cancel(); handle.session.invalidateAndCancel() }
        call.resolve()
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else { call.reject("key and value are required"); return }
        do { try secureStore.set(key: key, value: value); call.resolve() } catch { call.reject("Secure storage write failed", nil, error) }
    }
    @objc func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key is required"); return }
        do { call.resolve(["value": try secureStore.get(key: key) as Any]) } catch { call.reject("Secure storage read failed", nil, error) }
    }
    @objc func secureRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key is required"); return }
        do { try secureStore.remove(key: key); call.resolve() } catch { call.reject("Secure storage delete failed", nil, error) }
    }
    @objc func secureClear(_ call: CAPPluginCall) {
        do { try secureStore.clear(); call.resolve() } catch { call.reject("Secure storage clear failed", nil, error) }
    }

    @objc func startBackgroundLocation(_ call: CAPPluginCall) {
        let manager = locationManager ?? CLLocationManager()
        locationManager = manager
        manager.delegate = self
        let status = manager.authorizationStatus
        if status == .notDetermined { manager.requestAlwaysAuthorization(); call.reject("Location authorization requested; approve it and retry"); return }
        if status == .authorizedWhenInUse { manager.requestAlwaysAuthorization(); call.reject("Choose Always Allow, then retry background location"); return }
        guard status == .authorizedAlways else { call.reject("Always location permission is required"); return }
        manager.desiredAccuracy = (call.getString("desiredAccuracy") ?? "high") == "high" ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
        manager.distanceFilter = call.getDouble("minDistanceM") ?? 10
        manager.pausesLocationUpdatesAutomatically = true
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        maxLocationBuffer = max(10, min(1000, call.getInt("maxBuffer") ?? 100))
        manager.startUpdatingLocation()
        UserDefaults.standard.set(true, forKey: "nativekit.location.running")
        call.resolve(["running": true])
    }

    @objc func stopBackgroundLocation(_ call: CAPPluginCall) {
        locationManager?.stopUpdatingLocation()
        locationManager?.allowsBackgroundLocationUpdates = false
        UserDefaults.standard.set(false, forKey: "nativekit.location.running")
        call.resolve()
    }

    @objc func getBackgroundLocationStatus(_ call: CAPPluginCall) {
        let status = locationManager?.authorizationStatus ?? CLLocationManager().authorizationStatus
        let permission: String
        switch status { case .authorizedAlways: permission = "granted"; case .authorizedWhenInUse: permission = "foreground-only"; case .notDetermined: permission = "prompt"; default: permission = "denied" }
        call.resolve(["running": UserDefaults.standard.bool(forKey: "nativekit.location.running"), "permission": permission, "platform": "ios"])
    }

    @objc func getBufferedLocations(_ call: CAPPluginCall) {
        call.resolve(["locations": UserDefaults.standard.array(forKey: locationDefaultsKey) ?? []])
    }

    @objc func clearBufferedLocations(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: locationDefaultsKey); call.resolve()
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            var value: [String: Any] = [
                "latitude": location.coordinate.latitude,
                "longitude": location.coordinate.longitude,
                "accuracy": location.horizontalAccuracy,
                "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
            ]
            if location.verticalAccuracy >= 0 { value["altitude"] = location.altitude }
            if location.speed >= 0 { value["speed"] = location.speed }
            if location.course >= 0 { value["bearing"] = location.course }
            var buffered = UserDefaults.standard.array(forKey: locationDefaultsKey) as? [[String: Any]] ?? []
            buffered.append(value)
            if buffered.count > maxLocationBuffer { buffered.removeFirst(buffered.count - maxLocationBuffer) }
            UserDefaults.standard.set(buffered, forKey: locationDefaultsKey)
            notifyListeners("nativeLocation", data: value, retainUntilConsumed: true)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        notifyListeners("nativeLocationError", data: ["message": error.localizedDescription], retainUntilConsumed: true)
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString), UIApplication.shared.canOpenURL(url) else { call.reject("Unable to open app settings"); return }
            UIApplication.shared.open(url) { opened in opened ? call.resolve() : call.reject("Unable to open app settings") }
        }
    }

    /// Opens a URL with the system's choice of app (normally the browser).
    /// window.open() is not reliable inside a Capacitor WKWebView, so the
    /// open_url device tool routes through here where failures reject and
    /// can be reported honestly. The JS caller validated the https: scheme.
    @objc func openUrl(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString), url.scheme?.lowercased() == "https" else {
            call.reject("A valid https: url is required")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { opened in
                opened ? call.resolve() : call.reject("No app on this device could open that URL")
            }
        }
    }

    deinit {
        for (_, handle) in streams { handle.session.invalidateAndCancel() }
        locationManager?.stopUpdatingLocation()
    }
}
