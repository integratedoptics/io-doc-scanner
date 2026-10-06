# Installing IO Doc Scanner 1.4 on Windows PCs

The Windows app is the same program as the Mac one (Electron). It runs on 64-bit
Windows 10 and 11. The build is **not code-signed**, so Windows shows a warning the first
time — that is expected (see step 3).

## A. Build the installer once (on any one Windows PC)

1. Install **Node.js LTS** from <https://nodejs.org> (accept the defaults).
2. Get the code: `git clone https://github.com/integratedoptics/io-doc-scanner` (or download the ZIP
   from GitHub and unpack it).
3. Open **PowerShell** in the `electron` folder and run:

   ```
   npm install
   npm run dist:win
   ```

4. In `electron\dist` you now have two files:
   - `IO Doc Scanner Setup 1.4.0.exe` — the installer (Start-menu entry, uninstaller, can be updated by installing over it)
   - `IO Doc Scanner 1.4.0.exe` — the portable version (no installation, runs from wherever you put it, e.g. a USB stick or a network share)

   Copy whichever you prefer to the other PCs (shared drive, USB stick, e-mail to yourself …).
   Building takes a few minutes the first time because it downloads Electron.

## B. Install on each PC

1. Double-click `IO Doc Scanner Setup 1.4.0.exe`.
2. **SmartScreen warning** ("Windows protected your PC"): click **More info → Run anyway**.
   (Company-managed PCs with strict policies may need IT to allow the file.)
3. Choose *Install for anyone using this computer* or *only for me*, pick the folder if you
   want something other than the default, and finish. Start it from the Start menu or the desktop icon.
4. Open **Settings** in the app and enter, on every PC separately:
   - the ERPNext address and the API key/secret (or e-mail + password) — **Test connection** should turn green;
   - for reading documents with AI: the **Anthropic API key** (Document field extraction). Without it
     the built-in reader still fills in English, Lithuanian and German invoices.
5. **Camera:** Windows may ask whether apps may use the camera — allow it
   (*Settings → Privacy & security → Camera → Let desktop apps access your camera*).

## Updating, removing, silent install

- **Update:** run the newer installer; it replaces the old version and keeps the settings.
- **Remove:** *Settings → Apps → IO Doc Scanner → Uninstall.*
- **Where data lives:** `%APPDATA%\IO Doc Scanner\` (settings and the local card queue).
- **Install on many PCs without clicking:** `"IO Doc Scanner Setup 1.4.0.exe" /S` (add `/allusers` or `/currentuser`
  to choose the scope).

## Building without a Windows PC

`npm run dist:win` also works on a Mac or Linux machine only if Wine is installed, and is not reliable on
Apple-silicon Macs. A GitHub Actions workflow on a `windows-latest` runner is the clean alternative — ask for one if you want it.
