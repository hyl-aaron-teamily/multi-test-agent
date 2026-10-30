#!/usr/bin/env sh
# Fetch the two Android SDK pieces build.sh needs (no sdkmanager, no Android Studio) into tools/android-sdk:
#   platforms/android-34/android.jar   and   build-tools/<rev>/ (aapt2, zipalign, lib/d8.jar, lib/apksigner.jar)
#   sh android/a11y-service/fetch-sdk.sh
# Source: Google's SDK repository (https://dl.google.com/android/repository/). ~110 MB download.
set -e
cd "$(dirname "$0")/../.." || exit 1
REPO=https://dl.google.com/android/repository
SDK=tools/android-sdk
DL=$SDK/_dl
mkdir -p "$DL"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) OS=windows ;; Darwin) OS=macosx ;; *) OS=linux ;; esac
curl -fsSL -o "$DL/repo.xml" "$REPO/repository2-3.xml"
PLAT=$(grep -o 'platform-34[^<"]*\.zip' "$DL/repo.xml" | sort -u | tail -1)
BT=$(grep -o "build-tools_r34[^<\"]*${OS}[^<\"]*\.zip" "$DL/repo.xml" | sort -u | tail -1)
[ -n "$PLAT" ] && [ -n "$BT" ] || { echo "could not find platform-34 / build-tools 34 ($OS) in the repository manifest"; exit 2; }
echo "[sdk] $PLAT, $BT"
for f in "$PLAT" "$BT"; do
  # The manifest lists <checksum type="sha1"> just before each <url>.
  want=$(grep -B4 "<url>$f</url>" "$DL/repo.xml" | grep -o 'sha1">[0-9a-f]*' | head -1 | cut -d'>' -f2)
  if [ ! -f "$DL/$f" ]; then curl -fL -o "$DL/$f.part" "$REPO/$f" && mv "$DL/$f.part" "$DL/$f"; fi
  got=$(sha1sum "$DL/$f" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$got" = "$want" ] || { echo "[sdk] checksum mismatch for $f (want ${want:-?}, got $got) — deleted"; rm -f "$DL/$f"; exit 3; }
done
unpack() { # zip, destination: the zip holds one top directory
  rm -rf "$DL/x" && mkdir -p "$DL/x" && (cd "$DL/x" && jar xf "../$(basename "$1")")
  top=$(ls "$DL/x" | head -1)
  rm -rf "$2" && mkdir -p "$(dirname "$2")" && mv "$DL/x/$top" "$2"
}
unpack "$DL/$PLAT" "$SDK/platforms/android-34"
unpack "$DL/$BT" "$SDK/build-tools/34.0.0"
chmod +x "$SDK/build-tools/34.0.0/"* 2>/dev/null || true
ls "$SDK/platforms/android-34/android.jar" "$SDK/build-tools/34.0.0/lib/d8.jar"
echo "[sdk] ready — next: sh android/a11y-service/build.sh"
