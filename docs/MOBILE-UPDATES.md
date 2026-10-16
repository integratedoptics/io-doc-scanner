# Updates of the phone apps (Android and iOS)

The Windows and macOS apps update themselves with electron-updater (see `electron/README.md`). The phone apps use a much smaller mechanism, built into the shared web layer (`updates.js`), that reads one file from the same internal update server.

## What the user sees

* The app looks for a newer version a few seconds after it starts, whenever it comes back to the front after 30 minutes or more, and every 30 minutes while it is open. **Settings → App updates → Check for updates** does it on demand and shows the result.
* **Android:** an orange bar appears at the top: "Update 1.5 is available" with **Install** and **Later**. Install downloads the file (with a percentage), checks it, and opens Android's own installer, where the user taps *Install* once more — Android never lets an app replace itself silently. The first time, Android first sends the user to the switch "Allow from this source" for Card Scanner; after switching it on, the user goes back and taps Install again. **Later** hides the bar for that version (a newer version, or *Check for updates*, shows it again).
* **iOS:** the same bar, text only ("Update 1.5 is available. …your message…"). An iPhone app can only be replaced through Xcode, TestFlight or the App Store, so the app can tell but not install.
* Windows, macOS and a plain browser: nothing (the card is hidden).

## The server

Same folder as the desktop updates, `\\192.168.1.79\docker\electron-update-server\updates\io-doc-scanner\` = `http://192.168.1.79:3005/updates/io-doc-scanner/` (the server itself is not changed). Two kinds of file are added there:

* the Android `.apk`, e.g. `io-doc-scanner-1.5.apk`
* `mobile.json`, which says what the newest version is:

```json
{
  "android": { "version": "1.5", "url": "io-doc-scanner-1.5.apk", "sha256": "<checksum of that apk>" },
  "ios":     { "version": "1.5", "message": "Install build 1.5 from Xcode." }
}
```

`url` is relative to the folder of `mobile.json` (or a full address). `sha256` is checked by the app before it installs; `message` is optional. Do not write the file by hand — `tools/make-mobile-manifest.js` computes the checksum and keeps the other platform's entry:

```
node tools/make-mobile-manifest.js --out mobile.json --android app-release.apk --android-version 1.5
node tools/make-mobile-manifest.js --out mobile.json --ios-version 1.5 --ios-message "Install build 1.5 from Xcode."
```

The address the apps use is in **Settings → App updates → Update server address** (empty = the address above). It may also point straight at a `mobile.json`. Plain `http://` is accepted only for local addresses (192.168.x.x, 10.x.x.x, 172.16–31.x.x, localhost, `*.local`); anything else must be `https://`.

## Releasing a new Android version

1. In `android/CardScanner/app/build.gradle` raise `versionCode` (a whole number, must go up every time) and `versionName` (e.g. `"1.5"`). The app reports `versionName` as its version — nothing else has to be changed by hand.
2. Build the **release** apk in Android Studio (Build → Generate Signed App Bundle / APK → APK) **with the same keystore as the version installed on the phones**. Android refuses to update an app with a file signed by another key (the error is "App not installed"). The 1.3 key was lost, so 1.3 has to be uninstalled once; from 1.4 on, keep the keystore and its password safe — without it no phone can be updated again, only reinstalled. Debug builds are signed with a key that is specific to the computer that built them, so do not mix debug builds from different computers either.
3. `node tools/make-mobile-manifest.js --out mobile.json --android <the apk> --android-version <versionName>`
4. Copy the `.apk` to the server folder first, **`mobile.json` last**, so no phone is told about a file that is not there yet.

Check: `http://192.168.1.79:3005/updates/io-doc-scanner/mobile.json` opens in a browser, and so does the `.apk` address in it. On a phone with the older version: Settings → App updates → Check for updates.

The first version that contains this mechanism is 1.4, so phones with 1.3 or older need one manual installation of 1.4; after that they update from the app.

## Releasing a new iOS version

Raise `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in Xcode (the app reads its version from them), install the build on the iPhones as before, and write the notice: `node tools/make-mobile-manifest.js --out mobile.json --ios-version 1.5 --ios-message "…"`, then copy `mobile.json` to the server. iPhones with an older build then show the bar until they are updated.

## Safety

* A file downloaded by the app is installed only if (when `sha256` is given) its checksum matches, it is a valid apk, and it belongs to this very app (`lt.elmo.cardscanner`). Android additionally refuses an apk that is not signed with the installed app's key, so a wrong file on the server cannot replace the app.
* The server is on the local network over plain http; nothing secret is sent to it (the app only fetches two public files).

## Where the code is

`android/.../assets/updates.js` (check, banner, Settings card; the same file is copied to the iOS and desktop apps by the sync scripts), `MainActivity.java` (`installUpdate`, `platform`, `appVersion`), `AndroidManifest.xml` (`REQUEST_INSTALL_PACKAGES`), `ios/.../ios-bridge.js` (`platform()` = `"ios"`), tests `tests/test_updates.js` and `tests/test_updates_page.js`.
