# IO Doc Scanner — desktop (Windows/macOS) — version 1.8.0

Electron shell wrapping the same shared `web/` UI as the Android and iOS apps (see the root `README.md`). Business-card and accounts-document scanning both work here; the differences from the phone apps are:

- **Webcam capture (1.4).** *Take a photo* opens the computer's camera in an overlay — for business cards and for documents. Pictures and PDFs can also be chosen from disk. On macOS the first use shows the system camera prompt; if it was refused, switch it on under System Settings → Privacy & Security → Camera (when started with `npm start` the app is listed as "Electron"). The page may request nothing but the camera. For a future signed/notarized Mac build add the `com.apple.security.device.camera` entitlement.
- **No on-device OCR for cards.** Android/iOS run OCR natively; desktop has none, so a picked card photo is sent to Claude (the same Anthropic key configured for document field extraction, in Settings) to read its fields directly. If no key is set, or the request fails, the picture is still saved and attached — just fill in the fields by hand. Document scanning always reads a PDF's text on-device with pdf.js first and fills the form with the built-in English/Lithuanian/German reader (`docrules.js`); Claude is only asked as well when a key is set, and receives the file itself for scans and photos.
- Everything else — Settings, ERPNext sync, Excel export, the Documents review/approve screen, duplicate-supplier detection/merge — is the same shared code, unmodified.

## Wide layout, collapsible menu and the Review box (1.5.0 / 1.6.0)

The shared UI adds the class `desktop` to `<html>` when the shell reports `Android.platform() === "desktop"` (see `app/preload.js`); every wide-screen rule lives in `app/web/desktop.css` (source: `android/.../assets/desktop.css`) and is scoped to `html.desktop`, so the phone apps and a browser are untouched. The window opens up to 1440 × 920 (minimum 1000 × 640). The Documents screen shows the attached document large in its own pane (`docview.js`, PDF pages drawn by pdf.js) next to the form, which has a Review box (`review.js`): one tick per key value, a status, the reviewer's name and a note, written into the ERPNext remarks and the upload history. From 1.6.0 an arrow at the top of the left menu folds it to icons (`html.navcol`, setting `nav_collapsed`), the viewer can be dragged with the left mouse button (`docview.js`) and the tracking / AWB field has its own *Shipment tracking* box (`newui.js` moves it there on the desktop only). Tests: `tests/test_review.js`, `tests/test_review_send.js`, `tests/test_desktop_v16.js`.

## Sales invoices to XRechnung (1.8.0)

The Export screen has a card that turns ERPNext Sales Invoices of the series IOG into XRechnung 3.0 (UBL) files for German authorities. It is shared web code (`web/xrechnung.js`, the same on all four apps) and runs entirely in the page against the ERPNext settings; the file goes through the normal `saveToDocuments` bridge. See `docs/XRECHNUNG.md`. Tests: `tests/test_xrechnung.js` (with an optional offline validator) and `tests/test_xrechnung_ui.js`.

## Zoho Mail attachments (1.7.0)

`app/zoho.js` (main process) reads the user's Zoho Mail inbox through the Zoho Mail REST API with a read-only "Self Client" token and lists mails that carry PDF/picture attachments; `app/mailsafety.js` is the scam filter (file names, file contents, sender checks); `preload.js` exposes both to the page as `window.CS_ZOHO`; the panel and the Settings card are `web/zohomail.js`. Credentials never reach the page. See `docs/ZOHO-MAIL.md`. Tests: `test/mailsafety.test.js`, `test/zoho.test.js` (mock Zoho server), and `tests/test_zohomail_ui.js` in the repo root.

## Layout

- `app/main.js` — Electron main process: creates the window, and runs a small HTTP bridge + native file-picker dialogs (see below).
- `app/preload.js` — the "native bridge" (`window.Android`) that `erp.js`/`net.js`/`app.js` already expect from Android/iOS — implemented here with Node's `fs` and Electron's `dialog`/`shell` instead of Java/Swift. This is what lets the shared web code run completely unmodified (aside from two small, backward-compatible additions noted in `preload.js`'s header comment).
- `app/web/` — the shared UI, copied in by `sync-web-assets.sh`. **Don't hand-edit files here** — edit `android/CardScanner/app/src/main/assets/` (the source of truth) and re-run the sync script.
- `build/icon.png`, `build/icon-mac.png` (and copies in `app/`) — the iO mark used for the taskbar/Dock/installer icons; the same artwork as the iOS app icon.
- `package.json` — Electron + electron-builder config, targeting a `.dmg`/`.zip` for macOS (arm64 + x64) and an NSIS installer for Windows (x64) — the only Windows target that can auto-update (`npm run dist:win:zip` still makes a plain zip).

## Why a real HTTP bridge instead of `fetch()` in the page

ERPNext and Anthropic API calls are made from `main.js` (a plain Node process), not from the page itself, and relayed back over IPC. A `fetch()` from the loaded `file://` page would be subject to the browser's CORS policy, same as it would be in any browser — the native Android/iOS apps sidestep this the same way, with a real native HTTP client instead of the WebView's own networking. This means the desktop app needs no `webSecurity: false` workaround and no CORS proxy.

## Building and running

```sh
cd electron
./sync-web-assets.sh   # pull in the latest shared web/ UI
npm install
npm start               # run it locally
npm run dist:mac        # build a signed... well, an UNSIGNED .dmg/.zip for macOS
npm run dist:win        # build the unsigned NSIS installer for Windows (needs Windows or Wine)
npm run dist:win:zip    # only the Windows ZIP (unzip and run, no install; does not auto-update)
npm test                # unit tests: updater, Zoho client (mock server), scam filter
```

Step-by-step instructions for installing on Windows PCs: [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md).

**Builds are unsigned.** macOS Gatekeeper will show an "unidentified developer" warning, and Windows SmartScreen will warn on first run — expected for now. Distributing this more broadly will need an Apple Developer ID (for `notarize`/code signing) and a Windows code-signing certificate; neither is set up yet.

## Automatic updates (Windows installer and macOS)

The installed app checks the internal update server (`build.publish` in `package.json`: `http://192.168.1.79:3005/updates/io-doc-scanner/`) once after it starts and then every 30 minutes, and downloads a newer version in the background. When it is ready a dialog says **"Update <version> has been downloaded"** with **Restart now** (installs and restarts) and **Later** (the update is installed when the app is closed; the dialog is not shown again for the same version). An unreachable server is only written to the log (Windows `%APPDATA%\IO Doc Scanner\logs\main.log`, macOS `~/Library/Application Support/IO Doc Scanner/logs/main.log`); the user sees no error. Nothing is checked in `npm start`, the Windows portable build / zip, or on Linux. Code: `app/updater.js`, test: `test/updater.test.js`.

**Windows** updates only the *installed* (NSIS) build. **macOS** updates the app from the `.zip` build. macOS installs an update by itself only into a *signed* app; the Mac builds are unsigned, so when the download/install fails the app shows **"Update <version> is available"** with **Download** (opens the right zip for that Mac — Apple silicon or Intel — in the browser; unzip it and replace the app in Applications) and **Later**, once per version.

**Releasing a new version**

1. Raise `version` in `package.json` (the app only updates to a higher number; the phone apps have their own version, see `docs/MOBILE-UPDATES.md`).
2. Windows: `npm run dist` on a Windows PC. It makes `dist\IO Doc Scanner Setup <version>.exe`, the `.blockmap` next to it and `dist\latest.yml` (generated — never write it by hand).
   macOS: `npm run dist:mac` (on a Mac, or anywhere electron-builder can build the zips). It makes `IO Doc Scanner-<version>-mac.zip`, `IO Doc Scanner-<version>-arm64-mac.zip`, their `.blockmap` files and `latest-mac.yml`.
3. Copy the `.exe` / `.zip` files and their `.blockmap` files to `\\192.168.1.79\docker\electron-update-server\updates\io-doc-scanner\`.
4. Copy `latest.yml` and `latest-mac.yml` **last**, so no client sees a version whose files are not there yet.

Check: `http://192.168.1.79:3005/updates/io-doc-scanner/latest.yml` (and `latest-mac.yml`) opens in a browser and its `url:` file names are the files you copied. To try it end to end, install an older version, upload a newer one as above, start the old app and wait for the dialog (first check right after start-up).

## Where things are stored

- Settings and the local card queue: `~/Library/Application Support/IO Doc Scanner/` (macOS) or `%APPDATA%\IO Doc Scanner\` (Windows) — plain JSON files, same shape as the phone apps use.
- Card photos: a `card-images` subfolder of the above.
- Exported Excel files: `~/Documents/CardScanner/` — "Share" reveals the file in Finder/Explorer instead of opening a share sheet (desktop has no equivalent).
