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
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "de.sgitaize.letzterunde"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
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

// Spiel und Server aus app/ ins APK (assets/game) – wie Scripts/bundle-game.sh bei iOS
val bundleGame by tasks.registering(Sync::class) {
    from("../../../app") {
        include("server.js", "bots.js", "accounts.js", "moderation.js", "app-host.js", "selfsigned.js", "package.json")
        include("public/**")
        exclude("public/sw.js", "public/admin.html")
    }
    into("src/main/assets/game")
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
}
