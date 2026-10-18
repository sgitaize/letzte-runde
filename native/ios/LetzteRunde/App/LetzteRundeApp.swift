import SwiftUI

@main
struct LetzteRundeApp: App {
    @StateObject private var host = NodeHost.shared

    init() {
        NodeHost.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(host)
        }
    }
}

/// Vollflächige Spieloberfläche, darüber nur der Spielort-Dialog. Alles andere zeichnet die Spielseite selbst.
struct RootView: View {
    @EnvironmentObject private var host: NodeHost
    @Environment(\.scenePhase) private var phase
    @StateObject private var lan = LanHosting()
    @State private var showPlace = false
    @StateObject private var bridge = WebBridge()
    @State private var auth: AuthRequest?
    @State private var reload = 0
    @State private var pageColor = Color("LaunchBackground")

    var body: some View {
        ZStack {
            pageColor.ignoresSafeArea()
            if host.ready {
                GameWebView(url: host.baseURL, bridge: bridge, reloadToken: reload, onMessage: handle)
                    .ignoresSafeArea()
            } else if let failure = host.failure {
                VStack(spacing: 12) {
                    Text("🃏").font(.system(size: 56))
                    Text(failure).multilineTextAlignment(.center).foregroundStyle(.white)
                }.padding(32)
            } else {
                ProgressView().tint(.white)
            }
        }
        .sheet(isPresented: $showPlace) {
            PlaceSheet(lan: lan) { reload += 1 }
                .environmentObject(host)
        }
        .sheet(item: $auth) { r in
            AuthSheet(kind: r.kind, name: r.name, submit: { kind, name, pw, pw2 in
                guard let res = await bridge.call("return await window.krAuth(kind, name, pw, pw2)",
                                                  ["kind": kind, "name": name, "pw": pw, "pw2": pw2]) else {
                    return "Die Spielseite antwortet nicht. Bitte noch einmal versuchen."
                }
                return res["ok"] as? Bool == true ? nil : (res["error"] as? String ?? "Fehler")
            }, forgot: {
                Task { _ = await bridge.call("window.krAcctPage('recover'); return {}", [:]) }
            })
        }
        .onChange(of: phase) { _, p in
            switch p {
            case .active:
                Task { await host.waitReady(timeout: 8); await host.refresh(); lan.sync(with: host.state) }
            case .background:
                lan.enteredBackground()
            default: break
            }
        }
        .onChange(of: host.state) { _, s in lan.sync(with: s) }
    }

    private func handle(_ m: WebMessage) {
        switch m {
        case .place:
            showPlace = true
        case .haptic(let kind):
            Haptics.play(kind)
        case .awake(let on):
            lan.keepAwake(room: on)
        case .theme(let hex):
            if let c = Color(hex: hex) { pageColor = c }
        case .auth(let kind, let name):
            auth = AuthRequest(kind: kind, name: name)
        }
    }
}

struct AuthRequest: Identifiable {
    let id = UUID()
    let kind: String
    let name: String
}

enum Haptics {
    static func play(_ kind: String) {
        switch kind {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "select": UISelectionFeedbackGenerator().selectionChanged()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}

extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}
