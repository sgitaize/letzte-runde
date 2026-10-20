package de.sgitaize.letzterunde

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.UUID

/**
 * Eingebettetes Node (nodejs-mobile) mit game/app-host.js – wie NodeHost.swift unter iOS.
 * Die WebView lädt immer http://127.0.0.1:<port>/; gesteuert wird über /__app/… mit einem Token, das nur die App kennt.
 */
object NodeHost {
    init {
        System.loadLibrary("node")
        System.loadLibrary("krnode")
    }

    private external fun startNode(script: String, env: Array<String>): Int

    const val LAN_PORT = 8380
    val port: Int by lazy { freePort(8370) }
    private val token = UUID.randomUUID().toString().replace("-", "")
    @Volatile private var started = false
    @Volatile var failure: String? = null
        private set

    val baseUrl get() = "http://127.0.0.1:$port/"

    data class Lan(val on: Boolean, val ip: String, val http: String, val https: String, val fingerprint: String)
    data class State(val mode: String, val join: String, val lan: Lan, val online: Boolean?, val queue: Int)

    /** Entpackt das Spiel bei neuer App-Version nach filesDir/game und startet Node in einem eigenen Thread. */
    fun start(ctx: Context) {
        if (started) return
        started = true
        val game = File(ctx.filesDir, "game")
        val stamp = File(ctx.filesDir, "game.version")
        val version = BuildConfig.VERSION_CODE.toString() + "-" + ctx.packageManager
            .getPackageInfo(ctx.packageName, 0).lastUpdateTime
        if (!game.exists() || !stamp.exists() || stamp.readText() != version) {
            game.deleteRecursively()
            copyAssets(ctx, "game", game)
            stamp.writeText(version)
        }
        val varDir = File(ctx.noBackupFilesDir, "letzterunde").apply { mkdirs() }
        val env = arrayOf(
            "KR_APP_PORT=$port",
            "KR_APP_TOKEN=$token",
            "KR_VAR_DIR=${varDir.absolutePath}",
            "KR_PUBLIC=${File(game, "public").absolutePath}",
            "KR_LAN_PORT=$LAN_PORT",
            "KR_UPSTREAM=https://letzterunde.aize-it.de",
            "KR_PLATFORM=android",
            "KR_STORE=${BuildConfig.STORE}",
            "KR_APP_VERSION=${BuildConfig.VERSION_NAME}",
            "KR_LEADER_SOCK=${File(ctx.cacheDir, "kr.sock").absolutePath}",
            "TMPDIR=${ctx.cacheDir.absolutePath}",
        )
        Thread(null, {
            val rc = startNode(File(game, "app-host.js").absolutePath, env)
            failure = "Der Spielserver wurde beendet ($rc)."
        }, "node", 8L * 1024 * 1024).start()
    }

    /** Wartet, bis der App-Host antwortet (Start, Rückkehr in den Vordergrund). */
    suspend fun waitReady(timeoutMs: Long = 20_000): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (runCatching { state() }.isSuccess) return true
            delay(150)
        }
        return false
    }

    suspend fun state(): State = call("state", null)

    suspend fun setMode(mode: String, join: String? = null): State =
        call("mode", JSONObject().put("mode", mode).apply { if (join != null) put("join", join) })

    private suspend fun call(path: String, body: JSONObject?): State = withContext(Dispatchers.IO) {
        val c = URL("${baseUrl}__app/$path").openConnection() as HttpURLConnection
        c.connectTimeout = 2000
        c.readTimeout = 4000
        c.setRequestProperty("x-kr-app", token)
        if (body != null) {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code != 200) throw IllegalStateException(runCatching { JSONObject(text).getString("error") }.getOrDefault("Fehler $code"))
        val j = JSONObject(text)
        val l = j.getJSONObject("lan")
        State(
            mode = j.getString("mode"), join = j.optString("join"),
            lan = Lan(l.getBoolean("on"), l.optString("ip"), l.optString("http"), l.optString("https"), l.optString("fingerprint")),
            online = if (j.isNull("online")) null else j.getBoolean("online"),
            queue = j.optInt("queue"),
        )
    }

    private fun copyAssets(ctx: Context, path: String, dst: File) {
        val list = ctx.assets.list(path) ?: emptyArray()
        if (list.isEmpty()) {
            dst.parentFile?.mkdirs()
            ctx.assets.open(path).use { input -> dst.outputStream().use { input.copyTo(it) } }
            return
        }
        dst.mkdirs()
        for (name in list) copyAssets(ctx, "$path/$name", File(dst, name))
    }

    /** Bevorzugter Port, sonst ein freier – der Spielserver nutzt port + 1, beide müssen frei sein. */
    private fun freePort(preferred: Int): Int {
        fun free(p: Int) = runCatching { ServerSocket(p, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort } }.getOrNull()
        if (free(preferred) != null && free(preferred + 1) != null) return preferred
        repeat(20) {
            val p = free(0) ?: return@repeat
            if (p < 65000 && free(p + 1) != null) return p
        }
        return preferred
    }
}
