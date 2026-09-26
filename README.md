# IO Doc Scanner (CardScanner)

Offline business card scanner for Android and iOS that exports ERPNext-ready Excel files (Contacts, Addresses, and a plain backup sheet). No server, no account required — OCR and parsing run entirely on-device; an optional AI cleanup step only sends text off-device if you supply your own OpenAI-compatible or Anthropic API key in Settings.

Also scans accounts documents — purchase/proforma/sales invoices, customs declarations, customs-declaration invoices, and shipping invoices — reads a scanned PDF's text, asks Claude to pull out the key fields (with an editable review step first), flags a likely-duplicate Supplier before creating a new one, auto-suggests the right parent purchase record for the three later document sections, and files the record plus its PDF against ERPNext's "Accounts Document" doctype. See `docs/io-doc-scanner-expansion.md`-style notes in the project write-up for the full design.

## Layout

- `android/CardScanner/` — Android app (Gradle project, WebView shell + Google ML Kit OCR). See `android/CardScanner/README.md` for how it works and `INSTALL.md` for build/signing steps.
- `ios/CardScanner/` — iOS app (Xcode project, WKWebView shell + VisionKit/Vision OCR bridge). See `ios/CardScanner/BUILD-IOS.md`.
- `docs/` — install guides (PDF) and UI reference screenshots.

## Shared web UI

Both native shells embed the same HTML/CSS/JS parsing and export layer (field parsing, ERPNext export, optional AI cleanup). The Android copy under `android/CardScanner/app/src/main/assets/` is the source of truth; `ios/CardScanner/sync-web-assets.sh` copies it into the iOS bundle at `ios/CardScanner/CardScanner/web/`. Run that script after changing the shared web UI so both platforms stay in sync.

## Notes

- `android/CardScanner/app/src/main/assets/pdf.min.js` and `pdf.worker.min.js` are the vendored pdf.js 2.16.105 "legacy" build (Mozilla, MPL-2.0, unmodified) — used to turn a scanned PDF into text on-device before it's sent for field extraction. Kept in the shared web assets (not reimplemented per-platform) so Android, iOS and the future Electron desktop shell all parse PDFs the same way; the desktop shell in particular needs no native code for this at all, since a plain `<input type="file">` (already wired as the browser/Electron fallback for `Android.pickDocument()`) covers picking the file.

- The signed release APK (`CardScanner-1.3.apk`) is not committed here — it's easy to rebuild from `android/` and better distributed as a GitHub Release asset than tracked in git history. Ask if you'd like it attached as a release.
- `android/CardScanner/app/build.gradle` references a release keystore at `../keystore/cardscanner.jks` (not included) signed with a placeholder store/key password (`cardscanner`). Replace both the keystore and that password before distributing the app more widely.
