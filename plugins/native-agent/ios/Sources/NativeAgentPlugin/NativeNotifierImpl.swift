import Foundation
import UserNotifications

/// Delivers cron / heartbeat results as local notifications.
///
/// Three problems the previous implementation had, all of which made a
/// notification vanish with no trace:
///
///  1. **Authorization was never requested.** `UNUserNotificationCenter.add`
///     fails silently when the app has never been granted permission, so on a
///     fresh install every scheduled result was dropped.
///  2. **The completion error was discarded.** `add(request)` was called
///     without its handler, so even a hard failure was invisible.
///  3. **`trigger: nil`** means "deliver immediately", which iOS suppresses
///     while the app is in the foreground unless a delegate opts in. A wake can
///     complete with the app open, so those results never appeared.
public final class NativeNotifierImpl: NSObject, NativeNotifier {
    /// Serialises the one-time authorization request.
    private let authQueue = DispatchQueue(label: "io.t6x.nativeagent.notifier")
    private var didRequestAuthorization = false

    /// Presents agent notifications while the app is in the foreground.
    ///
    /// iOS suppresses a local notification's banner whenever the app is
    /// frontmost UNLESS a `UNUserNotificationCenterDelegate` returns
    /// presentation options from `willPresent`. This app registered no delegate
    /// at all, so a cron result that landed while the user had the app open was
    /// filed silently into Notification Center with no banner and no sound.
    ///
    /// Install it once from the app delegate:
    /// `NativeNotifierImpl.installForegroundPresenter()`
    public static let foregroundPresenter = ForegroundPresenter()

    public final class ForegroundPresenter: NSObject, UNUserNotificationCenterDelegate {
        public func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification,
            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
        ) {
            if #available(iOS 14.0, *) {
                // `.list` is required in addition to `.banner` on iOS 14+, or
                // the notification never reaches Notification Center.
                completionHandler([.banner, .list, .sound])
            } else {
                completionHandler([.alert, .sound])
            }
        }
    }

    /// Registers the foreground presenter, preserving any delegate the host app
    /// already installed (Capacitor push plugins commonly own it). Call from
    /// `application(_:didFinishLaunchingWithOptions:)`.
    public static func installForegroundPresenter() {
        let center = UNUserNotificationCenter.current()
        guard center.delegate == nil else {
            NSLog("[NativeAgent] a UNUserNotificationCenter delegate is already installed; leaving it in place")
            return
        }
        center.delegate = foregroundPresenter
    }

    public override init() {
        super.init()
    }

    /// Ask for permission once, up front. Safe to call repeatedly: iOS only
    /// prompts the user the first time.
    public func requestAuthorizationIfNeeded(completion: ((Bool) -> Void)? = nil) {
        authQueue.async { [weak self] in
            guard let self = self else {
                completion?(false)
                return
            }
            if self.didRequestAuthorization {
                completion?(true)
                return
            }
            self.didRequestAuthorization = true
            UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                    if let error = error {
                        NSLog("[NativeAgent] notification authorization failed: \(error.localizedDescription)")
                    } else if !granted {
                        NSLog("[NativeAgent] notification authorization denied by the user — cron results will not be surfaced as notifications")
                    }
                    completion?(granted)
                }
        }
    }

    public func sendNotification(title: String, body: String, dataJson: String) -> String {
        let identifier = UUID().uuidString
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let data = dataJson.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [AnyHashable: Any] {
            content.userInfo = json
        }

        let center = UNUserNotificationCenter.current()

        // Deliver through the same path whether or not permission has been
        // asked for yet, but make sure the request happens first.
        center.getNotificationSettings { [weak self] settings in
            let submit = {
                // A tiny time-interval trigger (rather than `nil`) gives iOS a
                // concrete delivery point and keeps the banner behaviour
                // consistent between foreground and background wakes.
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
                let request = UNNotificationRequest(
                    identifier: identifier,
                    content: content,
                    trigger: trigger
                )
                center.add(request) { error in
                    if let error = error {
                        NSLog("[NativeAgent] failed to post notification \(identifier): \(error.localizedDescription)")
                    }
                }
            }

            switch settings.authorizationStatus {
            case .notDetermined:
                self?.requestAuthorizationIfNeeded { granted in
                    if granted {
                        submit()
                    } else {
                        NSLog("[NativeAgent] dropping notification \(identifier): authorization not granted")
                    }
                }
            case .denied:
                NSLog("[NativeAgent] dropping notification \(identifier): notifications are disabled for this app")
            default:
                submit()
            }
        }

        return identifier
    }
}
