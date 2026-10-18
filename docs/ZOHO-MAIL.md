# Documents from Zoho Mail (desktop app, version 1.7.0)

Windows and macOS only. On the Documents screen, **From email (Zoho Mail)** lists the recent inbox mails that carry a
PDF or picture. Choose an attachment and it opens in the normal Documents form and viewer, as if it had been picked from
disk. The app **only reads** the mailbox: it cannot send, move, delete or mark mail.

## One-time set-up (about 5 minutes, in a browser)

The app signs in to Zoho with a "Self Client", a private API key that belongs to your Zoho login.

1. Open the Zoho API Console for **your mailbox's region** — Europe: <https://api-console.zoho.eu> (global: `.com`, India: `.in`, Australia: `.com.au`, Japan: `.jp`). Sign in with the mailbox account.
2. **Add Client → Self Client → Create.** Open it and copy the **Client ID** and **Client Secret** from the *Client Secret* tab.
3. On the **Generate Code** tab:
   - Scope: `ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.folders.READ`
   - Time duration: **10 minutes** (the default is only 3)
   - Scope description: anything, e.g. "IO Doc Scanner"
   - Press **Create** and copy the code (`1000.…`).
4. In the app: **Settings → Zoho Mail**. Choose the same region, paste Client ID, Client Secret and the code, press **Connect** (within the code's validity). The code works once.
5. Enter your **Trusted senders** (below) and, if you like, the number of days to look back.

The Client Secret and the resulting refresh token are kept by the app's main process, encrypted with the computer's
keychain (macOS Keychain / Windows DPAPI via Electron *safeStorage*); if the system offers no keychain they are kept in a
file readable only by your user. **Disconnect** deletes them and asks Zoho to void the token. To revoke access at any time
from Zoho's side, delete the Self Client in the API Console.

Only an organisation admin can create API clients in some Zoho set-ups; if the console refuses, ask the admin to do step 2–3
or to allow it.

## What is shown, and what is hidden

Only **PDF, JPG and PNG** attachments are offered. Hidden and counted instead ("N attachments of a dangerous type were
hidden"): programs and scripts (`.exe .scr .bat .cmd .js .vbs .ps1 .jar .lnk .msi`…), web pages and SVG, archives
(`.zip .rar .7z .iso`…), Office files with macros, `.eml`, and anything whose name is disguised — a second extension
(`invoice.exe.pdf`), invisible or right-to-left control characters, or a row of spaces before the extension. Small pictures
(under 20 KB: logos, signatures) are not offered either.

## The sender verdict

Every mail gets one of three verdicts, shown as a coloured card:

| Verdict | When | What you do |
|---|---|---|
| **Trusted sender** (green) | The sender is on your trusted list **and** the receiving mail server's checks (DMARC, or SPF/DKIM) passed, and nothing else looks wrong | One click: **Open** |
| **Check the sender** (orange) | Unknown sender, or a trusted one whose checks could not be read, or the text talks about changed bank details / urgent payment / a login | A confirm click (**Open anyway**); an unknown sender can be added to the trusted list from there |
| **Risky** (red) | Failed sender checks (the mail may be forged); a look-alike of a trusted, well-known (couriers, customs, banks, Microsoft, PayPal…) or your own domain; a name that shows one address but is another; replies going to another address (e.g. a free webmail account) from a trusted sender; mail claiming to be from your own domain without being verified | The reasons are listed. Tick **I have checked this sender another way** (phone a known number, write to an address you already know), then **Open anyway** |

**Trusted senders** are company domains (`supplier.com`, covers subdomains) or full addresses (`name@supplier.com`), one
per line. Trusting a domain only helps for mail that *also* passes the sender checks — a forged mail pretending to be a
trusted supplier is still red.

After the file is opened, nothing happens in ERPNext until you review the document and press Send, as for any document.

## "The mail claims to come from your own domain but is not verified"

This red warning means the Zoho server that received the mail did **not** record a passing SPF, DKIM or DMARC result for a
message that shows your own domain as the sender. The warning now says what was read ("SPF pass, DKIM none…" or "no result in
the headers"). There are two quite different causes:

- **A real forgery** — someone else's server sends as `…@integratedoptics.com`. Results show `fail`.
- **Your own legitimate mail that does not authenticate** — ERPNext's outgoing mail, a NAS or printer, a web form, a CRM or
  newsletter service, or a mail relayed without a DKIM signature. Results show `none`/`neutral` or nothing.

The risk can be reduced to almost nothing by making **every legitimate sender authenticate** and then telling the world to
**reject everything else**. One-time work in the Zoho Mail Admin Console and your DNS:

1. **SPF** — one TXT record on the domain, for Zoho EU: `v=spf1 include:zoho.eu ~all`. Add an `include:` for every other
   service that sends as your domain (never publish two SPF records).
2. **DKIM** — Admin Console → **Domains** → your domain → **Email Configuration** → **DKIM**: add a selector, publish the TXT
   record it shows, press **Verify**, and make it the default signing key.
3. **Other senders** — each service that sends as `@integratedoptics.com` must either send **through Zoho's SMTP** with a
   mailbox login (simplest; ERPNext's Email Account can do this) or have its own DKIM key / SPF entry. Otherwise it fails DMARC.
4. **DMARC** — Admin Console → **Domains** → **Email Configuration** → **DMARC**. Go in steps, reading the report mails that
   arrive at the address you enter: first `p=none` (monitor only, 2–4 weeks; every legitimate sender that fails is listed),
   then `p=quarantine`, then `p=reject`. Use only one `_dmarc` record. With `p=reject`, mail that pretends to be your domain
   and fails is not delivered at all, so it never reaches the app.

Afterwards a legitimate mail from your own domain shows `DMARC pass` and no warning, and a forged one is either rejected by
Zoho or still flagged red here. What this **cannot** remove: a mailbox of yours or a colleague's that has really been hacked
(it passes every check), and mail from look-alike domains (`integrated-optics.com`), which the app flags separately. Keep
confirming bank-detail changes by phone.

## Safeguards that do not depend on the screen

The decisions are taken in the app's main process, again, when the file is downloaded: the sender is re-judged from the
mail's own headers, the confirmation level it demands must have been given, the file name is re-checked, and the
downloaded bytes must really be what the name claims (an `.exe` named `.pdf` is refused, as are scripts, web pages and
archives inside a "PDF"). A PDF is searched for commands that launch programs (`/Launch`) or carry an embedded
executable — refused — and for JavaScript, automatic actions, form submission and password protection — warned about. The
in-app viewer (pdf.js) does not run PDF scripts either way. Files are kept in memory only; the app does not write them to disk.

## Limits — read this

- This lowers the chance of opening a forgery by habit. It is **not a guarantee.** A real supplier's mailbox that was
  hacked passes every check; a forged invoice from a new "supplier" can look clean. Keep checking bank details by phone.
- The PDF scan reads only the readable parts of a file; content packed into compressed object streams is not seen.
- The sender checks (SPF/DKIM/DMARC) are the results the Zoho mail server wrote into the message headers. If Zoho writes
  them in a form the app does not recognise, mails show "could not be read" and are never green — please report such a
  case; the panel's *Sender checks* line shows what was read.
- The mail API was implemented from Zoho's published documentation and has been tested against a mock server, not yet
  against a live mailbox. Expect small adjustments on first real use.
- Only the Inbox folder is read; the number of mails per listing is capped at 40.
