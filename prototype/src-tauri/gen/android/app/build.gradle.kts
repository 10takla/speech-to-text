import java.util.Properties
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// The watcher supplies TAURI_CONFIG; standalone APKs keep using bundled assets.
val devServerUrl = providers.environmentVariable("TAURI_CONFIG").orNull?.let {
    val config = JsonSlurper().parseText(it) as Map<*, *>
    (config["build"] as? Map<*, *>)?.get("devUrl") as? String
} ?: ""

android {
    compileSdk = 36
    namespace = "com.speechtotext.app"
    testNamespace = "com.speechtotext.app.test"
    defaultConfig {
        // Local Piper servers use HTTP, including user-configured LAN addresses.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.speechtotext.app"
        minSdk = 24
        targetSdk = 35
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        buildConfigField("String", "STT_DEV_SERVER_URL", "\"\"")
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            buildConfigField("String", "STT_DEV_SERVER_URL", JsonOutput.toJson(devServerUrl))
        }
        getByName("release") {
            // Local release APKs use the existing development key for device installation.
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
    sourceSets["main"].java.srcDir("../../../android/src/main/java")
    sourceSets["main"].jniLibs.setSrcDirs(emptyList<String>())
    sourceSets["debug"].jniLibs.srcDir("src/main/jniLibs")
    sourceSets["debug"].assets.srcDir("../../../../dist")
    sourceSets["release"].assets.srcDir("../../../../dist-android-release")
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
