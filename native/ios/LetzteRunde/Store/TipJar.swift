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
    private var updates: Task<Void, Never>?

    private init() {
        // Käufe, die außerhalb abgeschlossen wurden (z. B. nach „Kaufen erfragen“), sauber abschließen
        updates = Task {
            for await result in Transaction.updates {
                if case .verified(let t) = result { await t.finish() }
            }
        }
    }

    func load() async {
        guard products.isEmpty, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            products = try await Product.products(for: Self.productIDs).sorted { $0.price < $1.price }
            if products.isEmpty {   // direkt nach dem Start antwortet der Store manchmal leer: einmal kurz nachfassen
                try? await Task.sleep(for: .seconds(1.5))
                products = try await Product.products(for: Self.productIDs).sorted { $0.price < $1.price }
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func buy(_ p: Product) async {
        error = nil
        do {
            switch try await p.purchase() {
            case .success(let result):
                if case .verified(let t) = result { await t.finish(); thanks = true; Haptics.play("success") }
            case .pending, .userCancelled: break
            @unknown default: break
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SupportView: View {
    @StateObject private var jar = TipJar.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Letzte Runde ist kostenlos.").font(.headline)
                            Text("Ohne Werbung, ohne Tracking, ohne Abo.").font(.subheadline)
                        }
                        Text("Ich baue das Spiel in meiner Freizeit. Wenn es euch gefällt: Spendier mir eine Spezi (oder eine Runde). Es schaltet nichts frei, aber es macht mir eine Freude.")
                            .foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }
                Section {
                    if jar.loading {
                        ProgressView()
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
                            Button { Task { await jar.buy(p) } } label: {
                                row(emoji: emoji(p.id), name: p.displayName, description: p.description, price: p.displayPrice)
                            }
                        }
                    }
                    if let e = jar.error { Text(e).font(.footnote).foregroundStyle(.red) }
                }
                if jar.thanks {
                    Section { Label("Danke! Das bedeutet mir viel.", systemImage: "heart.fill").foregroundStyle(.pink) }
                }
            }
            .navigationTitle("Kauf mir eine Spezi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fertig") { dismiss() } } }
            .task { await jar.load() }
        }
    }

    /// Der App Store hat (noch) keine Produkte geliefert – z. B. ohne Netz: erklären und neu laden lassen
    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Die Optionen konnten gerade nicht vom App Store geladen werden.").foregroundStyle(.secondary)
            Button { Task { await jar.load() } } label: { Label("Erneut versuchen", systemImage: "arrow.clockwise") }
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
