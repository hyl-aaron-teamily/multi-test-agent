#!/usr/bin/env sh
# Build the read-only tree service APK without Gradle: aapt2 → javac → d8 → zipalign → apksigner.
#   sh android/a11y-service/build.sh            → tools/a11y/autotest-a11y.apk
# Needs a JDK (javac, keytool, jar) and an Android SDK at $ANDROID_SDK (default tools/android-sdk) holding
# platforms/android-<N>/android.jar and build-tools/<v>/ (aapt2, zipalign, lib/d8.jar, lib/apksigner.jar).
# The signing key is a local debug key (tools/a11y/debug.keystore, made on first build).
set -e
cd "$(dirname "$0")/../.." || exit 1
SRC=android/a11y-service
SDK=${ANDROID_SDK:-tools/android-sdk}
OUT=tools/a11y
B=$OUT/build
PLATFORM=$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1)
BT=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)
[ -f "$PLATFORM/android.jar" ] || { echo "no android.jar under $SDK/platforms (see docs/w2m4-acceptance.md: SDK setup)"; exit 2; }
[ -d "$BT" ] || { echo "no build-tools under $SDK/build-tools"; exit 2; }
EXE=; [ -f "$BT/aapt2.exe" ] && EXE=.exe
# JDK tools: from JAVA_HOME when set (Windows often has only the java/javac shims on PATH).
JBIN=${JAVA_HOME:+$JAVA_HOME/bin/}
echo "[a11y] platform $(basename "$PLATFORM"), build-tools $(basename "$BT")"
rm -rf "$B" && mkdir -p "$B/classes" "$B/dex" "$OUT"

"$BT/aapt2$EXE" compile --dir "$SRC/res" -o "$B/res.zip"
"$BT/aapt2$EXE" link -o "$B/unsigned.apk" -I "$PLATFORM/android.jar" --manifest "$SRC/AndroidManifest.xml" "$B/res.zip"

"${JBIN}javac" -nowarn --release 11 -classpath "$PLATFORM/android.jar" -d "$B/classes" $(find "$SRC/src" -name '*.java')
"${JBIN}java" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 26 --lib "$PLATFORM/android.jar" --output "$B/dex" $(find "$B/classes" -name '*.class')
(cd "$B/dex" && "${JBIN}jar" uf ../unsigned.apk classes.dex)

"$BT/zipalign$EXE" -p -f 4 "$B/unsigned.apk" "$B/aligned.apk"
KS=$OUT/debug.keystore
[ -f "$KS" ] || "${JBIN}keytool" -genkeypair -keystore "$KS" -storepass android -keypass android -alias autotest -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=autotest a11y debug" >/dev/null 2>&1
"${JBIN}java" -jar "$BT/lib/apksigner.jar" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out "$OUT/autotest-a11y.apk" "$B/aligned.apk"
"${JBIN}java" -jar "$BT/lib/apksigner.jar" verify "$OUT/autotest-a11y.apk"
echo "[a11y] built $OUT/autotest-a11y.apk ($(wc -c < "$OUT/autotest-a11y.apk") bytes)"
