# Card Scanner — installing on your Samsung phone

Version 1.3 · `CardScanner-1.3.apk`

**File:** `CardScanner-1.3.apk` (22 MB, signed, arm64 + armeabi-v7a, Android 7.0 or newer)

The app is not on Google Play, so it is installed as a "sideload". This takes about a minute.

## 1. Get the APK onto the phone

Any of these works:

- Save it to Synology Drive on the computer and open Synology Drive on the phone, or
- email it to yourself and download the attachment, or
- connect the phone by USB (choose **File transfer / MTP**) and copy it into `Download`.

## 2. Open it

1. Open **My Files** (Samsung's file manager) → **Internal storage** → **Download** (or wherever you saved it).
2. Tap **CardScanner-1.3.apk**.

## 3. Allow installation from that app

The first time, Android says *"For your security, your phone is not allowed to install unknown apps from this source."*

1. Tap **Settings** in that dialog.
2. Turn on **Allow from this source** (this permission belongs to the app you opened the file from — My Files, Chrome, Gmail or Synology Drive).
3. Press **Back**, then tap the APK again → **Install**.

Manual route, if you prefer: **Settings → Apps → ⋮ (top right) → Special access → Install unknown apps →** pick **My Files → Allow from this source**.

## 4. Play Protect warning

Samsung will show *"Unsafe app blocked"* or *"App scanning"* because the app is signed with my own key rather than a Play Store key.

- Tap **More details → Install anyway**, or **Install without scanning**.

That warning is expected for any self-signed APK. After installing you can leave Play Protect on as usual.

## 5. First run

- Open **Card Scanner** from the app drawer.
- Tap **Take a photo of a card** — this opens your normal Samsung camera app, so the app itself needs no camera permission and asks for nothing.
- On Android 10+ no storage permission is needed either. On Android 9 or older, allow **Storage** once so the export files can be written.

## 6. Where the Excel files land

Export writes into **Internal storage → Documents → CardScanner**:

- `Contact-YYYY-MM-DD.xlsx`
- `Address-YYYY-MM-DD.xlsx`
- `Cards-YYYY-MM-DD.xlsx` (plain backup sheet with everything, including company and website)

To get them onto the NAS automatically, add `Documents/CardScanner` as a synced folder in the Synology Drive app. Or use **Share / send to Synology Drive** in the app right after exporting and pick Synology Drive from the share sheet.

## 7. Standardising the data before it goes anywhere

Version 1.3 tidies each card up as soon as it is scanned:

- **Country** is matched against the Territory list from your instance, so
  `Deutschland`, `GERMANY` and `U.S.A.` all become the one spelling ERPNext holds.
- **Phone and mobile** get the international code of that country: `0612 34567`
  on a Lithuanian card becomes `+370 61234567`.
- **State / county** abbreviations are written out: `CA` → `California`,
  `NSW` → `New South Wales`, `BY` → `Bayern`.

Anything that cannot be settled honestly is left exactly as printed and marked
in red with a short note — a phone number on a card with no country, or a `CA`
that could be California or Cataluña. Nothing is guessed. The
**Standardise country, region and phone numbers** button re-runs the pass after
you edit a field, and there is a switch in Settings to stop it running by itself.

## 8. Sending cards straight into ERPNext

You no longer have to go through Excel. Set it up once:

1. **Settings → ERPNext connection.** Type the address of your instance, e.g.
   `https://erp.yourcompany.lt` — no trailing slash needed, the app trims it.
2. **Choose how to sign in.**
   - *API key and secret* (recommended). In ERPNext open your user record →
     **API Access** → **Generate Keys**, and copy both values across.
   - *Email and password* works too if you would rather not create a key.
3. Tap **Test the connection.** It confirms the credentials and, at the same
   time, reads your live Territory and Country lists so the country matching
   follows your instance rather than the list compiled into the app.

Then on each card, under **Synchronise with ERPNext**:

- pick the **organisation record** type — Customer, Supplier, Lead or Prospect;
- flip the three switches for **Organisation**, **Contact** and **Address**.
  Contact and Address are on by default, Organisation is off — you usually
  already have the company. Settings holds the defaults for new cards.

Tap **Send this card to ERPNext**, or use the button on the Export screen to
send everything you have selected.

What to expect:

- The organisation is created first, so the contact and the address are both
  **linked back to it** automatically.
- A record that already exists is reported as *already in ERPNext*, with the name
  of the record it found. **Nothing is overwritten**, and the other documents for
  that card still go through.
- If ERPNext rejects something, the field that caused it **turns red with the
  server's own message** underneath. Fix it and send again — whatever already
  went through is recognised and not duplicated.
- A single problem affecting everything, such as a wrong password, is reported
  once at the top rather than three times.

### What the ticks mean (new in 1.3)

Each of the three lines in the report carries a mark:

| Mark | Meaning |
| --- | --- |
| green tick | the record is in ERPNext — the app read it back by name after writing it |
| red cross | ERPNext refused it, or it could not be read back afterwards |
| grey dash | that switch was off, so nothing was attempted |

A green tick is not just "the server said OK": after every create the app fetches
`/api/resource/Contact/<name>` (and the same for the organisation and the
address) and only ticks the line once the record actually comes back.

Underneath each line you may see an amber note. That is the app telling you what
it had to change to get the record accepted — for example *Added "Dr" to the
Salutation list in ERPNext*, or *ERPNext has no Country called "Freedonia", so it
was left out*. Values ERPNext keeps in its own lists (salutations, genders, job
titles) are added for you when the Settings switch allows it; countries,
territories and departments are never invented, because those are lists you
maintain.

If ERPNext refuses one particular field, the app removes just that field and
sends the document again, so a single odd value on a card no longer costs you
the whole record. Everything it dropped is listed.

### The photo of the card goes with the contact (new in 1.3)

The picture is attached to the new contact as a private file, named
`business-card-<person>-<date>.jpg`. You will find it under **Attachments** on
the contact in ERPNext. Turn it off with **Attach the card photo to the contact**
in Settings. If the attachment fails — a size limit, usually — it is reported on
the contact line and the contact itself is unaffected.

### Suppliers (new in 1.3)

Choose **Supplier** as the organisation record and turn the Organisation switch
on: a supplier that is not already there is created, and the contact and address
are linked to it. With the switch off, no organisation record is created at all;
the contact still keeps the company name as text.

### Error messages you can act on (new in 1.3)

Earlier builds could show a wall of Python starting with
`{"exc":"[\"Traceback (most recent call last)`. That was the app's own fault: it
printed the beginning of the traceback, and the useful line is at the end. It now
reads the real exception out and shows it in plain words on the field that caused
it, for example *Could not find Designation: CTO — ERPNext does not have that
value in its own list yet*.

Credentials stay on the phone and are only sent over `https`. An instance on
your own office network (`192.168.…`, `10.…`, `localhost`) may be reached over
plain `http`, because such an address cannot have a public certificate; anything
else on `http` is refused.

## 9. Importing into ERPNext by file instead

1. **Contacts first:** ERPNext → **Data Import** → New → Document Type **Contact**, Import Type **Insert New Records** → attach `Contact-….xlsx` → Save → **Start Import**.
2. **Then addresses:** the same with Document Type **Address** and `Address-….xlsx`.

Notes:

- The files are your own downloaded templates, so the header block is exactly what your instance expects. The first column and the ID column stay empty on purpose — that is what tells ERPNext to create new records.
- `Contact` requires a first name; `Address` requires address line 1, city and country. Cards missing an address are simply left out of the Address file and the app tells you how many.
- If you fill in **Link doctype** + **Link name** on a card (for example `Customer` + the exact customer ID), both the contact and the address are linked to that party on import.
- The Contact template has no company column, so the company name is kept in the address title and in `Cards-….xlsx`.

## Updating later

Installing a newer APK signed with the same key updates the app in place and keeps your saved cards. Uninstalling deletes the stored cards and card photos, but not the exported Excel files in Documents.

## Updating from 1.2 to 1.3

Install `CardScanner-1.3.apk` over the top. Same signing key, so it is an update
and **your saved cards and settings are kept**. The app icon changes to the
Integrated Optics mark. Two new switches appear at the bottom of the ERPNext
section in Settings, both on by default: attaching the card photo, and adding
missing salutations and job titles.

## Updating from 1.1 to 1.2

Install `CardScanner-1.2.apk` over the top. It is signed with the same key, so
Android treats it as an update: **your saved cards and settings are kept**, and
you do not need to uninstall anything. After the update, open Settings once to
fill in the ERPNext connection.

## Updating from 1.0 to 1.1

Just install the new APK over the old one — it is signed with the same key, so
Android treats it as an update and **your saved cards and settings are kept**.
You do not need to uninstall anything. If Android refuses with *App not
installed*, it means the old copy came from a different signing key; uninstall
the old app first, and note that this clears the card list, so export anything
you still need beforehand.
