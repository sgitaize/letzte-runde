package de.sgitaize.letzterunde

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.BillingResponseCode
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * Google Play: „Kauf mir eine Spezi“ per Play Billing – wie TipJar.swift bei iOS (drei Verbrauchsartikel mit denselben IDs,
 * schalten nichts frei, jeder Kauf wird sofort verbraucht). Play erlaubt hier keinen externen Spendenlink.
 */
object Tips {
    private val IDS = listOf("small", "medium", "large").map { "de.sgitaize.letzterunde.tip.$it" }

    private var client: BillingClient? = null
    private var products: List<ProductDetails> = emptyList()
    private var sheet: Sheet? = null

    fun show(act: MainActivity) {
        sheet = Sheet(act).also { it.show() }
        connect(act)
    }

    private fun connect(ctx: Context) {
        client?.let { if (it.isReady) { load(); return } }
        sheet?.loading()
        val c = BillingClient.newBuilder(ctx.applicationContext)
            .setListener { result, purchases -> onPurchases(result, purchases) }
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
        client = c
        c.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode != BillingResponseCode.OK) { ui { sheet?.unavailable() }; return }
                load()
                // Käufe, die noch nicht verbraucht sind (App während des Kaufs beendet, „ausstehend“ bezahlt) nachholen
                c.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(ProductType.INAPP).build()) { _, list -> list.forEach(::consume) }
            }
            override fun onBillingServiceDisconnected() { client = null }
        })
    }

    private fun load() {
        val c = client ?: return
        val params = QueryProductDetailsParams.newBuilder().setProductList(IDS.map {
            QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(ProductType.INAPP).build()
        }).build()
        c.queryProductDetailsAsync(params) { result, res ->
            val list = res.productDetailsList   // Billing 8: Ergebnisobjekt statt Liste
            ui {
                if (result.responseCode == BillingResponseCode.OK && list.isNotEmpty()) {
                    products = list.sortedBy { it.oneTimePurchaseOfferDetails?.priceAmountMicros ?: 0 }
                    sheet?.products(products)
                } else sheet?.unavailable()
            }
        }
    }

    fun buy(act: MainActivity, p: ProductDetails) {
        val c = client ?: return
        val flow = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(p).build()))
            .build()
        val r = c.launchBillingFlow(act, flow)
        if (r.responseCode != BillingResponseCode.OK && r.responseCode != BillingResponseCode.USER_CANCELED) sheet?.error(r.debugMessage)
    }

    private fun onPurchases(result: BillingResult, purchases: List<Purchase>?) {
        if (result.responseCode == BillingResponseCode.OK) purchases?.forEach(::consume)
        else if (result.responseCode != BillingResponseCode.USER_CANCELED) ui { sheet?.error(result.debugMessage) }
    }

    private fun consume(p: Purchase) {
        if (p.purchaseState != Purchase.PurchaseState.PURCHASED) return
        client?.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(p.purchaseToken).build()) { r, _ ->
            if (r.responseCode == BillingResponseCode.OK) ui { sheet?.thanks() }
        }
    }

    private fun ui(f: () -> Unit) { sheet?.act?.runOnUiThread(f) }

    private class Sheet(val act: MainActivity) {
        private val dialog = BottomSheetDialog(act)
        private val list = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL }
        private val status = TextView(act).apply { textSize = 15f; alpha = 0.7f; setPadding(0, dp(8), 0, dp(8)) }

        fun show() {
            val body = LinearLayout(act).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(8), dp(20), dp(28)) }
            body.addView(text("Kauf mir eine Spezi", 20f, bold = true).apply { setPadding(0, dp(8), 0, dp(12)) })
            body.addView(text("Letzte Runde ist kostenlos.", 16f, bold = true))
            body.addView(text("Ohne Werbung, ohne Tracking, ohne Abo.", 15f))
            body.addView(text("Ich baue das Spiel in meiner Freizeit. Wenn es euch gefällt: Spendier mir eine Spezi (oder eine Runde). " +
                "Es schaltet nichts frei, aber es macht mir eine Freude.", 15f).apply { alpha = 0.7f; setPadding(0, dp(8), 0, dp(12)) })
            body.addView(list)
            body.addView(status)
            dialog.setContentView(body)
            dialog.setOnDismissListener { if (sheet === this) sheet = null }
            dialog.show()
        }

        fun loading() {
            list.removeAllViews()
            list.addView(ProgressBar(act), LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.CENTER_HORIZONTAL })
            status.visibility = View.GONE
        }

        fun unavailable() {
            list.removeAllViews()
            list.addView(text("Die Optionen konnten gerade nicht von Google Play geladen werden.", 15f).apply { alpha = 0.7f })
            list.addView(text("↻  Erneut versuchen", 16f).apply {
                setTextColor(Color.parseColor("#2E7D4F")); setPadding(0, dp(12), 0, dp(12)); isClickable = true
                setOnClickListener { connect(act) }
            })
        }

        fun products(ps: List<ProductDetails>) {
            list.removeAllViews()
            ps.forEach { p ->
                list.addView(LinearLayout(act).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(12), 0, dp(12)); isClickable = true
                    val tv = android.util.TypedValue(); act.theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true); setBackgroundResource(tv.resourceId)
                    addView(Icon(act, p.productId.substringAfterLast('.')), LinearLayout.LayoutParams(dp(44), dp(34)).apply { marginEnd = dp(14) })
                    addView(LinearLayout(act).apply {
                        orientation = LinearLayout.VERTICAL
                        addView(text(p.name, 16f))
                        if (p.description.isNotEmpty()) addView(text(p.description.replace(";)", "😉"), 13f).apply { alpha = 0.7f })   // Play erlaubt keine Emojis
                    }, LinearLayout.LayoutParams(0, -2, 1f))
                    addView(text(p.oneTimePurchaseOfferDetails?.formattedPrice ?: "", 16f, bold = true))
                    setOnClickListener { buy(act, p) }
                })
            }
        }

        fun error(msg: String) {
            status.text = msg.ifEmpty { "Der Kauf hat nicht geklappt." }
            status.setTextColor(Color.parseColor("#C0392B")); status.alpha = 1f; status.visibility = View.VISIBLE
        }

        fun thanks() {
            status.text = "♥  Danke! Das bedeutet mir viel."
            status.setTextColor(Color.parseColor("#D6336C")); status.alpha = 1f; status.visibility = View.VISIBLE
        }

        private fun dp(v: Int) = (v * act.resources.displayMetrics.density).toInt()
        private fun text(t: String, size: Float, bold: Boolean = false) = TextView(act).apply {
            text = t; textSize = size; if (bold) setTypeface(typeface, Typeface.BOLD)
        }
    }

    /** Flasche, drei Flaschen (Tagesration) oder Kasten – selbst gezeichnet, ohne Logo, wie SpeziBottle/SpeziCrate bei iOS */
    private class Icon(ctx: Context, val kind: String) : View(ctx) {
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)
        private val brown = Color.rgb(89, 41, 18); private val cap = Color.rgb(201, 163, 38)
        private val orange = Color.rgb(242, 156, 31); private val blue = Color.rgb(59, 125, 217); private val handle = Color.rgb(184, 110, 15)

        override fun onDraw(c: Canvas) {
            when (kind) {
                "small" -> bottle(c, (width - h(14f)) / 2f, 0f, h(14f) / 16f, height / 40f)
                "medium" -> { val w = h(12f); val s = h(29f) / 40f; val x0 = (width - 3 * w - 2) / 2f
                    for (i in 0..2) bottle(c, x0 + i * (w + 1), (height - h(29f)) / 2f, w / 16f, s) }
                else -> crate(c, width / 48f, height / 40f)
            }
        }
        private fun h(v: Float) = v * height / 34f
        private fun rect(c: Canvas, ox: Float, oy: Float, sx: Float, sy: Float, x: Float, y: Float, w: Float, hh: Float, r: Float, col: Int) {
            p.color = col; c.drawRoundRect(RectF(ox + x * sx, oy + y * sy, ox + (x + w) * sx, oy + (y + hh) * sy), r * sx, r * sx, p)
        }
        private fun bottle(c: Canvas, ox: Float, oy: Float, sx: Float, sy: Float) {
            rect(c, ox, oy, sx, sy, 5.5f, 0.5f, 5f, 3f, 1f, cap)
            val b = Path().apply {
                moveTo(ox + 6 * sx, oy + 3.5f * sy); lineTo(ox + 10 * sx, oy + 3.5f * sy); lineTo(ox + 10 * sx, oy + 9.5f * sy)
                quadTo(ox + 14 * sx, oy + 12 * sy, ox + 14 * sx, oy + 17 * sy); lineTo(ox + 14 * sx, oy + 37 * sy)
                quadTo(ox + 14 * sx, oy + 39.5f * sy, ox + 11.5f * sx, oy + 39.5f * sy); lineTo(ox + 4.5f * sx, oy + 39.5f * sy)
                quadTo(ox + 2 * sx, oy + 39.5f * sy, ox + 2 * sx, oy + 37 * sy); lineTo(ox + 2 * sx, oy + 17 * sy)
                quadTo(ox + 2 * sx, oy + 12 * sy, ox + 6 * sx, oy + 9.5f * sy); close()
            }
            p.color = brown; c.drawPath(b, p)
            rect(c, ox, oy, sx, sy, 2f, 20f, 12f, 10f, 0f, orange)
            rect(c, ox, oy, sx, sy, 2f, 23.5f, 12f, 3f, 0f, blue)
        }
        private fun crate(c: Canvas, sx: Float, sy: Float) {
            for (x in listOf(4f, 13f, 22f, 31f, 40f)) { rect(c, 0f, 0f, sx, sy, x, 2f, 4f, 12f, 1f, brown); rect(c, 0f, 0f, sx, sy, x, 1f, 4f, 2.5f, 1f, cap) }
            rect(c, 0f, 0f, sx, sy, 1f, 12f, 46f, 27f, 3f, orange)
            rect(c, 0f, 0f, sx, sy, 1f, 21f, 46f, 6f, 0f, blue)
            rect(c, 0f, 0f, sx, sy, 17f, 15f, 14f, 4f, 2f, handle)
        }
    }
}
