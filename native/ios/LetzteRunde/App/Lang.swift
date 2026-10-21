import Foundation

/// Sprache der App (Simon 2026-10-21): Umschalter der Spielseite (UserDefaults kr.lang) vor Gerätesprache;
/// alles außer Deutsch → Englisch – wie LANG in index.html
enum Lang {
    static var code: String {
        if let l = UserDefaults.standard.string(forKey: "kr.lang"), l == "de" || l == "en" { return l }
        return Locale.preferredLanguages.first?.lowercased().hasPrefix("de") == true ? "de" : "en"
    }
    static var en: Bool { code == "en" }
}

/// Text je Sprache, wie T(de, en) in index.html
func T(_ de: String, _ en: String) -> String { Lang.en ? en : de }
