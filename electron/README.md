# IO Doc Scanner — desktop (Windows/macOS)

Electron shell wrapping the same shared `web/` UI as the Android and iOS apps (see the root `README.md`). Business-card and accounts-document scanning both work here; the differences from the phone apps are:

- **No camera capture.** Only "choose an existing picture" — pick a photo/scan of a card, or a PDF, from disk. There's no live camera flow on desktop.
- **No on-device OCR for cards.** Android/iOS run OCR natively; desktop has none, so a picked card photo is sent to Claude (the same Anthropic key configured for document field extraction, in Settings) to read its fields directly. If no key is set, or the request fails, the picture is still saved and attached — just fill in the fields by hand. Document scanning (PDFs) is unaffected by this: it always reads the PDF's text on-device with pdf.js first, same as the other shells.
- Everything else — Settings, ERPNext sync, Excel export, the Documents review/approve screen, duplicate-supplier detection/merge — is the same shared code, unmodified.

## Layout

- `app/main.js` — Electron main process: creates the window, and runs a small HTTP bridge + native file-picker dialogs (see below).
- `app/preload.js` — the "native bridge" (`window.Android`) that `erp.js`/`net.js`/`app.js` already expect from Android/iOS — implemented here with Node's `fs` and Electron's `dialog`/`shell` instead of Java/Swift. This is what lets the shared web code run completely unmodified (aside from two small, backward-compatible additions noted in `preload.js`'s header comment).
- `app/web/` — the shared UI, copied in by `sync-web-assets.sh`. **Don't hand-edit files here** — edit `android/CardScanner/app/src/main/assets/` (the source of truth) and re-run the sync script.
- `package.json` — Electron + electron-builder config, targeting a `.dmg`/`.zip` for macOS (arm64 + x64) and an NSIS installer + portable `.exe` for Windows (x64).

## Why a real HTTP bridge instead of `fetch()` in the page

ERPNext and Anthropic API calls are made from `main.js` (a plain Node process), not from the page itself, and relayed back over IPC. A `fetch()` from the loaded `file://` page would be subject to the browser's CORS policy, same as it would be in any browser — the native Android/iOS apps sidestep this the same way, with a real native HTTP client instead of the WebView's own networking. This means the desktop app needs no `webSecurity: false` workaround and no CORS proxy.

## Building and running

```sh
cd electron
./sync-web-assets.sh   # pull in the latest shared web/ UI
npm install
npm start               # run it locally
npm run dist:mac        # build a signed... well, an UNSIGNED .dmg/.zip for macOS
npm run dist:win        # build an unsigned NSIS installer + portable .exe for Windows
```

**Builds are unsigned.** macOS Gatekeeper will show an "unidentified developer" warning, and Windows SmartScreen will warn on first run — expected for now. Distributing this more broadly will need an Apple Developer ID (for `notarize`/code signing) and a Windows code-signing certificate; neither is set up yet.

## Where things are stored

- Settings and the local card queue: `~/Library/Application Support/IO Doc Scanner/` (macOS) or `%APPDATA%\IO Doc Scanner\` (Windows) — plain JSON files, same shape as the phone apps use.
- Card photos: a `card-images` subfolder of the above.
- Exported Excel files: `~/Documents/CardScanner/` — "Share" reveals the file in Finder/Explorer instead of opening a share sheet (desktop has no equivalent).
