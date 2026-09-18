import Foundation
import UserNotifications

public final class NativeNotifierImpl: NativeNotifier {
    public init() {}

    public func sendNotification(title: String, body: String, dataJson: String) -> String {
        let identifier = UUID().uuidString
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let data = dataJson.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [AnyHashable: Any] {
            content.userInfo = json
        }

        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        )
        // Log delivery failures instead of discarding them silently (the old
        // fire-and-forget hid permission denials and quota errors completely).
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                NSLog("[NativeNotifierImpl] notification \(identifier) failed: \(error.localizedDescription)")
            }
        }

        // JSON result for parity with the Android notifier (the old iOS side
        // returned a bare UUID string, so Rust-side consumers saw two shapes).
        if let data = try? JSONSerialization.data(
            withJSONObject: ["notificationId": identifier, "dataJson": dataJson]
        ), let json = String(data: data, encoding: .utf8) {
            return json
        }
        return identifier
    }
}
