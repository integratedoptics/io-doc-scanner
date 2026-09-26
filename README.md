# IO Doc Scanner (CardScanner)

Offline business card scanner for Android and iOS that exports ERPNext-ready Excel files (Contacts, Addresses, and a plain backup sheet). No server, no account required — OCR and parsing run entirely on-device; an optional AI cleanup step only sends text off-device if you supply your own OpenAI-compatible or Anthropic API key in Settings.

## Layout

- `android/CardScanner/` — Android app (Gradle project, WebView shell + Google ML Kit OCR). See `android/CardScanner/README.md` for how it works and `INSTALL.md` for build/signing steps.
- `ios/CardScanner/` — iOS app (Xcode project, WKWebView shell + VisionKit/Vision OCR bridge). See `ios/CardScanner/BUILD-IOS.md`.
- `docs/` — install guides (PDF) and UI reference screenshots.

## Shared web UI

Both native shells embed the same HTML/CSS/JS parsing and export layer (field parsing, ERPNext export, optional AI cleanup). The Android copy under `android/CardScanner/app/src/main/assets/` is the source of truth; `ios/CardScanner/sync-web-assets.sh` copies it into the iOS bundle at `ios/CardScanner/CardScanner/web/`. Run that script after changing the shared web UI so both platforms stay in sync.

## Notes

- The signed release APK (`CardScanner-1.3.apk`) is not committed here — it's easy to rebuild from `android/` and better distributed as a GitHub Release asset than tracked in git history. Ask if you'd like it attached as a release.
- `android/CardScanner/app/build.gradle` references a release keystore at `../keystore/cardscanner.jks` (not included) signed with a placeholder store/key password (`cardscanner`). Replace both the keystore and that password before distributing the app more widely.
