# JS-Brücke der WebView
-keepclassmembers class de.sgitaize.letzterunde.WebBridge { @android.webkit.JavascriptInterface <methods>; }
# JNI
-keepclasseswithmembernames class * { native <methods>; }
