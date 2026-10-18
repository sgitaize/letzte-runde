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
                        Text("Letzte Runde ist kostenlos – ohne Werbung, ohne Tracking, ohne Abo.").font(.headline)
                        Text("Ich baue das Spiel in meiner Freizeit. Wenn es euch gefällt, freue ich mich über ein Trinkgeld – es schaltet nichts frei, es hilft einfach.")
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
                            ForEach(Self.preview, id: \.0) { p in row(emoji: emoji(p.0), name: p.1, description: "Danke! Schaltet nichts frei, hilft einfach.", price: p.2) }
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
            .navigationTitle("Unterstützen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fertig") { dismiss() } } }
            .task { await jar.load() }
        }
    }

    /// Der App Store hat (noch) keine Produkte geliefert – z. B. ohne Netz: erklären und neu laden lassen
    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Die Trinkgeld-Optionen konnten gerade nicht vom App Store geladen werden.").foregroundStyle(.secondary)
            Button { Task { await jar.load() } } label: { Label("Erneut versuchen", systemImage: "arrow.clockwise") }
        }.padding(.vertical, 4)
    }

    private func row(emoji: String, name: String, description: String, price: String) -> some View {
        HStack {
            Text(emoji).font(.title2)
            VStack(alignment: .leading) {
                Text(name).foregroundStyle(.primary)
                if !description.isEmpty { Text(description).font(.footnote).foregroundStyle(.secondary) }
            }
            Spacer()
            Text(price).bold()
        }
    }

    #if DEBUG
    private static let preview = [("small", "Ein Kaffee", "1,99 €"), ("medium", "Ein Kartendeck", "4,99 €"), ("large", "Eine letzte Runde für alle", "9,99 €")]
    #endif

    private func emoji(_ id: String) -> String {
        id.hasSuffix("small") ? "☕️" : id.hasSuffix("medium") ? "🃏" : "🍻"
    }
}
