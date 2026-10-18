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
| 1.8.0 | 11 |
| 1.7.2 | 10 |
| 1.7.1 | 9 |
| 1.7.0 | 8 |
| 1.6.0 | 7 |
| 1.5.0 | 6 |
| 1.4 | 5 |

## 1.8.0

**All four apps — Export: Sales invoices → XRechnung.**
New card on the Export screen. It lists the submitted Sales Invoices of the series **IOG** (changeable), checks what XRechnung
needs (Leitweg-ID from the invoice field `leitweg_id`, seller contact, buyer e-mail, bank, VAT category for 0 % lines, totals
against ERPNext), lets you fill in what is missing, and writes one **XRechnung 3.0 UBL** file per invoice (credit notes as UBL
CreditNote) to Documents/CardScanner, optionally also attaching it to the Sales Invoice in ERPNext. Tested with an offline
EN 16931 / XRechnung rule validator; validate the first real file with the KoSIT validator or the authority's portal before
sending. See `docs/XRECHNUNG.md`.

## 1.7.2

**All four apps — Supplier Quotation filing (test server).**
- Quotations are filed under the **SQTN-** naming series instead of the server's default (RFQ-). If the server has no
  such series the default is used and the result says so.
- The validity date goes into the **valid_till** field. The server's field list is now read afresh for every quotation, so
  a field or series created on the server is used straight away, without restarting the app.

**Desktop — Zoho Mail.** The "mail claims to come from your own domain but is not verified" warning now shows what the
mail server actually recorded (SPF / DKIM / DMARC, or that nothing was found), and `docs/ZOHO-MAIL.md` explains how to make
your own mail verify (SPF, DKIM, DMARC with a reject policy in the Zoho Admin Console and DNS).

## 1.7.1

**All four apps — fix: "Use this" on a possible existing supplier.**
On the Documents screen, pressing **Use this** next to a suggested existing supplier (for example *Wavespectrum Laser
(Photonics) Group Limited — 90 % match*) now puts that supplier's name into the Supplier field. Before, it only remembered
the choice internally: the field kept the printed name, and sending to the test server failed with *"The test server has no
Supplier like …"* because that step looked the supplier up by the printed name and ignored the choice. The test-server
send (supplier quotations and invoices) now also uses the chosen supplier directly. No settings change; nothing else differs
from 1.7.0.

## 1.7.0

**Desktop (Windows / macOS) — documents from Zoho Mail.**
- *From email.* A new button under *Choose a PDF or picture* on the Documents screen opens a list of the recent inbox
  mails (3 / 7 / 14 / 30 days) that carry a PDF or picture. Pick an attachment and it opens in the normal Documents
  form and viewer, exactly as a file chosen from disk. Read-only: the app can list and open attachments, never send,
  move or delete mail. Set-up (Zoho "Self Client", one time) is in `docs/ZOHO-MAIL.md` and in Settings → *Zoho Mail*.
- *Scam filter.* Only PDF, JPG and PNG attachments are listed; programs, scripts, archives, macro files and disguised
  names (`invoice.pdf.exe`, hidden or right-to-left characters) are hidden and counted. The file's real content must
  match its name, and a PDF is scanned for programs it would launch. Each mail gets a verdict — *Trusted sender*
  (on your trusted list AND passed the mail server's SPF / DKIM / DMARC checks): one click; *Check the sender*
  (unknown, nothing wrong found): a confirm click; *Risky* (failed sender checks, look-alike domain, different
  Reply-To, display-name trick, your own domain unverified): the reasons are shown and a tick box is required.
  The decisions are taken again in the main process when the file is downloaded — the page cannot skip them.
- The Zoho credentials stay in the main process (encrypted with the system keychain when available).

The phone apps are unchanged.

## 1.6.0

**Desktop (Windows / macOS).**
- *Collapsible menu.* An arrow at the top of the left menu folds it to a rail of icons (hover shows the name) and
  opens it again; the choice is remembered (setting `nav_collapsed`).
- *Drag the document.* When the document in the viewer is larger than its box (zoomed in, or a long PDF), hold the left
  mouse button on it and drag to move it around; the pointer turns into a hand.
- *Shipment tracking box.* The Tracking / AWB number — and, for a waybill, the Purchase Order finder with its text —
  now sit in a box of their own under the Document box, in what used to be an empty grey area, instead of inside the
  test-server box. Documents without a tracking number do not show it.

The phone apps are unchanged (same layout, same place for the tracking field).

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
