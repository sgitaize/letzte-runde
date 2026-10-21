import CoreImage.CIFilterBuiltins
import SwiftUI
import VisionKit

/// „Wo spielen wir?“ – Online (letzterunde.aize-it.de), im WLAN hosten (ohne Internet) oder einem Spiel im WLAN beitreten.
struct PlaceSheet: View {
    @EnvironmentObject private var host: NodeHost
    @ObservedObject var lan: LanHosting
    var onChanged: () -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var browser = LanBrowser()
    @State private var busy = false
    @State private var error: String?
    @State private var manual = ""
    @State private var scanning = false
    @State private var showHttps = false

    private var mode: NodeHost.Mode { host.state?.mode ?? .online }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    option(.online, icon: "globe", title: "Online",
                           text: T("Räume auf letzterunde.aize-it.de – mit allen, die im Browser, in der Web-App oder in der App spielen.", "Rooms on letzterunde.aize-it.de – with everyone playing in the browser, the web app or the app."))
                    option(.lan, icon: "wifi", title: T("Im WLAN hosten", "Host on Wi-Fi"),
                           text: T("Dieses Gerät ist der Spieltisch. Ohne Internet – die anderen scannen den QR-Code.", "This device is the game table. No internet – the others scan the QR code."))
                } footer: {
                    Text(T("Der Singleplayer läuft immer, auch ganz ohne Netz.", "Singleplayer always works, even with no connection at all."))
                }

                if mode == .lan, let s = host.state, s.lan.on { hostSection(s) }

                Section(T("Einem Spiel im WLAN beitreten", "Join a Wi-Fi game")) {
                    if browser.games.isEmpty {
                        Label(browser.denied ? T("Erlaube „Lokales Netzwerk“ in den Einstellungen, um Spiele zu finden.", "Allow “Local Network” in Settings to find games.")
                                             : T("Suche nach Spielen im WLAN …", "Looking for games on Wi-Fi …"), systemImage: "dot.radiowaves.left.and.right")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(browser.games) { g in
                        Button { Task { await join(g) } } label: {
                            HStack {
                                Label(g.name, systemImage: "suit.spade.fill")
                                Spacer()
                                if mode == .join, host.state?.join.isEmpty == false { EmptyView() }
                            }
                        }
                    }
                    if DataScannerViewController.isSupported {
                        Button { scanning = true } label: { Label(T("QR-Code scannen", "Scan QR code"), systemImage: "qrcode.viewfinder") }
                    }
                    HStack {
                        TextField(T("Adresse, z. B. 192.168.1.23:8380", "Address, e.g. 192.168.1.23:8380"), text: $manual)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button(T("Beitreten", "Join")) { Task { await joinManual() } }.disabled(manual.isEmpty)
                    }
                    if mode == .join, let j = host.state?.join, !j.isEmpty {
                        Label(T("Verbunden mit ", "Connected to ") + j.replacingOccurrences(of: "http://", with: ""), systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }

                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle(T("Wo spielen wir?", "Where do we play?"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(T("Fertig", "Done")) { dismiss() } } }
            .disabled(busy)
            .overlay { if busy { ProgressView() } }
            .sheet(isPresented: $scanning) {
                QRScanner { text in
                    scanning = false
                    manual = text
                    Task { await joinManual() }
                }
                .ignoresSafeArea()
            }
        }
        .onAppear { browser.start(); Task { await host.refresh() } }
        .onDisappear { browser.stop() }
    }

    private func option(_ m: NodeHost.Mode, icon: String, title: String, text: String) -> some View {
        Button { Task { await set(m) } } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon).font(.title2).frame(width: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(text).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                if mode == m { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
        }
        .foregroundStyle(.primary)
    }

    @ViewBuilder
    private func hostSection(_ s: NodeHost.State) -> some View {
        let guest = showHttps && !s.lan.https.isEmpty ? s.lan.https : s.lan.http
        Section {
            if guest.isEmpty {
                Label(T("Kein WLAN gefunden. Verbinde dich mit einem WLAN oder schalte den persönlichen Hotspot ein.", "No Wi-Fi found. Connect to a Wi-Fi network or turn on the personal hotspot."),
                      systemImage: "wifi.exclamationmark")
            } else {
                VStack(spacing: 12) {
                    QRCodeView(text: guest).frame(width: 220, height: 220)
                    Text(guest).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    Text(T("Mitspieler*innen scannen den Code mit der Kamera – im Browser oder in der App. Lass diese App dabei geöffnet.", "Other players scan the code with their camera – in the browser or in the app. Keep this app open meanwhile."))
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if !s.lan.https.isEmpty {
                        Toggle(T("Verschlüsselte Verbindung (https)", "Encrypted connection (https)"), isOn: $showHttps).font(.footnote)
                        if showHttps {
                            Text(T("Der Browser warnt einmal vor dem Zertifikat. Fingerabdruck zum Vergleichen:", "The browser warns once about the certificate. Fingerprint to compare:") + "\n" + s.lan.fingerprint)
                                .font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                    ShareLink(item: URL(string: guest)!) { Label(T("Link teilen", "Share link"), systemImage: "square.and.arrow.up") }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
        } header: {
            Text(T("Dein Spiel im WLAN", "Your Wi-Fi game"))
        }
    }

    private func set(_ m: NodeHost.Mode, join: URL? = nil) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            try await host.setMode(m, join: join)
            lan.sync(with: host.state)
            onChanged()
            if m != .lan { dismiss() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func join(_ g: LanBrowser.Game) async {
        busy = true
        let url = await browser.resolve(g)
        busy = false
        guard let url else { error = g.name + T(" antwortet nicht.", " isn’t responding."); return }
        await set(.join, join: url)
    }

    private func joinManual() async {
        var s = manual.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "http://" + s }
        guard var c = URLComponents(string: s), c.host != nil else { error = T("Ungültige Adresse.", "Invalid address."); return }
        if c.port == nil { c.port = NodeHost.lanPort }
        // QR-Codes können auf eine Einladung zeigen (…/r/CODE) – der Raum wird nach dem Wechsel auf der Startseite beigetreten.
        c.path = ""; c.query = nil; c.fragment = nil
        if c.scheme == "https", c.port == NodeHost.lanPort + 1 { c.scheme = "http"; c.port = NodeHost.lanPort }
        guard let url = c.url else { error = T("Ungültige Adresse.", "Invalid address."); return }
        await set(.join, join: url)
    }
}

/// QR-Code aus CoreImage, scharf skaliert.
struct QRCodeView: View {
    let text: String

    var body: some View {
        if let img = Self.render(text) {
            Image(uiImage: img).interpolation(.none).resizable().scaledToFit()
                .padding(10).background(.white, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    static func render(_ text: String) -> UIImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// QR-Scanner (VisionKit). Liefert den ersten erkannten Text.
struct QRScanner: UIViewControllerRepresentable {
    var onFound: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                           qualityLevel: .balanced, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFound) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onFound: (String) -> Void
        private var done = false
        init(_ f: @escaping (String) -> Void) { onFound = f }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in items {
                if case let .barcode(b) = item, let s = b.payloadStringValue {
                    done = true
                    scanner.stopScanning()
                    onFound(s)
                    return
                }
            }
        }
    }
}
