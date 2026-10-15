import Foundation
import Network
import UIKit

/// WLAN-Host: macht das Spiel per Bonjour (`_letzterunde._tcp`) sichtbar, hält den Bildschirm an und
/// nutzt beim Wechsel in den Hintergrund die kurze Restlaufzeit, die iOS gewährt.
@MainActor
final class LanHosting: NSObject, ObservableObject, NetServiceDelegate {
    @Published private(set) var hosting = false
    private var service: NetService?
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private var inRoom = false

    func sync(with state: NodeHost.State?) {
        let on = state?.mode == .lan && state?.lan.on == true
        guard on != hosting else { return }
        hosting = on
        if on { publish(state!) } else { unpublish() }
        updateIdleTimer()
    }

    /// Die Spielseite meldet, ob gerade ein Raum offen ist (Bildschirm nicht sperren).
    func keepAwake(room: Bool) {
        inRoom = room
        updateIdleTimer()
    }

    func enteredBackground() {
        guard hosting, bgTask == .invalid else { return }
        // iOS pausiert die App im Hintergrund – der Host ist dann für die Gäste weg. Die Restzeit nutzen,
        // damit ein kurzer Blick in eine andere App das Spiel nicht sofort unterbricht.
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "WLAN-Host") { [weak self] in
            Task { @MainActor in self?.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask) }
        bgTask = .invalid
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = hosting || inRoom
    }

    private func publish(_ s: NodeHost.State) {
        let name = "Letzte Runde – \(UIDevice.current.name)"
        let svc = NetService(domain: "local.", type: "_letzterunde._tcp.", name: name, port: Int32(NodeHost.lanPort))
        var txt: [String: Data] = ["v": Data("1".utf8)]
        if !s.lan.https.isEmpty { txt["https"] = Data(String(NodeHost.lanPort + 1).utf8) }
        if !s.lan.fingerprint.isEmpty { txt["fp"] = Data(String(s.lan.fingerprint.prefix(23)).utf8) }
        svc.setTXTRecord(NetService.data(fromTXTRecord: txt))
        svc.delegate = self
        svc.publish()
        service = svc
    }

    private func unpublish() {
        service?.stop()
        service = nil
        endBackgroundTask()
    }
}

/// Sucht Spiele im WLAN (Bonjour) und löst sie in eine Adresse `http://<ip>:<port>` auf.
@MainActor
final class LanBrowser: ObservableObject {
    struct Game: Identifiable, Hashable {
        let id: String
        let name: String
        let endpoint: NWEndpoint
    }

    @Published private(set) var games: [Game] = []
    @Published private(set) var denied = false
    private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjour(type: "_letzterunde._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let list = results.compactMap { r -> Game? in
                guard case let .service(name, _, _, _) = r.endpoint else { return nil }
                return Game(id: "\(r.endpoint)", name: name, endpoint: r.endpoint)
            }.filter { !$0.name.hasSuffix(UIDevice.current.name) }   // das eigene Spiel nicht anbieten
            Task { @MainActor in self?.games = list.sorted { $0.name < $1.name } }
        }
        b.stateUpdateHandler = { [weak self] state in
            if case let .waiting(err) = state, case .dns = err {
                Task { @MainActor in self?.denied = true }   // Berechtigung „Lokales Netzwerk“ fehlt
            }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    /// Verbindet kurz, um IP und Port des Bonjour-Dienstes zu erfahren.
    func resolve(_ game: Game) async -> URL? {
        await withCheckedContinuation { cont in
            let params = NWParameters.tcp
            if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
            let conn = NWConnection(to: game.endpoint, using: params)
            let once = Once()
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard once.fire() else { return }
                    var url: URL?
                    if case let .hostPort(host, port) = conn.currentPath?.remoteEndpoint {
                        var h = "\(host)"
                        if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }   // Schnittstellen-Suffix
                        url = URL(string: "http://\(h):\(port.rawValue)")
                    }
                    conn.cancel()
                    cont.resume(returning: url)
                case .failed, .cancelled:
                    guard once.fire() else { return }
                    cont.resume(returning: nil)
                default: break
                }
            }
            conn.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                if once.fire() { conn.cancel(); cont.resume(returning: nil) }
            }
        }
    }
}

/// Genau einmal auslösen (Fortsetzung darf nur einmal fortgesetzt werden, egal welcher Rückruf zuerst kommt).
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func fire() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if fired { return false }
        fired = true
        return true
    }
}
