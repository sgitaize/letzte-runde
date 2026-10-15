package de.sgitaize.letzterunde

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Vollflächige Spieloberfläche (WebView auf dem App-Host), darüber nur der Spielort-Dialog. */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    lateinit var lan: Lan
        private set
    private var hosting = false
    private var inRoom = false
    private var pendingMic: PermissionRequest? = null

    val qrLauncher = registerForActivityResult(scanContract) { r -> deliverScan(r.contents) }

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        pendingMic?.let { if (ok) it.grant(it.resources) else it.deny() }
        pendingMic = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        lan = Lan(this)
        NodeHost.start(applicationContext)

        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0F3324")) }
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0F3324"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true            // localStorage: Geräteschlüssel, Name, Statistik
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportMultipleWindows(true)
            settings.userAgentString = settings.userAgentString + " LetzteRundeApp/1"
            addJavascriptInterface(WebBridge(this@MainActivity), "KRAndroid")
            webViewClient = Client()
            webChromeClient = Chrome()
            visibility = View.INVISIBLE
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        val spinner = ProgressBar(this)
        root.addView(spinner, FrameLayout.LayoutParams(-2, -2, android.view.Gravity.CENTER))
        setContentView(root)
        // Android 15 zeichnet randlos: Statusleiste/Navigationsleiste und Tastatur als Abstand (die WebView kennt keine safe-area)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        lifecycleScope.launch {
            if (NodeHost.waitReady()) {
                root.removeView(spinner)
                web.visibility = View.VISIBLE
                web.loadUrl(NodeHost.baseUrl)
                syncLan()
            } else {
                root.removeView(spinner)
                root.addView(TextView(this@MainActivity).apply {
                    text = NodeHost.failure ?: "Der Spielserver startet nicht."
                    setTextColor(Color.WHITE); textSize = 17f; setPadding(64, 64, 64, 64)
                }, FrameLayout.LayoutParams(-1, -2, android.view.Gravity.CENTER))
            }
        }
    }

    override fun onResume() {
        super.onResume()
        lifecycleScope.launch { NodeHost.waitReady(8000); syncLan() }
    }

    /** Nach einem Moduswechsel: Seite neu laden (der App-Host liefert dann neue KR_APP-Infos). */
    fun reload() { web.loadUrl(NodeHost.baseUrl) }

    fun syncLan() {
        lifecycleScope.launch {
            val s = runCatching { NodeHost.state() }.getOrNull() ?: return@launch
            val on = s.mode == "lan" && s.lan.on
            if (on != hosting) {
                hosting = on
                if (on) lan.publish(s) else lan.unpublish()
            }
            updateKeepAwake()
        }
    }

    fun onWebMessage(json: String) {
        val m = runCatching { JSONObject(json) }.getOrNull() ?: return
        when (m.optString("a")) {
            "place" -> PlaceSheet(this).show()
            "haptic" -> haptic(m.optString("k", "light"))
            "awake" -> { inRoom = m.optBoolean("on"); updateKeepAwake() }
        }
    }

    private fun updateKeepAwake() {
        if (hosting || inRoom) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun haptic(kind: String) {
        val v: Vibrator = if (Build.VERSION.SDK_INT >= 31)
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        else @Suppress("DEPRECATION") (getSystemService(VIBRATOR_SERVICE) as Vibrator)
        val effect = when (kind) {
            "success" -> if (Build.VERSION.SDK_INT >= 29) VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK) else VibrationEffect.createOneShot(60, 200)
            "medium", "warning", "error" -> if (Build.VERSION.SDK_INT >= 29) VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK) else VibrationEffect.createOneShot(40, 180)
            else -> if (Build.VERSION.SDK_INT >= 29) VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK) else VibrationEffect.createOneShot(15, 120)
        }
        runCatching { v.vibrate(effect) }
    }

    private fun isLocal(uri: Uri?) = uri?.host == "127.0.0.1" && uri.port == NodeHost.port

    private fun openExternally(uri: Uri) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    }

    private inner class Client : WebViewClient() {
        private var retries = 0
        override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
            if (isLocal(req.url)) return false
            openExternally(req.url)
            return true
        }
        override fun onPageFinished(view: WebView, url: String) { retries = 0 }
        override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
            if (!req.isForMainFrame || retries++ > 30) return
            lifecycleScope.launch { NodeHost.waitReady(5000); view.loadUrl(NodeHost.baseUrl) }
        }
    }

    private inner class Chrome : WebChromeClient() {
        // window.open / target=_blank → extern (Impressum-Links, GitHub …)
        override fun onCreateWindow(view: WebView, dialog: Boolean, user: Boolean, msg: android.os.Message): Boolean {
            val href = view.hitTestResult.extra ?: return false
            val uri = Uri.parse(href)
            if (isLocal(uri)) web.loadUrl(href) else openExternally(uri)
            return false
        }
        // Voice-Chat (WebRTC): Mikrofon nur für die eigene Seite
        override fun onPermissionRequest(request: PermissionRequest) {
            if (!isLocal(request.origin) || !request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                request.deny(); return
            }
            if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                pendingMic = request
                micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }
}

/** `window.KRAndroid.post(json)` aus der Spielseite (index.html: appMsg). */
class WebBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun post(json: String) {
        activity.runOnUiThread { activity.onWebMessage(json) }
    }
}
