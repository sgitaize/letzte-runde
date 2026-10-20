import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signatur für die Download-APK: signing.properties (nicht im Repo) mit storeFile, storePassword, keyAlias, keyPassword
val signing = Properties().apply {
    val f = rootProject.file("signing.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "de.sgitaize.letzterunde"
    compileSdk = 36
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "de.sgitaize.letzterunde"
        minSdk = 26
        targetSdk = 36
        versionCode = 7
        versionName = "1.1.1"
        externalNativeBuild { cmake { arguments += listOf("-DANDROID_STL=c++_shared") } }
    }

    signingConfigs {
        if (signing.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(signing.getProperty("storeFile"))
                storePassword = signing.getProperty("storePassword")
                keyAlias = signing.getProperty("keyAlias")
                keyPassword = signing.getProperty("keyPassword")
            }
        }
    }

    // Zwei Vertriebswege (wie bookshelv): „github“ = Download-APK aus den GitHub-Releases (Hinweis auf neue APK, Spendenlink),
    // „play“ = Google Play (Updates nur über den Store, Spezi per Play Billing statt externem Spendenlink – Play-Richtlinien)
    flavorDimensions += "store"
    productFlavors {
        create("github") {
            dimension = "store"
            buildConfigField("String", "STORE", "\"github\"")
        }
        create("play") {
            dimension = "store"
            buildConfigField("String", "STORE", "\"play\"")
            // Play liefert aus dem App Bundle je Gerät nur die passende Architektur → auch 32-Bit-ARM und x86_64
            ndk { abiFilters += listOf("armeabi-v7a", "x86_64") }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
            // Download-APK: nur 64-Bit-ARM (alle Geräte der letzten Jahre); libnode ist ~40 MB je Architektur
            ndk { abiFilters += listOf("arm64-v8a") }
        }
        debug {
            ndk { abiFilters += listOf("arm64-v8a", "x86_64") }   // x86_64 für den Emulator
        }
    }

    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    sourceSets["main"].jniLibs.srcDirs("libnode/bin")
    packaging { jniLibs { useLegacyPackaging = true } }   // libnode.so entpackt (schnellerer Start)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

// Spiel und Server aus app/ ins APK (assets/game) – wie Scripts/bundle-game.sh bei iOS. game/bundle.json stempelt den Build
// (Unix-Sekunden): vom Server nachgeladene Spiel-Bundles zählen nur, wenn sie neuer sind (app-host.js „Spiel-Bundle“).
val bundleGame by tasks.registering(Sync::class) {
    from("../../../app") {
        include("server.js", "bots.js", "accounts.js", "moderation.js", "resolve.js", "bundle-manifest.js", "app-host.js", "selfsigned.js",
            "package.json", "bundle-key.pub")
        include("public/**")
        exclude("public/sw.js", "public/admin.html")
    }
    into("src/main/assets/game")
    doLast {
        file("src/main/assets/game/bundle.json").writeText("{\"build\":${System.currentTimeMillis() / 1000}}")
        if (!file("../../../app/bundle-key.pub").exists()) logger.warn("app/bundle-key.pub fehlt – die App kann keine Spiel-Updates laden (node app/scripts/bundle.js keygen)")
    }
}
tasks.named("preBuild") { dependsOn(bundleGame) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")   // QR scannen + erzeugen, ohne Google Play
    "playImplementation"("com.android.billingclient:billing-ktx:8.3.0")   // „Kauf mir eine Spezi“ nur in der Play-Fassung
}
