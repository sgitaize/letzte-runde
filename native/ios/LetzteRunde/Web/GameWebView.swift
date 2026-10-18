import SafariServices
import SwiftUI
import WebKit

/// Nachrichten der Spielseite an die App (`window.webkit.messageHandlers.kr.postMessage({a: …})`).
enum WebMessage {
    case place                         // Spielort-Dialog öffnen
    case haptic(String)                // light | medium | success | warning | error
    case awake(Bool)                   // Bildschirm anlassen (im Raum)
    case theme(String)                 // Hintergrundfarbe der Seite (#rrggbb) für Ränder/Statusleiste
    case auth(kind: String, name: String) // natives Anmelde-/Registrierformular (Passwort-AutoFill)

    init?(_ body: Any) {
        guard let d = body as? [String: Any], let a = d["a"] as? String else { return nil }
        switch a {
        case "place": self = .place
        case "haptic": self = .haptic(d["k"] as? String ?? "light")
        case "awake": self = .awake(d["on"] as? Bool ?? false)
        case "theme": self = .theme(d["c"] as? String ?? "")
        case "auth": self = .auth(kind: d["k"] as? String == "register" ? "register" : "login", name: d["name"] as? String ?? "")
        default: return nil
        }
    }
}

/// Die Spieloberfläche: WKWebView auf dem eingebetteten App-Host.
/// Zugriff aus SwiftUI auf die laufende WebView (z. B. Anmeldung aus dem nativen Formular an die Seite reichen).
@MainActor
final class WebBridge: ObservableObject {
    weak var web: WKWebView?

    /// Ruft eine async-Funktion der Seite auf (Argumente als Variablen, nie in den Code eingesetzt).
    func call(_ js: String, _ args: [String: Any]) async -> [String: Any]? {
        guard let web else { return nil }
        return (try? await web.callAsyncJavaScript(js, arguments: args, in: nil, contentWorld: .page)) as? [String: Any]
    }
}

struct GameWebView: UIViewRepresentable {
    let url: URL
    let bridge: WebBridge
    let reloadToken: Int
    var onMessage: (WebMessage) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()        // localStorage (Geräteschlüssel, Name, Statistik) bleibt erhalten
        cfg.userContentController.add(context.coordinator, name: "kr")
        // Die Seite fragt hiermit, ob die App das native Anmeldeformular anbietet (nur iOS)
        cfg.userContentController.addUserScript(WKUserScript(source: "window.KR_NATIVE={auth:1};",
                                                             injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.applicationNameForUserAgent = "LetzteRundeApp/1"
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = false
        web.scrollView.contentInsetAdjustmentBehavior = .never   // die Seite nutzt env(safe-area-inset-*)
        web.isOpaque = false
        web.backgroundColor = UIColor(named: "LaunchBackground")
        web.scrollView.backgroundColor = UIColor(named: "LaunchBackground")
        #if DEBUG
        web.isInspectable = true
        #endif
        context.coordinator.web = web
        bridge.web = web
        context.coordinator.lastToken = reloadToken
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            web.load(URLRequest(url: url))
        }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "kr")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: GameWebView
        weak var web: WKWebView?
        var lastToken = 0
        private var retries = 0

        init(_ parent: GameWebView) { self.parent = parent }

        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, isLocal(message.frameInfo.request.url),
                  let m = WebMessage(message.body) else { return }
            parent.onMessage(m)
        }

        // Nur die eigene Seite (127.0.0.1) in der App, alles andere (Impressum-Links, GitHub …) in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if isLocal(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
                return decisionHandler(.allow)
            }
            decisionHandler(.cancel)
            openExternally(url)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if isLocal(url) { webView.load(URLRequest(url: url)) } else { openExternally(url) }
            }
            return nil
        }

        // Voice-Chat (WebRTC): iOS fragt selbst nach dem Mikrofon; die Seite hat schon eingewilligt.
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(origin.host == "127.0.0.1" && type == .microphone ? .grant : .deny)
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(alert: message, confirm: false) { _ in completionHandler() }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(alert: message, confirm: true, completion: completionHandler)
        }

        // Ladefehler (Host öffnet seinen Socket nach dem Aufwachen gerade neu): kurz warten, erneut laden.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
            retry(webView)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            retries = 0
            #if DEBUG
            // Simulator-Tests: simctl launch mit SIMCTL_CHILD_KR_DEBUG_JS='…' führt das Skript nach dem ersten Laden aus
            if !debugRan, let js = ProcessInfo.processInfo.environment["KR_DEBUG_JS"], !js.isEmpty {
                debugRan = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { webView.evaluateJavaScript(js) }
            }
            #endif
        }
        #if DEBUG
        private var debugRan = false
        #endif

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

        private func retry(_ webView: WKWebView) {
            guard retries < 30 else { return }
            retries += 1
            Task { @MainActor in
                await NodeHost.shared.waitReady(timeout: 5)
                webView.load(URLRequest(url: self.parent.url))
            }
        }

        private func isLocal(_ url: URL?) -> Bool {
            guard let url else { return false }
            return url.host == "127.0.0.1" && url.port == parent.url.port
        }

        private func openExternally(_ url: URL) {
            guard url.scheme == "https" || url.scheme == "http" else {
                UIApplication.shared.open(url)
                return
            }
            let vc = SFSafariViewController(url: url)
            topController()?.present(vc, animated: true)
        }

        private func present(alert message: String, confirm: Bool, completion: @escaping (Bool) -> Void) {
            let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            if confirm { ac.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completion(false) }) }
            ac.addAction(UIAlertAction(title: "OK", style: .default) { _ in completion(true) })
            guard let top = topController() else { return completion(false) }
            top.present(ac, animated: true)
        }

        private func topController() -> UIViewController? {
            var vc = web?.window?.rootViewController
            while let p = vc?.presentedViewController { vc = p }
            return vc
        }
    }
}

/// Anmelden / Konto erstellen nativ: iOS ordnet die Felder über webcredentials:letzterunde.aize-it.de zu und bietet gespeicherte
/// Passwörter, starke Passwörter und „Passwort sichern?“ an (auf der Seite unter 127.0.0.1 ginge das nicht).
struct AuthSheet: View {
    @State var kind: String
    @State var name: String
    let submit: (_ kind: String, _ name: String, _ pw: String, _ pw2: String) async -> String?   // Fehlertext oder nil
    let forgot: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var pw = ""
    @State private var pw2 = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focus: Field?
    private enum Field { case name, pw, pw2 }

    private var register: Bool { kind == "register" }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Aktion", selection: $kind) {
                    Text("Anmelden").tag("login")
                    Text("Konto erstellen").tag("register")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())

                Section {
                    TextField("Name", text: $name)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .name)
                        .submitLabel(.next)
                        .onSubmit { focus = .pw }
                    SecureField(register ? "Passwort (mind. 8 Zeichen)" : "Passwort", text: $pw)
                        .textContentType(register ? .newPassword : .password)
                        .focused($focus, equals: .pw)
                        .submitLabel(register ? .next : .go)
                        .onSubmit { if register { focus = .pw2 } else { send() } }
                    if register {
                        SecureField("Passwort wiederholen", text: $pw2)
                            .textContentType(.newPassword)
                            .focused($focus, equals: .pw2)
                            .submitLabel(.go)
                            .onSubmit(send)
                    }
                } footer: {
                    if register {
                        Text("Ohne E-Mail: nur Name (2–18 Zeichen) und Passwort. Danach bekommst du einen Wiederherstellungscode – den brauchst du, falls du das Passwort vergisst.")
                    } else {
                        Text("Deine Statistik aus Übungsraum und Räumen ist auf jedem Gerät da, auf dem du angemeldet bist.")
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }

                Section {
                    Button(action: send) {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text(register ? "Konto erstellen" : "Anmelden").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || pw.isEmpty || (register && pw2.isEmpty))
                }

                if !register {
                    Section {
                        Button("Passwort vergessen?") { dismiss(); forgot() }
                    }
                }
            }
            .navigationTitle(register ? "Konto erstellen" : "Anmelden")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
            }
            .onChange(of: kind) { _, _ in error = nil }
            .onAppear { focus = name.isEmpty ? .name : .pw }
        }
        .interactiveDismissDisabled(busy)
    }

    private func send() {
        guard !busy else { return }
        error = nil
        busy = true
        Task {
            let e = await submit(kind, name.trimmingCharacters(in: .whitespaces), pw, pw2)
            busy = false
            if let e { error = e } else { dismiss() }   // Felder verschwinden nach Erfolg → iOS bietet „Passwort sichern?“ an
        }
    }
}
