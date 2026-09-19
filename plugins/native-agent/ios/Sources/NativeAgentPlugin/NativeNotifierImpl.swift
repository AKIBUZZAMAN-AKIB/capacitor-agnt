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
        UNUserNotificationCenter.current().add(request)
        return identifier
    }
}
