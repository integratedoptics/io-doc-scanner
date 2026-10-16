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
   npm run dist
   ```

4. In `electron\dist` you now have:
   - `IO Doc Scanner Setup 1.4.0.exe` — the installer (Start-menu entry, uninstaller). Only the **installed** app updates itself (see "Automatic updates" below).
   - `IO Doc Scanner Setup 1.4.0.exe.blockmap` and `latest.yml` — what the update server needs (see "Automatic updates").
   - For a portable copy without installing, build the ZIP instead: `npm run dist:win:zip` gives a `…-1.4.0-win.zip` — unzip it anywhere, open the folder and double-click `IO Doc Scanner.exe`. No installation, no admin rights. (The ZIP does not update itself.)

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

## The easiest way to run it on a PC: the ZIP

1. Copy the `.zip` file to the PC and right-click → **Extract All** (a folder such as `C:\Tools\IO Doc Scanner` or one on a shared drive).
2. Open the folder and double-click **IO Doc Scanner.exe** (right-click → *Send to → Desktop (create shortcut)* for an icon).
3. First run only: SmartScreen → **More info → Run anyway**, then enter the Settings as above.

To update, delete the old folder and unzip the new one; settings stay in `%APPDATA%\IO Doc Scanner`. To build only the ZIP: `npm run dist:win:zip`.

## Updating, removing, silent install

- **Update:** the installed app updates itself (next section). To update by hand, run the newer installer; it replaces the old version and keeps the settings.
- **Remove:** *Settings → Apps → IO Doc Scanner → Uninstall.*
- **Where data lives:** `%APPDATA%\IO Doc Scanner\` (settings and the local card queue).
- **Install on many PCs without clicking:** `"IO Doc Scanner Setup 1.4.0.exe" /S` (add `/allusers` or `/currentuser`
  to choose the scope).

## Automatic updates (installed app)

The installed app asks the internal update server (`http://192.168.1.79:3005/updates/io-doc-scanner/`) for a newer version when it starts and then every 30 minutes, and downloads it in the background. When it is ready, a window says **"Update <version> has been downloaded"**: **Restart now** installs it and restarts the app; **Later** installs it the next time the app is closed. If the server cannot be reached nothing is shown (the app only writes a line to `%APPDATA%\IO Doc Scanner\logs\main.log`).

To publish a new version: raise `version` in `electron\package.json`, run `npm run dist` on a Windows PC, copy `IO Doc Scanner Setup <version>.exe` and its `.blockmap` to `\\192.168.1.79\docker\electron-update-server\updates\io-doc-scanner\`, and copy `latest.yml` there **last**. Details in `README.md`.

## Building without a Windows PC

`npm run dist:win` also works on a Mac or Linux machine only if Wine is installed, and is not reliable on
Apple-silicon Macs. A GitHub Actions workflow on a `windows-latest` runner is the clean alternative — ask for one if you want it.
