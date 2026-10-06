# Card Scanner (Android) — version 1.4

Offline business card scanner that exports ERPNext-ready Excel files. No server, no account, no ERPNext connection.

## How it works

| Layer | Implementation |
|---|---|
| Shell | One `MainActivity` with a `WebView` loading `file:///android_asset/index.html` |
| Capture | `Intent(MediaStore.ACTION_IMAGE_CAPTURE)` through a `FileProvider`, plus a gallery picker (`ACTION_OPEN_DOCUMENT`) |
| OCR | Google ML Kit **bundled** Latin text recognition (`com.google.mlkit:text-recognition`) — runs fully on the device, no Play Services download, no network |
| Field parsing | Rule-based parser in `assets/app.js` (email, phone/mobile/fax, website, job title, legal-form company detection, street/post code/city/country) |
| Optional AI cleanup | You paste your own OpenAI-compatible or Anthropic key in Settings; only then is the recognised text sent anywhere. Off by default |
| Storage | Card records as JSON in app-private storage, card photos as downscaled JPEGs |
| Export | SheetJS opens the two bundled ERPNext templates and appends rows below the header block, so the file structure stays exactly as ERPNext expects |
| Delivery | Files written to `Documents/CardScanner` via MediaStore, plus an Android share sheet for Synology Drive |

## Why native capture instead of `getUserMedia`

A WebView served from `file://` is not a secure context, so the browser camera API is unavailable. Using the system camera intent avoids that entirely, needs no `CAMERA` permission, and gives much better photos (autofocus, flash, full sensor resolution) than a webcam stream — which matters a lot for OCR accuracy.

## Export details

Three files per export, dated:

- **Contact-YYYY-MM-DD.xlsx** — your Contact import template. Writes `first_name`, `last_name`, `email_id`, `salutation`, `phone`, `mobile_no`, `designation`, `department`, `status`, `is_primary_contact`, `main_language`, **`linkedin`**, **`unsubscribed`**, and the `link_doctype`/`link_name` child-table columns.
- **Address-YYYY-MM-DD.xlsx** — your Address import template. Writes `address_type`, `address_title`, `address_line1`, `address_line2`, `city`, `state`, `pincode`, `country`, `email_id`, `phone`, `fax`, `is_primary_address`, and the link columns. Only cards with line 1 + city + country are included.
- **Cards-YYYY-MM-DD.xlsx** — plain backup sheet with every captured field, including company name, website, notes and the raw recognised text.

The template column positions are resolved at run time by reading the `Column Name:` row, so a re-downloaded template with a different column order still works.

## Building

```bash
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/android-sdk   # platform 34, build-tools 34.0.0
gradle assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the throwaway keystore in `keystore/cardscanner.jks` (store/key password `cardscanner`). Keep that file: an update APK must be signed with the same key to install over an existing installation. Replace it with your own key before distributing the app more widely.

## Testing

`test_phase4.py` is the newest suite: it loads the WebView assets in headless
Chromium against an **in-page mock ERPNext** and checks the country, region and
phone normalisation case by case, the three switches, token and login
authentication, the exact endpoints and headers, the write ordering, duplicate
skipping, field-level error tracing and the http rule — a little over a hundred
assertions, all passing. `test_phase3.py` covers the brand restyle, the
newsletter tick, the LinkedIn field and the move gesture. `test_phase5.py` adds
19 sections against a mock ERPNext that answers with real Frappe tracebacks:
error reading, link resolution, Select and unknown-field handling, read-back
verification, supplier creation, the attachment, the retry and the tick/cross
report.

`test_export.py` loads the WebView assets in headless Chromium with a shim bridge, parses three sample cards, runs a full export and verifies the produced workbooks with openpyxl — including that column A stays blank and data starts on the correct row.

The native layer (camera intent, ML Kit, MediaStore, share sheet) has no automated test here because no Android device or emulator was available; it is exercised on first run on the phone.

## New in 1.4

Version 1.4 turns the scanner into an accounts-document manager as well as a
business-card scanner. A new **Documents** tab takes a PDF (purchase, proforma
or sales invoice, customs declaration, customs-declaration invoice, shipping
invoice), reads its text, asks Claude to pull out the fields, lets you review
them, and creates an **Accounts Document** in ERPNext with the PDF attached.
It flags duplicate suppliers (one tap to merge) and suggests the parent
document, which you confirm. The rivile / ilte / paid ticks are never set by
the app. There is also a Windows/macOS desktop build (see `electron/`).

## New in 1.3

Version 1.3 is about what happens after **Send this card to ERPNext**: making a
refusal readable, making an acceptance provable, and putting the brand mark on
the app.

### The real reason a document was refused

The old build showed the first 300 characters of whatever ERPNext sent back,
which for a hard failure is the top of a Python traceback and says nothing at
all. Frappe returns that traceback JSON-encoded in an `exc` field with the
exception class in `exc_type`, and the line that matters is the **last** one,
not the first. The app now reads it properly, in the order Frappe means it to be
read:

1. `_server_messages` — the messages Frappe wrote for a person;
2. the tail of the traceback in `exc`, split into a class and a message;
3. `exception`, then `message`;
4. failing all of that, an HTML error page reduced to its text.

`frappe.exceptions.LinkValidationError: Could not find Designation: CTO` reaches
the screen as *Could not find Designation: CTO — ERPNext does not have that
value in its own list yet*, marked on the Designation box. The same applies to
missing mandatory values, duplicates, permission errors and values that are too
long.

### Values are settled before the document is sent

Most of those refusals came from **Link fields**: ERPNext only accepts a value
that already exists in the list behind the field. Before sending, the app now
reads the doctype's own field list from your instance and:

- looks up every Link value — Salutation, Gender, Designation, Country,
  Territory, the group fields — with `GET /api/resource/<Doctype>/<value>`;
- **adds** the ones that are safe to add: Salutation, Gender and Designation are
  single-column lists, so `Dr` or `Head of Photonics` is created and reported;
- **never invents** a Country, a Territory or a Department. A Country list is a
  master you maintain, and a Department needs a company. Such a value is dropped
  from the payload and reported against its field;
- checks Select values against the doctype's real options, so a Status of
  anything other than Passive / Open / Replied never leaves the phone;
- drops fields your instance does not have — custom fields are read too, so a
  `linkedin` field you added yourself is used, and an instance without one is
  not asked to accept it.

The switch **Add missing salutations and job titles to ERPNext** in Settings
turns the creating half of this off; the checking half always runs.

If ERPNext still names one offending field, that field is removed and the
document is sent again, up to three times, and every removal is reported. One
bad value can no longer cost you the whole card.

### A tick means the record is really there

Every created document is read back with
`GET /api/resource/<Doctype>/<name>`. Only then does the report show a **green
tick**; a refusal, or a record that cannot be read back, shows a **red cross**,
and a switch that was left off shows a grey dash. Ticks and crosses sit next to
Organisation, Contact and Address on every report, single-card and bulk alike.

### The card photo goes with the contact

The picture is attached to the contact as a private file the moment the contact
is created. Frappe's documented `upload_file` endpoint wants a multipart body,
which the WebView bridge cannot build, so the app posts to the File doctype with
`decode` set and the image base64-encoded in `content` — the path Frappe's own
`File.get_content()` takes. A failed attachment is reported on the contact line
and never puts the contact itself in doubt. There is a Settings switch for it.

### A missing supplier is created

With the Organisation switch on and *Supplier* chosen, a supplier that is not
found is created and the contact and address are linked to it. With the switch
off, no organisation record is created at all — the contact keeps the company
name as plain text and goes in without a link.

### The Integrated Optics mark

The launcher icon and the header logo are the real mark, rebuilt as exact
geometry from the supplied artwork and checked against it pixel by pixel
(97.5 % agreement; the rest is JPEG edge dithering). `make_logo.py` holds the
geometry, `make_icons.py` writes all five Android densities plus the round,
adaptive and monochrome variants and the 1024 px iOS icon, and `verify_logo.py`
scores the rebuild against the original.

## New in 1.2

Version 1.2 stops the app at the point where the data leaves it and makes that
data fit ERPNext exactly, then lets it go straight in without the Excel detour.

### Country names are matched to your Territory list

The territory list exported from your instance is compiled into the app, so a
card that prints `Deutschland`, `GERMANY`, `P.R. China`, `U.S.A.` or
`80331 Munich, Germany` all end up as the one spelling your ERPNext actually
holds. 76 countries, 254 alternative spellings, native names and ISO codes are
recognised.

Two things worth knowing:

- Your list contains a few **misspellings** — `United Sates`, `Gerogia` and both
  `Colombia` and `Columbia`. A Link field only accepts an exact match, so the app
  deliberately writes the misspelled name for the Territory field and the correct
  one for the Address `country` field, which points at the separate Country
  doctype. Fixing the spelling in ERPNext is the right long-term move; the app
  will follow automatically, because on a successful connection test it reads the
  live Territory and Country lists and those then override the compiled tables.
- The **grouping rows** (`Europe`, `Nordics`, `DACH`, `Baltics`, `Middle East`,
  `Asia`, `Americas`, `Oceania`, `Africa`, `All Territories`) are never offered
  as a country, since they are folders rather than places.

A country that cannot be matched is left exactly as printed and flagged in red
for you to pick from the list — it is never guessed.

### Phone numbers always get an international code

`0612 34567` on a Lithuanian card becomes `+370 61234567`: the national trunk
prefix is dropped, the country's calling code is prepended, and the result is
checked against the digit count that country normally uses. A number that
already carries `+` or `00` is recognised and normalised. `mob.`, `tel:`, `Fax`
and similar labels are stripped, and an `ext. 12` suffix is preserved.

Per your instruction the code is only ever **inferred from the country**. If the
card has no country, or the digit count does not look right, the number is left
exactly as printed and flagged — nothing is invented.

### Region abbreviations are written out

`CA` → `California`, `N.Y.` → `New York`, `ON` → `Ontario`, `NSW` → `New South
Wales`, `MH` → `Maharashtra`, `SP` → `São Paulo`. 185 abbreviations across seven
countries (United States, Canada, Australia, Mexico, Brazil, India, Germany) are
covered. German states are written in German (`BY` → `Bayern`), which is how they
appear in ERPNext.

An abbreviation that the country's table does not contain, or one on a card with
no country at all, is flagged rather than expanded — `CA` is California in the
United States but Cataluña in Spain, and there is no honest way to choose.

All three run automatically when a card is scanned or opened; the *Standardise
country, region and phone numbers* button re-runs them on demand, and the switch
in Settings turns the automatic pass off.

### Direct synchronisation with ERPNext

Settings → **ERPNext connection**: the address of your instance, and either an
API key and secret (the default, and the better option) or your email and
password. **Test the connection** confirms it and reads the live Territory and
Country lists at the same time.

Each card then carries three switches of its own, plus a picker for which kind
of organisation record to create:

| Switch | Creates | Notes |
|---|---|---|
| **Organisation** | Customer, Supplier, Lead or Prospect | off by default; pick the type above the switches |
| **Contact** | Contact | on by default |
| **Address** | Address | on by default |

The organisation is written first, so the contact and the address can both be
linked back to it through ERPNext's `links` table — exactly what the Data Import
route does with Link doctype and Link name, only automatic. *Send this card to
ERPNext* does one card; the Export screen has a button for everything selected.

The calls are the ones you specified, all POST:

```
POST /api/method/login          usr / pwd, form encoded   (only in login mode)
POST /api/resource/Customer     the new document, as JSON
POST /api/resource/Contact
POST /api/resource/Address
```

with `Accept: application/json` on every request, `Content-Type:
application/json` on the document creates and
`application/x-www-form-urlencoded` on the login. In key mode the app sends
`Authorization: token <key>:<secret>` and never calls `login` at all. The
duplicate check is a `GET /api/resource/<Doctype>` with `filters` and
`limit_page_length=1`.

**Duplicates are skipped, the rest still goes.** Before creating anything the app
looks for an existing record — an organisation by name, a contact by email
address, an address by title and type. A match is reported as *already in
ERPNext* with the name of the record it found, and **nothing is overwritten**;
the other two documents for that card still go through.

**Errors point at the field to fix.** When ERPNext rejects a document, the app
unwraps the `_server_messages` reply, strips the HTML out of it and traces the
message back to the box on the card that caused it, which turns red with the
server's own wording underneath. Fix it and send again — the documents that
already went through are recognised as duplicates and not repeated. A problem
that affects everything, such as a wrong password, is reported once at the top
instead of three times.

### A note on http

Credentials are only ever sent over `https`, with one exception: an instance on
your own network (`192.168.…`, `10.…`, `172.16–31.…`, `localhost`, `*.local`)
may be reached over plain `http`, because those addresses cannot get a public
certificate. Anything else on `http` is refused with an explanation.

## New in 1.1

**Corporate identity.** The whole interface now follows the Integrated Optics
brandbook: brand black `#1d1d1b` chrome, light grey `#efefef` canvas, orange
`#ffa450` as the action colour with green `#34cb73` and violet `#9575ee` as the
supporting accents, section headings in small-caps orange, and the header strip
drawn from brand pattern #1 — the row of elongated thin triangles taken from the
logo detail, fading into black like laser light. The launcher icon is the
sanctioned icon-only **iO** mark, with the orange right-angle accent on the O
kept clearly visible as the brandbook requires. Type is Arial, which page 18 of
the brandbook names as the sanctioned substitute when ABC Camera and Steradian
cannot be embedded.

**Subscribe to newsletters.** A checkbox sits directly under the Email field.
Ticked, the exported Contact row gets `unsubscribed = 0`; unticked it gets
`unsubscribed = 1`, which is what ERPNext expects. Settings has a switch to have
it ticked by default.

**LinkedIn profile.** A new *LinkedIn profile* field after Website, exported to
the `linkedin` column of the Contact template.

- If the card itself prints a LinkedIn address, the offline parser picks it up
  and normalises it — no network involved.
- If AI cleanup is switched on, the model is additionally asked for the person's
  profile URL. The result is validated against
  `linkedin.com/{in|pub|company}/…` and anything else is discarded, and a violet
  caption marks the value as *suggested by the model and not verified*. The
  prompt explicitly forbids inventing a profile slug, but a language model can
  still be wrong, so treat a suggested URL as a lead to check rather than a
  fact. There is a switch in Settings to turn the lookup off.

**Moving text between fields by finger.** When the parser drops something into
the wrong box: press and hold the field for about **0.7 s** — it lifts, turns
violet and the phone gives a short vibration — then slide your finger to the
correct field, which highlights green, and let go. If the target already holds
text the two values swap. Sliding before the hold finishes still scrolls the
page normally, and a short tap still just puts the cursor in the field. A mouse
does the same thing, which is how the behaviour is tested.
