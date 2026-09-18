import Foundation

/// Listener protocol for in-process Swift code that wants to observe
/// raw FFI events alongside the WebView listener. Mirrors the shape of
/// the UniFFI-generated NativeEventCallback protocol but is registered
/// through NativeAgentBridge instead of the FFI itself, so multiple
/// consumers can subscribe at once.
public protocol NativeEventListener: AnyObject {
    func onEvent(eventType: String, payloadJson: String)
}

/// Process-wide accessor that exposes the live NativeAgentHandle and a
/// multi-listener event fan-out to other modules in the same iOS
/// process — most notably the STOMP transport in theshell.
///
/// The single FFI-side NativeEventCallback registered by NativeAgentPlugin
/// (NativeAgentEventBridge in NativeAgentPlugin.swift) forwards every
/// event into `dispatch` in addition to its existing notifyListeners
/// call, so the WebView pipeline is byte-equivalent to before this
/// bridge existed.
///
/// Listeners are strong-referenced by ObjectIdentifier; callers MUST
/// call `removeNativeEventListener` when their lifecycle ends.
public enum NativeAgentBridge {

    private static let lock = NSLock()
    private static var handleRef: NativeAgentHandle?
    private static var listeners: [ObjectIdentifier: NativeEventListener] = [:]

    /// The live FFI handle, or nil if NativeAgent has not been
    /// initialized yet (or has been destroyed).
    public static func handle() -> NativeAgentHandle? {
        lock.lock()
        defer { lock.unlock() }
        return handleRef
    }

    public static func addNativeEventListener(_ listener: NativeEventListener) {
        lock.lock()
        defer { lock.unlock() }
        listeners[ObjectIdentifier(listener)] = listener
    }

    public static func removeNativeEventListener(_ listener: NativeEventListener) {
        lock.lock()
        defer { lock.unlock() }
        listeners.removeValue(forKey: ObjectIdentifier(listener))
    }

    internal static func setHandle(_ h: NativeAgentHandle?) {
        lock.lock()
        defer { lock.unlock() }
        handleRef = h
    }

    internal static func dispatch(eventType: String, payloadJson: String) {
        lock.lock()
        let snapshot = Array(listeners.values)
        lock.unlock()
        for l in snapshot {
            l.onEvent(eventType: eventType, payloadJson: payloadJson)
        }
    }
}
