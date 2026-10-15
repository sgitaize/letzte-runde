package de.sgitaize.letzterunde

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import java.net.Inet4Address

/** Bonjour/NSD wie unter iOS: `_letzterunde._tcp` anbieten (WLAN-Host) und im WLAN suchen (Beitreten). */
class Lan(private val ctx: Context) {
    private val nsd = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var multicast: WifiManager.MulticastLock? = null

    data class Game(val name: String, val info: NsdServiceInfo)

    // ── Anbieten ────────────────────────────────────────────────────────────
    fun publish(state: NodeHost.State) {
        if (registration != null) return
        val info = NsdServiceInfo().apply {
            serviceName = "Letzte Runde – ${Build.MODEL}"
            serviceType = TYPE
            port = NodeHost.LAN_PORT
            setAttribute("v", "1")
            if (state.lan.https.isNotEmpty()) setAttribute("https", (NodeHost.LAN_PORT + 1).toString())
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(i: NsdServiceInfo) {}
            override fun onRegistrationFailed(i: NsdServiceInfo, e: Int) { registration = null }
            override fun onServiceUnregistered(i: NsdServiceInfo) {}
            override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
        }
        registration = l
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
    }

    fun unpublish() {
        registration?.let { runCatching { nsd.unregisterService(it) } }
        registration = null
    }

    // ── Suchen ──────────────────────────────────────────────────────────────
    fun browse(onChange: (List<Game>) -> Unit) {
        if (discovery != null) return
        multicast = wifi.createMulticastLock("letzterunde").apply { setReferenceCounted(false); acquire() }
        val found = linkedMapOf<String, Game>()
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) { discovery = null }
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onServiceFound(i: NsdServiceInfo) {
                if (i.serviceName.endsWith(Build.MODEL) && registration != null) return   // eigenes Spiel
                found[i.serviceName] = Game(i.serviceName, i)
                onChange(found.values.toList())
            }
            override fun onServiceLost(i: NsdServiceInfo) {
                found.remove(i.serviceName)
                onChange(found.values.toList())
            }
        }
        discovery = l
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, l)
    }

    fun stopBrowse() {
        discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        discovery = null
        multicast?.release()
        multicast = null
    }

    /** Löst ein gefundenes Spiel in http://<ipv4>:<port> auf. */
    @Suppress("DEPRECATION")
    fun resolve(game: Game, done: (String?) -> Unit) {
        nsd.resolveService(game.info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(i: NsdServiceInfo, e: Int) = done(null)
            override fun onServiceResolved(i: NsdServiceInfo) {
                val host = if (Build.VERSION.SDK_INT >= 34) i.hostAddresses.firstOrNull { it is Inet4Address } else i.host
                done(host?.hostAddress?.let { "http://$it:${i.port}" })
            }
        })
    }

    companion object { const val TYPE = "_letzterunde._tcp" }
}
