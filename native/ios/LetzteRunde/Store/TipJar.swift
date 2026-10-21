import StoreKit
import SwiftUI

/// Trinkgeld per In-App-Kauf (drei Verbrauchsartikel, schalten nichts frei) – wie bei bookshelv. Apple erlaubt in der App
/// keine externen Spendenlinks; im Web und in der Android-App führt „Unterstützen“ zum Spendenlink aus dem Admin.
/// Die Produkte legt der Account-Inhaber in App Store Connect an (IDs: <Bundle-ID>.tip.small|medium|large, siehe
/// docs/store/README.md); zum Testen in Xcode liefert LetzteRunde.storekit dieselben IDs.
@MainActor
final class TipJar: ObservableObject {
    static let shared = TipJar()
    static var productIDs: [String] {
        let base = Bundle.main.bundleIdentifier ?? "de.aize.letzterunde"
        return ["small", "medium", "large"].map { "\(base).tip.\($0)" }
    }

    @Published private(set) var products: [Product] = []
    @Published private(set) var loading = false
    @Published private(set) var thanks = false
    @Published var error: String?
    @Published private(set) var pending = false
    private var updates: Task<Void, Never>?

    private init() {
        // Käufe, die außerhalb abgeschlossen wurden (z. B. nach „Kaufen erfragen“), sauber abschließen
        updates = Task {
            for await result in Transaction.updates {
                if case .verified(let t) = result { await t.finish() }
            }
        }
    }

    /// Produkte laden – mit Geduld: im Review-Sandbox und direkt nach dem Start antwortet der Store manchmal leer oder
    /// mit Fehler. Bis zu vier Versuche (0 / 1,5 / 3 / 5 s), erst danach gilt es als nicht verfügbar.
    func load() async {
        guard products.isEmpty, !loading else { return }
        loading = true
        defer { loading = false }
        var lastError: Error?
        for wait in [0.0, 1.5, 3, 5] {
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            do {
                let p = try await Product.products(for: Self.productIDs)
                if !p.isEmpty { products = p.sorted { $0.price < $1.price }; error = nil; return }
                lastError = nil
            } catch { lastError = error }
        }
        if let lastError { self.error = Self.message(for: lastError) }
    }

    /// Kauf über die PurchaseAction der Ansicht (SwiftUI): sie hängt den Kaufdialog an die richtige Szene – auf dem iPad
    /// mit mehreren Fenstern scheitert ein Kauf ohne Szene sonst.
    func buy(_ p: Product, with purchase: PurchaseAction) async {
        error = nil; pending = false
        do {
            switch try await purchase(p) {
            case .success(let result):
                switch result {
                case .verified(let t): await t.finish(); thanks = true; Haptics.play("success")
                case .unverified(let t, _): await t.finish(); thanks = true   // Trinkgeld schaltet nichts frei – trotzdem danken
                }
            case .pending: pending = true
            case .userCancelled: break
            @unknown default: break
            }
        } catch {
            self.error = Self.message(for: error)
        }
    }

    /// Verständliche Meldung statt roher StoreKit-Fehler
    static func message(for error: Error) -> String? {
        if let e = error as? StoreKitError {
            switch e {
            case .userCancelled: return nil
            case .networkError: return T("Keine Verbindung zum App Store. Bitte prüfe das Internet und versuche es noch einmal.", "No connection to the App Store. Please check your internet connection and try again.")
            case .notAvailableInStorefront: return T("In diesem Land gerade nicht verfügbar.", "Not available in this country right now.")
            case .notEntitled: return T("Käufe sind auf diesem Gerät nicht erlaubt (Bildschirmzeit).", "Purchases aren’t allowed on this device (Screen Time).")
            default: break
            }
        }
        if let e = error as? Product.PurchaseError, case .purchaseNotAllowed = e {
            return T("Käufe sind auf diesem Gerät nicht erlaubt (Bildschirmzeit).", "Purchases aren’t allowed on this device (Screen Time).")
        }
        return T("Der Kauf hat nicht geklappt: ", "The purchase didn’t work: ") + error.localizedDescription
    }
}

struct SupportView: View {
    @StateObject private var jar = TipJar.shared
    @Environment(\.purchase) private var purchase
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(T("Letzte Runde ist kostenlos.", "Letzte Runde is free.")).font(.headline)
                            Text(T("Ohne Werbung, ohne Tracking, ohne Abo.", "No ads, no tracking, no subscription.")).font(.subheadline)
                        }
                        Text(T("Ich baue das Spiel in meiner Freizeit. Wenn es euch gefällt: Spendier mir eine Spezi (oder eine Runde). Es schaltet nichts frei, aber es macht mir eine Freude.", "I build this game in my spare time. If you enjoy it: buy me a Spezi (or a round). It unlocks nothing, but it makes me happy."))
                            .foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }
                Section {
                    if jar.loading {
                        HStack(spacing: 10) { ProgressView(); Text(T("Lädt vom App Store …", "Loading from the App Store …")).foregroundStyle(.secondary) }
                    } else if jar.products.isEmpty {
                        #if DEBUG
                        // Review-Screenshot im Simulator (dort liefert der Store ohne .storekit nichts): -tipPreview YES
                        if UserDefaults.standard.bool(forKey: "tipPreview") {
                            ForEach(Self.preview, id: \.0) { p in row(emoji: emoji(p.0), name: p.1, description: p.3, price: p.2) }
                        } else { unavailable }
                        #else
                        unavailable
                        #endif
                    } else {
                        ForEach(jar.products, id: \.id) { p in
                            Button { Task { await jar.buy(p, with: purchase) } } label: {
                                row(emoji: emoji(p.id), name: p.displayName, description: p.description, price: p.displayPrice)
                            }
                        }
                    }
                    if let e = jar.error { Text(e).font(.footnote).foregroundStyle(.red) }
                    if jar.pending { Text(T("Der Kauf wartet noch auf Bestätigung (z. B. „Kaufen erfragen“).", "The purchase is waiting for approval (e.g. “Ask to Buy”).")).font(.footnote).foregroundStyle(.secondary) }
                }
                if jar.thanks {
                    Section { Label(T("Danke! Das bedeutet mir viel.", "Thank you! That means a lot to me."), systemImage: "heart.fill").foregroundStyle(.pink) }
                }
            }
            .navigationTitle(T("Kauf mir eine Spezi", "Buy me a Spezi"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(T("Fertig", "Done")) { dismiss() } } }
            .task { await jar.load() }
        }
    }

    /// Der App Store hat (noch) keine Produkte geliefert – z. B. ohne Netz: erklären und neu laden lassen
    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(T("Die Optionen konnten gerade nicht vom App Store geladen werden.", "The options couldn’t be loaded from the App Store right now.")).foregroundStyle(.secondary)
            Button { Task { await jar.load() } } label: { Label(T("Erneut versuchen", "Try again"), systemImage: "arrow.clockwise") }
        }.padding(.vertical, 4)
    }

    private func row(emoji: String, name: String, description: String, price: String) -> some View {
        HStack {
            TipIcon(kind: emoji).frame(width: 44, height: 34)
            VStack(alignment: .leading) {
                Text(name).foregroundStyle(.primary)
                if !description.isEmpty { Text(description.replacingOccurrences(of: ";)", with: "😉")).font(.footnote).foregroundStyle(.secondary) }   // App Store Connect erlaubt keine Emojis
            }
            Spacer()
            Text(price).bold()
        }
    }

    #if DEBUG
    private static let preview = [("small", "Eine Spezi", "0,99 €", "Danke! Schaltet nichts frei."), ("medium", "Tagesration Spezi", "3,99 €", "Danke! Schaltet nichts frei."), ("large", "Kasten Spezi", "9,99 €", "Bei Netto im Angebot? 😉")]
    #endif

    private func emoji(_ id: String) -> String {
        id.hasSuffix("small") ? "small" : id.hasSuffix("medium") ? "medium" : "large"
    }
}

/// Kleine Spezi-Flasche (selbst gezeichnet, ohne Logo) für die kleinste Stufe – wie im Web (SPEZI in index.html)
struct SpeziBottle: View {
    var body: some View {
        Canvas { ctx, size in
            let sx = size.width / 16, sy = size.height / 40
            func r(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect { CGRect(x: x * sx, y: y * sy, width: w * sx, height: h * sy) }
            ctx.fill(Path(roundedRect: r(5.5, 0.5, 5, 3), cornerRadius: sx), with: .color(Color(red: 0.79, green: 0.64, blue: 0.15)))
            var body = Path()
            body.move(to: CGPoint(x: 6 * sx, y: 3.5 * sy)); body.addLine(to: CGPoint(x: 10 * sx, y: 3.5 * sy))
            body.addLine(to: CGPoint(x: 10 * sx, y: 9.5 * sy))
            body.addQuadCurve(to: CGPoint(x: 14 * sx, y: 17 * sy), control: CGPoint(x: 14 * sx, y: 12 * sy))
            body.addLine(to: CGPoint(x: 14 * sx, y: 37 * sy))
            body.addQuadCurve(to: CGPoint(x: 11.5 * sx, y: 39.5 * sy), control: CGPoint(x: 14 * sx, y: 39.5 * sy))
            body.addLine(to: CGPoint(x: 4.5 * sx, y: 39.5 * sy))
            body.addQuadCurve(to: CGPoint(x: 2 * sx, y: 37 * sy), control: CGPoint(x: 2 * sx, y: 39.5 * sy))
            body.addLine(to: CGPoint(x: 2 * sx, y: 17 * sy))
            body.addQuadCurve(to: CGPoint(x: 6 * sx, y: 9.5 * sy), control: CGPoint(x: 2 * sx, y: 12 * sy))
            body.closeSubpath()
            ctx.fill(body, with: .color(Color(red: 0.35, green: 0.16, blue: 0.07)))
            ctx.fill(Path(r(2, 20, 12, 10)), with: .color(Color(red: 0.95, green: 0.61, blue: 0.12)))
            ctx.fill(Path(r(2, 23.5, 12, 3)), with: .color(Color(red: 0.23, green: 0.49, blue: 0.85)))
        }
        .accessibilityHidden(true)
    }
}

/// Bild je Stufe: eine Flasche, drei Flaschen (Tagesration), Kasten
struct TipIcon: View {
    let kind: String
    var body: some View {
        switch kind {
        case "small": SpeziBottle().frame(width: 14, height: 34)
        case "medium": HStack(spacing: 1) { ForEach(0..<3, id: \.self) { _ in SpeziBottle().frame(width: 12, height: 29) } }
        default: SpeziCrate().frame(width: 42, height: 34)
        }
    }
}

/// Getränkekiste mit fünf Flaschenhälsen (selbst gezeichnet, ohne Logo) – wie KASTEN in index.html
struct SpeziCrate: View {
    var body: some View {
        Canvas { ctx, size in
            let sx = size.width / 48, sy = size.height / 40
            func r(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect { CGRect(x: x * sx, y: y * sy, width: w * sx, height: h * sy) }
            for x in [4.0, 13, 22, 31, 40] {
                ctx.fill(Path(roundedRect: r(x, 2, 4, 12), cornerRadius: sx), with: .color(Color(red: 0.35, green: 0.16, blue: 0.07)))
                ctx.fill(Path(roundedRect: r(x, 1, 4, 2.5), cornerRadius: sx), with: .color(Color(red: 0.79, green: 0.64, blue: 0.15)))
            }
            ctx.fill(Path(roundedRect: r(1, 12, 46, 27), cornerRadius: 3 * sx), with: .color(Color(red: 0.95, green: 0.61, blue: 0.12)))
            ctx.fill(Path(r(1, 21, 46, 6)), with: .color(Color(red: 0.23, green: 0.49, blue: 0.85)))
            ctx.fill(Path(roundedRect: r(17, 15, 14, 4), cornerRadius: 2 * sx), with: .color(Color(red: 0.72, green: 0.43, blue: 0.06)))
        }
        .accessibilityHidden(true)
    }
}
