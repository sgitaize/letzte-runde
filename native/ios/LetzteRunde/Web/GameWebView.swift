import SafariServices
import SwiftUI
import WebKit

/// Nachrichten der Spielseite an die App (`window.webkit.messageHandlers.kr.postMessage({a: …})`).
enum WebMessage {
    case place                         // Spielort-Dialog öffnen
    case haptic(String)                // light | medium | success | warning | error
    case awake(Bool)                   // Bildschirm anlassen (im Raum)
    case theme(String)                 // Hintergrundfarbe der Seite (#rrggbb) für Ränder/Statusleiste

    init?(_ body: Any) {
        guard let d = body as? [String: Any], let a = d["a"] as? String else { return nil }
        switch a {
        case "place": self = .place
        case "haptic": self = .haptic(d["k"] as? String ?? "light")
        case "awake": self = .awake(d["on"] as? Bool ?? false)
        case "theme": self = .theme(d["c"] as? String ?? "")
        default: return nil
        }
    }
}

/// Die Spieloberfläche: WKWebView auf dem eingebetteten App-Host.
struct GameWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    var onMessage: (WebMessage) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()        // localStorage (Geräteschlüssel, Name, Statistik) bleibt erhalten
        cfg.userContentController.add(context.coordinator, name: "kr")
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

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { retries = 0 }

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
