package de.sgitaize.letzterunde

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch

/**
 * „Wo spielen wir?“ – wie PlaceSheet.swift: Online, im WLAN hosten (QR-Code, https-Fingerabdruck),
 * einem Spiel im WLAN beitreten (NSD-Liste, QR scannen, Adresse eintippen).
 */
class PlaceSheet(private val act: MainActivity) {
    private val dialog = BottomSheetDialog(act)
    private val body = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(28)) }
    private val games = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
    private val hostBox = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
    private val errorView = TextView(act).apply { setTextColor(Color.parseColor("#C0392B")); visibility = View.GONE }
    private var state: NodeHost.State? = null
    private var https = false

    fun show() {
        body.addView(title(T("Wo spielen wir?", "Where do we play?"), 20f))
        body.addView(option("🌐  Online", T("Räume auf letzterunde.aize-it.de – mit allen, die im Browser, in der Web-App oder in der App spielen.", "Rooms on letzterunde.aize-it.de – with everyone playing in the browser, the web app or the app.")) { set("online") })
        body.addView(option(T("📶  Im WLAN hosten", "📶  Host on Wi-Fi"), T("Dieses Gerät ist der Spieltisch. Ohne Internet – die anderen scannen den QR-Code.", "This device is the game table. No internet – the others scan the QR code.")) { set("lan") })
        body.addView(note(T("Der Singleplayer läuft immer, auch ganz ohne Netz.", "Singleplayer always works, even with no connection at all.")))
        body.addView(hostBox)
        body.addView(title(T("Einem Spiel im WLAN beitreten", "Join a Wi-Fi game"), 16f).apply { setPadding(0, dp(18), 0, dp(6)) })
        body.addView(games)
        body.addView(MaterialButton(act, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = T("QR-Code scannen", "Scan QR code"); setOnClickListener { scan() }
        })
        val manual = EditText(act).apply {
            hint = "Adresse, z. B. 192.168.1.23:8380"; inputType = InputType.TYPE_TEXT_VARIATION_URI; isSingleLine = true
        }
        body.addView(LinearLayout(act).apply {
            addView(manual, LinearLayout.LayoutParams(0, -2, 1f))
            addView(MaterialButton(act).apply { text = "Beitreten"; setOnClickListener { joinAddress(manual.text.toString()) } })
        })
        body.addView(errorView)
        dialog.setContentView(ScrollView(act).apply { addView(body) })
        dialog.setOnDismissListener { act.lan.stopBrowse() }
        dialog.show()
        refresh()
        act.lan.browse { list -> act.runOnUiThread { showGames(list) } }
        showGames(emptyList())
    }

    private fun refresh() {
        act.lifecycleScope.launch {
            state = runCatching { NodeHost.state() }.getOrNull()
            renderHost()
        }
    }

    private fun set(mode: String, join: String? = null) {
        act.lifecycleScope.launch {
            errorView.visibility = View.GONE
            runCatching { NodeHost.setMode(mode, join) }
                .onSuccess {
                    state = it
                    act.syncLan()
                    act.reload()
                    if (mode == "lan") renderHost() else dialog.dismiss()
                }
                .onFailure { errorView.text = it.message; errorView.visibility = View.VISIBLE }
        }
    }

    private fun renderHost() {
        hostBox.removeAllViews()
        val s = state ?: return
        if (s.mode != "lan" || !s.lan.on) return
        val guest = if (https && s.lan.https.isNotEmpty()) s.lan.https else s.lan.http
        hostBox.setPadding(0, dp(16), 0, 0)
        hostBox.addView(title(T("Dein Spiel im WLAN", "Your Wi-Fi game"), 16f))
        if (guest.isEmpty()) {
            hostBox.addView(note(T("Kein WLAN gefunden. Verbinde dich mit einem WLAN oder schalte den Hotspot ein.", "No Wi-Fi found. Connect to a Wi-Fi network or turn on the hotspot.")))
            return
        }
        hostBox.addView(ImageView(act).apply { setImageBitmap(qr(guest)) }, LinearLayout.LayoutParams(dp(220), dp(220)).apply { topMargin = dp(8) })
        hostBox.addView(TextView(act).apply { text = guest; typeface = Typeface.MONOSPACE; textSize = 15f; setTextIsSelectable(true); gravity = Gravity.CENTER })
        hostBox.addView(note(T("Mitspieler*innen scannen den Code mit der Kamera – im Browser oder in der App. Lass diese App dabei geöffnet.", "Other players scan the code with their camera – in the browser or in the app. Keep this app open meanwhile.")))
        if (s.lan.https.isNotEmpty()) {
            hostBox.addView(MaterialSwitch(act).apply {
                text = T("Verschlüsselte Verbindung (https)", "Encrypted connection (https)"); isChecked = https
                setOnCheckedChangeListener { _, on -> https = on; renderHost() }
            })
            if (https) hostBox.addView(note(T("Der Browser warnt einmal vor dem Zertifikat. Fingerabdruck zum Vergleichen:", "The browser warns once about the certificate. Fingerprint to compare:") + "\n${s.lan.fingerprint}").apply { typeface = Typeface.MONOSPACE; textSize = 11f })
        }
        hostBox.addView(MaterialButton(act, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = T("Link teilen", "Share link")
            setOnClickListener {
                act.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, guest) }, T("Link teilen", "Share link")))
            }
        })
    }

    private fun showGames(list: List<Lan.Game>) {
        games.removeAllViews()
        if (list.isEmpty()) { games.addView(note(T("Suche nach Spielen im WLAN …", "Looking for games on Wi-Fi …"))); return }
        for (g in list) {
            games.addView(MaterialButton(act, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "♠  ${g.name}"; isAllCaps = false
                setOnClickListener {
                    act.lan.resolve(g) { url -> act.runOnUiThread {
                        if (url == null) { errorView.text = g.name + T(" antwortet nicht.", " isn’t responding."); errorView.visibility = View.VISIBLE } else set("join", url)
                    } }
                }
            })
        }
    }

    private fun scan() {
        act.scanQr { text -> if (text != null) joinAddress(text) }
    }

    private fun joinAddress(raw: String) {
        var s = raw.trim()
        if (s.isEmpty()) return
        if (!s.contains("://")) s = "http://$s"
        val u = runCatching { java.net.URI(s) }.getOrNull()
        if (u?.host == null) { errorView.text = T("Ungültige Adresse.", "Invalid address."); errorView.visibility = View.VISIBLE; return }
        var port = if (u.port > 0) u.port else NodeHost.LAN_PORT
        if (u.scheme == "https" && port == NodeHost.LAN_PORT + 1) port = NodeHost.LAN_PORT   // App spricht immer http zum Host
        set("join", "http://${u.host}:$port")
    }

    // ── kleine Bausteine ────────────────────────────────────────────────────
    private fun dp(v: Int) = (v * act.resources.displayMetrics.density).toInt()
    private fun title(t: String, size: Float) = TextView(act).apply { text = t; textSize = size; setTypeface(typeface, Typeface.BOLD); setPadding(0, dp(8), 0, dp(8)) }
    private fun note(t: String) = TextView(act).apply { text = t; textSize = 13f; alpha = 0.7f; setPadding(0, dp(4), 0, dp(4)) }
    private fun option(t: String, d: String, click: () -> Unit) = LinearLayout(act).apply {
        orientation = LinearLayout.VERTICAL; setPadding(0, dp(10), 0, dp(10)); isClickable = true
        val tv = android.util.TypedValue(); act.theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true); setBackgroundResource(tv.resourceId)
        addView(TextView(act).apply { text = t; textSize = 17f; setTypeface(typeface, Typeface.BOLD) })
        addView(note(d))
        setOnClickListener { click() }
        layoutParams = ViewGroup.LayoutParams(-1, -2)
    }
    private fun qr(text: String): Bitmap {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 512, 512)
        val bmp = Bitmap.createBitmap(m.width, m.height, Bitmap.Config.RGB_565)
        for (x in 0 until m.width) for (y in 0 until m.height) bmp.setPixel(x, y, if (m[x, y]) Color.BLACK else Color.WHITE)
        return bmp
    }
}

/** QR-Scanner (ZXing, ohne Google Play). Ergebnis-Rückruf über die Activity. */
private var scanCallback: ((String?) -> Unit)? = null
fun MainActivity.scanQr(done: (String?) -> Unit) {
    scanCallback = done
    qrLauncher.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt(T("QR-Code des Spiels scannen", "Scan the game’s QR code")).setBeepEnabled(false).setOrientationLocked(false))
}
internal fun deliverScan(text: String?) { scanCallback?.invoke(text); scanCallback = null }
internal val scanContract = ScanContract()
