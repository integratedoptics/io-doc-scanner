/* test_sets.js — the offline reader on the pdf.js text of the nine example documents
   (three sets: PURCHASE- PO-08258, SALES- IO26-02602, PROFORMA- PO-08353). The scanned waybill
   image has no text and is not here. Fixtures contain bank details: private repo only. */
"use strict";
var fs = require("fs"), path = require("path");
global.window = global;
require(path.join(__dirname, "../android/CardScanner/app/src/main/assets/docrules.js"));
var R = window.CS_RULES, dir = path.join(__dirname, "fixtures/sets/");
var fails = 0;
function eq(l, got, want) { var ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + l + (ok ? "" : "   got " + JSON.stringify(got) + " want " + JSON.stringify(want))); }
function read(n, hint) { return R.parse(fs.readFileSync(dir + n + ".pdfjs.txt", "utf8"), hint); }
function pick(r, keys) { var o = {}; keys.forEach(function (k) { o[k] = r[k]; }); return o; }

var a = read("purchase-commercial-invoice", "purchase_invoice");
eq("commercial invoice", pick(a, ["doc_type", "document_no", "document_date", "supplier_name", "purchase_order_reference", "currency", "total_amount", "issuer_is_ours"]),
	{ doc_type: "purchase_invoice", document_no: "20260730-FG394", document_date: "2026-08-22", supplier_name: "SHENZHEN FLYGOLD CIRCUIT CO.,LIMITED",
		purchase_order_reference: "PO-08258", currency: "USD", total_amount: 726, issuer_is_ours: false });

var b = read("purchase-dhl-clearance-invoice", "purchase_invoice");
eq("DHL clearance invoice", pick(b, ["doc_type", "document_no", "document_date", "payment_due_date", "supplier_name", "supplier_reg_number", "supplier_tax_id", "total_amount", "currency"]),
	{ doc_type: "cd_invoice", document_no: "VS396551", document_date: "2026-08-26", payment_due_date: "2026-09-15", supplier_name: "UAB DHL LIETUVA",
		supplier_reg_number: "111529785", supplier_tax_id: "LT115297811", total_amount: 48.4, currency: "EUR" });
eq("DHL invoice cites the declaration", b.related_references.indexOf("26LTVA100025C7F4R1") >= 0, true);

var c = read("purchase-import-declaration", "customs_declaration");
eq("import declaration: MRN, date, PO and the numbers that link it", pick(c, ["doc_type", "document_no", "document_date", "purchase_order_reference", "needs_file", "supplier_name"]),
	{ doc_type: "customs_declaration", document_no: "26LTVA100025C7F4R1", document_date: "2026-08-26", purchase_order_reference: "PO-08258", needs_file: true, supplier_name: null });
eq("import declaration lists waybill and invoice no.", [c.related_references.indexOf("5554865912") >= 0, c.related_references.indexOf("20260730-FG394") >= 0], [true, true]);

var d = read("sales-invoice", "sales_invoice");
eq("sales invoice", pick(d, ["doc_type", "document_no", "document_date", "payment_due_date", "customer_name", "issuer_is_ours", "purchase_order_reference", "currency", "total_amount"]),
	{ doc_type: "sales_invoice", document_no: "IO26-02602", document_date: "2026-09-23", payment_due_date: "2026-09-23", customer_name: "UniNanoTech Co., Ltd",
		issuer_is_ours: true, purchase_order_reference: null, currency: "EUR", total_amount: 4740 });
eq("sales invoice: customer PO, sales order and proforma are references, not a PO of ours", ["UNI-26387", "SO-02810", "PIN-00862"].every(function (x) { return d.related_references.indexOf(x) >= 0; }), true);
eq("sales invoice mentioning a proforma is not itself a proforma", read("sales-invoice", "").doc_type, "sales_invoice");

var e = read("sales-export-declaration", "customs_declaration");
eq("export declaration", pick(e, ["doc_type", "document_no", "document_date", "needs_file"]),
	{ doc_type: "customs_declaration", document_no: "26LTKA1003145431B0", document_date: "2026-09-23", needs_file: true });
eq("export declaration cites the invoice and the tracking number", [e.related_references.indexOf("IO26-02602") >= 0, e.related_references.indexOf("877621665538") >= 0], [true, true]);

var f = read("sales-fedex-label", "");
eq("courier label is an attachment with its tracking number", [f.doc_type, f.attachment_kind, f.related_references.indexOf("877621665538") >= 0, f.document_date], ["attachment", "waybill", true, "2026-09-23"]);

var g = read("proforma-supplier-invoice", "proforma_invoice");
eq("supplier proforma", pick(g, ["doc_type", "document_no", "document_date", "supplier_name", "purchase_order_reference", "currency", "total_amount"]),
	{ doc_type: "proforma_invoice", document_no: "BST260915-B17720", document_date: "2026-09-15", supplier_name: "SHENZHEN BEST PARTS CO., LTD",
		purchase_order_reference: "PO-08353", currency: "USD", total_amount: 457 });
eq("same text without the employee's choice: purchase, with an advance-payment hint", [read("proforma-supplier-invoice", "").doc_type, /advance payment/.test(read("proforma-supplier-invoice", "").notes)], ["purchase_invoice", true]);

/* a payment order as pdf.js + form-field values give it */
var pay = R.parse("Mokėjimo nurodymas Nr. Payment Order No. 2026-09-16 457.00 USD INTEGRATED OPTICS, UAB BEST PARTS CO.,LIMITED Payment for purchase order No. PO-08353, BST260915-B17720", "");
eq("payment order is an attachment and finds the PO", [pay.doc_type, pay.attachment_kind, pay.purchase_order_reference], ["attachment", "payment_order", "PO-08353"]);

/* PO spellings */
["PO:08353", "PO-08353", "PO 08353", "P.O. 08353", "PO08353", "po: 08353"].forEach(function (s) {
	eq("PO spelling " + s, R._internals.findPurchaseOrders(R._internals.fold("Ref " + s + " end")), ["PO-08353"]);
});

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
