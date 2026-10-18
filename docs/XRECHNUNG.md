# Sales invoices → XRechnung (Export menu, version 1.8.0)

All four apps (Windows, macOS, Android, iPhone). **Export → Sales invoices → XRechnung** lists submitted ERPNext Sales
Invoices of one naming series (default **IOG**) and writes each as an **XRechnung 3.0** file: UBL 2.1 XML, EN 16931 CIUS
`urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0` (credit notes as UBL *CreditNote*). This is the
format German public bodies ask for. The app **only creates the file**; uploading it to the authority's invoice portal
(ZRE / OZG-RE / the state portal) stays a manual step.

## Use

1. **Settings** must have the live ERPNext address and credentials (the same ones used everywhere in the app).
2. **Export** → card *Sales invoices → XRechnung*. Series (default `IOG`) and the date range, press **List invoices**; or
   type one invoice number and press **Open**.
3. Tick the invoices and press **Check ticked invoices**. Each shows its totals and either *Ready to export* or what is
   missing, with an input for it. Fix the point (or fix it in ERPNext and check again).
4. **Create XRechnung files** saves `IOG-2026-00012_xrechnung.xml` to *Documents/CardScanner* (like the Excel export) and,
   if ticked, also attaches it to the Sales Invoice in ERPNext. Invoices that are not ready are skipped and listed.

Only submitted invoices are offered; drafts and cancelled invoices never are. A number typed into *Open* that is outside the
series is refused.

## Where each piece of data comes from

| XRechnung | From ERPNext |
|---|---|
| Invoice number, date, due date, currency, remarks | Sales Invoice `name`, `posting_date`, `due_date`, `currency`, `remarks` |
| **Leitweg-ID** (BT-10, mandatory) | Sales Invoice custom field `leitweg_id` (can be typed in the app if empty) |
| Customer's purchase order (BT-13) | `po_no` |
| Seller name, VAT ID | Company; `company_tax_id`; Company `reg_number` if the field exists |
| Seller / buyer address, country | the invoice's `company_address` and `customer_address` (Address); country code from the Country record |
| Seller contact (name, phone, e-mail — mandatory in XRechnung) | the contact typed in the card (kept in the app) → the invoice owner's User record → Company phone / e-mail |
| Buyer e-mail (electronic address, BT-49, mandatory) | `contact_email` → billing address e-mail → Customer e-mail → typed in the app |
| Bank (IBAN, BIC) | Company *default bank account* (Bank Account + its Bank) |
| Lines | each item's `net_rate` and `net_amount` (after discounts, before VAT), quantity, unit, item code and name |
| VAT | the *On Net Total* tax rows, with per-item `item_tax_rate` overrides |
| Totals, rounding, prepayment | recalculated; must agree with ERPNext's grand total (±5 ct) or the invoice is refused; ERPNext's rounded total and advances are shown as separate rounding / prepaid amounts |

Units are mapped to UN/ECE codes (Nos → C62, Hour → HUR, Kg → KGM …); an unknown unit becomes C62 and a warning says so.

## VAT with 0 %

For lines with 0 % VAT the category must be stated. The app proposes one and asks you to confirm it:

- same country as the seller → **E** (exempt);
- another EU country and the customer has a VAT ID → **K** (intra-community supply; then a delivery date — the invoice date unless you change it — and the delivery country are written, as the rules demand);
- outside the EU → **G** (export);
- otherwise **E**. You can choose **AE** (reverse charge), **Z** or **O** instead.

Which category is correct is a tax question (goods or services, whether the authority has a VAT ID, place of supply). Ask your
accountant once for the usual case; the app does not decide it for you, it only proposes.

## What is checked, and how it was tested

Before a file is written the app refuses (and says why): no Leitweg-ID, incomplete seller or buyer address, no VAT ID, no seller
contact, no buyer e-mail, no or invalid IBAN, a calculated total that disagrees with ERPNext, tax/charge rows other than VAT
(for example "Actual" freight rows — put such costs on an item line), category K without the customer's VAT ID, drafts.

The generated files were validated offline against the official **EN 16931 (CEN) UBL schema and Schematron 1.3.16** and the
**KoSIT XRechnung Schematron 2.6.0 (XRechnung 3.0)** with an independent re-implementation of the validator (Summand), for:
21 % VAT, intra-community 0 % (K), reverse charge (AE), credit note, prepayment with rounding, and a USD invoice with the VAT also
in EUR. It is **not** the KoSIT reference validator itself. **Before the first real submission, validate one file with the KoSIT
validator or the authority portal's own check** (for example the free validators offered by the portals); if it reports
something, send the message and the app is adjusted.

## Not included

- The invoice **PDF is not embedded** (no ZUGFeRD/Factur-X; XRechnung is pure XML). Send the PDF separately if the authority wants one.
- Document-level discounts are expected to be in the item lines' net amounts (ERPNext distributes them); separate surcharge rows are refused.
- No Peppol transmission, no CII syntax, no extension profile, no Skonto structure (payment terms are written as text).
- The Leitweg-ID typed in the app is used for the file only; it is not written back to the invoice in ERPNext.
