import Foundation
import Network
import UIKit

/// Eingebettetes Node (nodejs-mobile) mit `game/app-host.js`.
///
/// Die WebView lädt das Spiel immer von `http://127.0.0.1:<port>` (Secure Context, gleiche Origin in allen Modi).
/// Der App-Host leitet Räume je nach Modus an letzterunde.aize-it.de, an den eingebetteten Spielserver (WLAN-Host)
/// oder an ein anderes Gerät im WLAN weiter. Gesteuert wird über `/__app/*` mit einem Token, das nur die App kennt.
@MainActor
final class NodeHost: ObservableObject {
    static let shared = NodeHost()

    enum Mode: String, Codable { case online, lan, join }

    struct LanInfo: Codable, Equatable {
        var on: Bool
        var ip: String
        var http: String
        var https: String
        var fingerprint: String
    }

    struct State: Codable, Equatable {
        var mode: Mode
        var join: String
        var lan: LanInfo
        var online: Bool?
        var queue: Int
    }

    @Published private(set) var ready = false
    @Published private(set) var state: State?
    @Published private(set) var failure: String?

    let port: Int
    private let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private var started = false

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    static let lanPort = 8380

    private init() {
        port = NodeHost.freePort(preferred: 8370)
    }

    // MARK: Start

    func start() {
        guard !started else { return }
        started = true
        guard let game = Bundle.main.url(forResource: "game", withExtension: nil) else {
            failure = "Spieldateien fehlen im App-Bundle."
            return
        }
        let varDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("letzterunde", isDirectory: true)
        try? FileManager.default.createDirectory(at: varDir, withIntermediateDirectories: true)
        var noBackup = URLResourceValues()
        noBackup.isExcludedFromBackup = true      // Räume sind flüchtig; Statistik liegt im localStorage bzw. Konto
        var dir = varDir
        try? dir.setResourceValues(noBackup)

        setenv("KR_APP_PORT", String(port), 1)
        setenv("KR_APP_TOKEN", token, 1)
        setenv("KR_VAR_DIR", varDir.path, 1)
        setenv("KR_PUBLIC", game.appendingPathComponent("public").path, 1)
        setenv("KR_LAN_PORT", String(NodeHost.lanPort), 1)
        setenv("KR_UPSTREAM", "https://letzterunde.aize-it.de", 1)
        #if DEBUG
        // Tests im Simulator gegen einen lokalen Server: simctl launch mit SIMCTL_CHILD_KR_UPSTREAM_DEBUG=http://…
        if let up = ProcessInfo.processInfo.environment["KR_UPSTREAM_DEBUG"], !up.isEmpty { setenv("KR_UPSTREAM", up, 1) }
        #endif
        setenv("KR_LEADER_SOCK", NSTemporaryDirectory() + "kr.sock", 1)

        let script = game.appendingPathComponent("app-host.js").path
        let thread = Thread {
            let rc = kr_node_start(script)
            Task { @MainActor in NodeHost.shared.failure = "Der Spielserver wurde beendet (\(rc))." }
        }
        thread.name = "node"
        thread.stackSize = 4 * 1024 * 1024
        thread.start()
        Task { await waitReady() }
    }

    /// Wartet, bis der App-Host antwortet (beim Start und nach dem Aufwachen: der Host öffnet
    /// weggenommene Sockets selbst innerhalb von ~2 s neu).
    @discardableResult
    func waitReady(timeout: TimeInterval = 20) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if let s = try? await call("state") {
                state = s
                ready = true
                return true
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        if !ready { failure = "Der Spielserver startet nicht." }
        return false
    }

    // MARK: Steuerung

    func refresh() async {
        if let s = try? await call("state") { state = s }
    }

    func setMode(_ mode: Mode, join: URL? = nil) async throws {
        var body: [String: String] = ["mode": mode.rawValue]
        if let join { body["join"] = join.absoluteString }
        state = try await call("mode", body: body)
    }

    private func call(_ path: String, body: [String: String]? = nil) async throws -> State {
        var req = URLRequest(url: baseURL.appendingPathComponent("__app/\(path)"))
        req.timeoutInterval = 3
        req.setValue(token, forHTTPHeaderField: "x-kr-app")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Fehler"
            throw NSError(domain: "NodeHost", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        return try JSONDecoder().decode(State.self, from: data)
    }

    // MARK: Hilfen

    /// Bevorzugter Port, sonst ein freier vom System (127.0.0.1).
    private static func freePort(preferred: Int) -> Int {
        func bindable(_ p: Int) -> Int? {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { return nil }
            defer { close(fd) }
            // Wie Node beim listen(): SO_REUSEADDR, sonst gilt der Port nach dem Wegwischen der App noch ~30 s als belegt
            // (TIME_WAIT der alten Verbindungen) → anderer Port → andere Origin → localStorage (Anmeldung, Name …) leer.
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = in_port_t(UInt16(p).bigEndian)
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let ok = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard ok == 0 else { return nil }
            var out = sockaddr_in(); var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &out) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
            }
            return Int(UInt16(bigEndian: out.sin_port))
        }
        // Der Spielserver nutzt port + 1 – beide müssen frei sein.
        if bindable(preferred) != nil, bindable(preferred + 1) != nil { return preferred }
        for _ in 0..<20 {
            if let p = bindable(0), p < 65000, bindable(p + 1) != nil { return p }
        }
        return preferred
    }
}
