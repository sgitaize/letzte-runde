package de.sgitaize.letzterunde

import android.content.Context
import android.content.SharedPreferences
import java.util.Locale

/** Sprache der App (Simon 2026-10-21): Umschalter der Spielseite (kr.lang) vor Gerätesprache;
 *  alles außer Deutsch → Englisch – wie LANG in index.html */
object Lang {
    private var prefs: SharedPreferences? = null
    fun init(ctx: Context) { prefs = ctx.getSharedPreferences("kr", Context.MODE_PRIVATE) }
    fun set(l: String) { prefs?.edit()?.putString("lang", l)?.apply() }
    val code: String
        get() {
            val l = prefs?.getString("lang", null)
            if (l == "de" || l == "en") return l
            return if (Locale.getDefault().language == "de") "de" else "en"
        }
    val en: Boolean get() = code == "en"
}

/** Text je Sprache, wie T(de, en) in index.html */
fun T(de: String, en: String): String = if (Lang.en) en else de
