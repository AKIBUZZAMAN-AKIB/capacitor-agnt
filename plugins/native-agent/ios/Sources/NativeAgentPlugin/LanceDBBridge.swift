import Foundation

#if canImport(CapacitorLanceDB)
import CapacitorLanceDB
#elseif canImport(CapacitorLancedb)
import CapacitorLancedb
#elseif canImport(LanceDBPlugin)
import LanceDBPlugin
#endif

#if canImport(CapacitorLanceDB) || canImport(CapacitorLancedb) || canImport(LanceDBPlugin)
final class LanceDBBridge {
    static let shared = LanceDBBridge()
    static let embeddingDim: Int32 = 1536

    private let lock = NSLock()
    private var handle: LanceDbHandle?

    func getOrCreateHandle() -> LanceDbHandle? {
        lock.lock()
        defer { lock.unlock() }

        if let handle {
            return handle
        }

        let dbPath = FileManager.default
            .urls(for: .libraryDirectory, in: .userDomainMask)
            .first!
            .appendingPathComponent("lancedb-memories")
            .path

        try? FileManager.default.createDirectory(
            atPath: dbPath,
            withIntermediateDirectories: true,
            attributes: nil
        )

        let opened = try? Self.awaitResult {
            try await LanceDbHandle.open(dbPath: dbPath, embeddingDim: Self.embeddingDim)
        }
        handle = opened
        return opened
    }

    static func awaitResult<T>(_ operation: @escaping () async throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let resultLock = NSLock()
        var outcome: Result<T, Error>?

        Task.detached {
            let result: Result<T, Error>
            do {
                result = .success(try await operation())
            } catch {
                result = .failure(error)
            }
            resultLock.lock()
            outcome = result
            resultLock.unlock()
            semaphore.signal()
        }

        semaphore.wait()
        resultLock.lock()
        defer { resultLock.unlock() }
        return try outcome!.get()
    }
}
#endif
