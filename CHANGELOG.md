# Changelog — IO Doc Scanner

One version number for all four apps (Android, iPhone, Windows, macOS). From 1.4 on every released update
gets a new number:

- **1.x.0** — new features (this also covers a redesigned screen),
- **1.x.y** — fixes only (1.5.1, 1.5.2, …),
- **2.0.0** — only for a change that needs everybody to do something (e.g. a new server address).

Where the number lives (raise it in all four places, the same value):
`electron/package.json` → `version`;
`android/CardScanner/app/build.gradle` → `versionName` (and `versionCode`, a whole number that must go up by one every release);
`ios/CardScanner/CardScanner.xcodeproj` → `MARKETING_VERSION` (and `CURRENT_PROJECT_VERSION`, +1 every release; `make_xcodeproj.py` holds the same values).
Then tag the commit `vX.Y.Z`. How the apps pick the update up: `docs/MOBILE-UPDATES.md` and `electron/README.md`.

| Version | versionCode / build |
|---|---|
| 1.5.0 | 6 |
| 1.4 | 5 |

## 1.5.0

**Desktop (Windows / macOS) — new layout.** The window opens wide (up to 1440 × 920) and the screens use the width:
a navigation sidebar on the left; *Scan* in balanced columns (person, contact, address, ERPNext, more); *Documents* in
two panes — the document itself, large, on the left (PDF pages or picture, with zoom and *fit width*) and the form on
the right in clear sections (Document, Supplier / Customer, Amounts, New-flow details, Parent record, Review, Send);
*Settings*, *Export* and *Cards* in columns / a grid. Below about 1100 px the panes stack. The phone apps and a plain
browser keep their layout unchanged.

**Review of the attached document (all platforms).** A *Review* box in the Documents form: one tick for each key
value (document type and file, number, date, supplier or customer, PO / sales-invoice reference, currency and total,
and — when the new flow is on — lines, charges, AWB, parent record), a status (*Not reviewed / OK / OK after
corrections / Problem*), the reviewer's name (remembered) and a note. *Mark everything* ticks all; the status turns to
OK by itself when everything is ticked. Sending is never blocked. The result is written into the ERPNext record
(Accounts Document comment; Purchase Invoice / Purchase Receipt / Supplier Quotation remarks) and is shown in the
upload history. On the phones the document viewer is a fold-out above the form.

**Versioning.** The apps now carry the same number everywhere (see above); the desktop app shows "1.5.0-desktop".

## 1.4

First release in use: Documents tab (accounts documents, review and approve), new document flow on the test server
(Purchase Invoice / Purchase Receipt / Supplier Quotation, charges into Purchase Taxes and Charges), upload history,
duplicate Customs Declaration protection, webcam capture on desktop, automatic updates (desktop: electron-updater;
phones: `mobile.json` from the internal update server).
