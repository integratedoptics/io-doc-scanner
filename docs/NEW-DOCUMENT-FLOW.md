# New document flow (test server) — IO Doc Scanner 1.4

The app now has two ways of filing a scanned document. They run side by side.

| | Old way (unchanged) | New way |
|---|---|---|
| Server | the live ERPNext (address and login in Settings) | the backup / test ERPNext (**Test server address** in Settings, same login) |
| Where documents go | one doctype, **Accounts Document** | the doctype each document really is |

Leave the test server address empty and the app behaves exactly as before.

## What goes where

| Document | Test server |
|---|---|
| Purchase invoice, shipping / courier invoice, customs-broker (CD) invoice | **Purchase Invoice** with its item lines (draft) |
| Waybill / airwaybill | **Purchase Receipt**, made from the Purchase Order that carries the AWB number; the waybill is attached to it (draft) |
| Supplier quotation (new document type) | **Supplier Quotation** with its item lines (draft). Test server only — there is no old-way equivalent |
| Customs declaration | not filed (no doctype yet) — old way only |
| Proforma invoice, sales invoice, payment order, other papers | old way only |

Documents are created as drafts; nothing is submitted.

## Sending to both

Under the recognised fields, a **Send to** block has two switches: *live server (Accounts Document)* and *test server*. Both are on by default, so one tap on **Approve** files the document both ways. The live part runs first. If the test part then fails, the form stays open with the live switch turned off, so you can fix the problem and press Approve again without filing it twice on the live server.

## Item lines (invoices and quotations)

The AI (Anthropic key in Settings) reads every line: item code, description, quantity, unit price, PO. Edit, add or remove lines in the list. Each line is matched to the ERPNext Items **by item code only**:

* **green, 100 %** — the code exists; used as is.
* **orange, 90–99 %** — a close code (typo, spaces or dashes). Switch **Use** (the closest item, or pick another from the list) or **Create new**. *Use* is preselected.
* **red, under 90 %** — no such item. **Create new** is preselected (item code and name editable); *Use* lets you pick one of the closest.

"Create new" creates the Item first (Item Group and Stock UOM from Settings), then the document that uses it. Lines without an item code (courier charges) use the **Item for lines without a code** from Settings, if set; otherwise they become new items.

**Purchase Order check.** The PO numbers on the document (and per line) are looked up on the test server. Each line shows: ordered quantity, received so far, and this document's quantity — highlighted when the document delivers more than is still open or the price differs from the order. Matched lines are linked to the PO line in the invoice.

**Quantity price breaks (quotations).** One line per quantity tier — the same item repeated, each with its quantity and price — becomes several rows of the Supplier Quotation.

## Waybills

The AWB number is read from the waybill and searched in the *Tracking AWB* field of the Purchase Orders on the test server. Tick the order(s) to receive (one Purchase Receipt per order); you can also type a Purchase Order. The receipt is created with ERPNext's own *Create → Purchase Receipt* (all open quantities of the order), the AWB is written into it, and the waybill is attached. If a Purchase Receipt with that AWB already exists, the waybill is attached to it and no new receipt is made.

## Settings (Test server — new document flow)

Test server address · Item group for new items · Stock UOM for new items (default Nos) · Item for lines without a code (optional) · Company (optional, only if the server has several) · Purchase taxes template (optional) · **Test the test server** button.

## Notes and assumptions

* Posting date = the document date. The document number becomes *Supplier Invoice No* (`bill_no`), so ERPNext refuses a number already used by that supplier.
* The supplier must already exist on the test server (matched by name, registration / VAT code, or the same name apart from spelling and legal form). Suppliers are not created.
* The names of the *Scanned Invoice* and *Tracking AWB* fields are looked up on the server (the customize form only shows them cut off).
* Without a taxes template ERPNext computes the invoice net of VAT; the app compares the ERPNext total with the document's and says if they differ.
