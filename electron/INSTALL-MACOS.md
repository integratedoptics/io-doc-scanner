# IO Doc Scanner 1.6 — macOS

Two ZIPs, pick the one for your Mac:

- `IO Doc Scanner-1.8.0-arm64-mac.zip` — Apple Silicon (M1/M2/M3/M4/M5)
- `IO Doc Scanner-1.8.0-mac.zip` — Intel Macs

1. Double-click the ZIP; it unpacks `IO Doc Scanner.app`. Drag it to Applications.
2. The app is **not signed or notarized**, so macOS blocks the first start. Either right-click the app → **Open** → **Open**, or in Terminal run:
   `xattr -dr com.apple.quarantine "/Applications/IO Doc Scanner.app"`
3. First use of the camera shows the system prompt (System Settings → Privacy & Security → Camera if refused).
4. In the app: Settings → ERPNext connection, and the Anthropic key under "Document field extraction". Leave "Workspace ID" empty unless the key is not scoped to a workspace and Anthropic asks for one.

## Updates

The app asks the internal update server (`http://192.168.1.79:3005/updates/io-doc-scanner/`) for a newer version when it starts and every 30 minutes. macOS only lets an app replace itself when the app is **signed**; this build is not, so in practice you will see **"Update <version> is available"** with **Download** — it opens the right ZIP for your Mac in the browser; unzip it, drag the new app to Applications (replace the old one) and open it as in step 2. **Later** hides the message for that version. If the update is installed automatically (it is, once the app is signed), a window says "Update <version> has been downloaded" with **Restart now** / **Later**. An unreachable server shows nothing; the log is `~/Library/Application Support/IO Doc Scanner/logs/main.log`.

Publishing a new version (for whoever builds it): raise `version` in `electron/package.json`, `npm run dist:mac` on a Mac (or the ZIP build on another machine), copy the two `…-mac.zip` files and their `.blockmap` files to the server folder, and `latest-mac.yml` **last**. Details in `electron/README.md`.

No .dmg is included in this package (a .dmg can only be built on macOS: run `npm install && npm run dist:mac` in the `electron` folder of the source).
