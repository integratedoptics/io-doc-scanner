/* test_docrules.js — the offline EN/LT/DE document reader (docrules.js).
   Fixture 1 is the text pdf.js really extracted from a real Lithuanian VAT
   invoice (tests/fixtures/lt-purchase-invoice.pdfjs.txt); the others are
   small synthetic German and English invoices. Run: node tests/test_docrules.js */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/docrules.js");
var sb = { window: {}, console: console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(file, "utf8"), sb, { filename: file });
var R = sb.window.CS_RULES;

var fails = 0;
function eq(label, got, want) {
	var ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) fails++;
	console.log((ok ? "ok   " : "FAIL ") + label + (ok ? "" : "   got " + JSON.stringify(got) + "  want " + JSON.stringify(want)));
}

/* ---- 1. the real Lithuanian invoice */
var lt = R.parse(fs.readFileSync(path.join(__dirname, "fixtures/lt-purchase-invoice.pdfjs.txt"), "utf8"));
eq("LT type", lt.doc_type, "purchase_invoice");
eq("LT number (series E + no. 202604-122)", lt.document_no, "E202604-122");
eq("LT date (2026 m. balandžio 22 d.)", lt.document_date, "2026-04-22");
eq("LT due (2026 m. gegužės 22 d.)", lt.payment_due_date, "2026-05-22");
eq("LT supplier is the seller, not the buyer", lt.supplier_name, "ESEMDA, UAB");
eq("LT supplier reg no. (not ours)", lt.supplier_reg_number, "125816838");
eq("LT supplier VAT (not ours)", lt.supplier_tax_id, "LT258168314");
eq("LT purchase orders", lt.purchase_order_reference, "PO-07917, PO-07808");
eq("LT currency", lt.currency, "EUR");
eq("LT total (gross, not the net 3187.10)", lt.total_amount, 3856.39);
eq("LT language", lt.language, "lt");

/* ---- 2. German */
var de = R.parse("Müller Optik GmbH Hauptstraße 12 80331 München USt-IdNr.: DE123456789 Handelsregister: HRB 123456 " +
	"Rechnung Rechnungsnummer: RE-2026-0456 Rechnungsdatum: 15. März 2026 Zahlbar bis: 14.04.2026 " +
	"Rechnungsempfänger: Integrated Optics UAB Kalvarijų g. 125B Ihre Bestellung: PO-07808 " +
	"Pos. Beschreibung Menge Preis Gesamt 1 Linse 100 Stk 12,50 € 1.250,00 Zwischensumme (netto): 1.250,00 " +
	"USt 19 %: 237,50 Gesamtbetrag: 1.487,50 EUR");
eq("DE type", de.doc_type, "purchase_invoice");
eq("DE number", de.document_no, "RE-2026-0456");
eq("DE date (15. März 2026)", de.document_date, "2026-03-15");
eq("DE due (14.04.2026)", de.payment_due_date, "2026-04-14");
eq("DE supplier keeps its umlaut", de.supplier_name, "Müller Optik GmbH");
eq("DE VAT", de.supplier_tax_id, "DE123456789");
eq("DE register no.", de.supplier_reg_number, "HRB 123456");
eq("DE PO", de.purchase_order_reference, "PO-07808");
eq("DE total (1.487,50 = 1487.50)", de.total_amount, 1487.5);
eq("DE currency", de.currency, "EUR");
eq("DE language", de.language, "de");

/* ---- 3. English */
var en = R.parse("INVOICE Invoice No: INV-2026-0099 Invoice Date: April 22, 2026 Due Date: May 22, 2026 " +
	"From: Acme Photonics Ltd Company Reg No: 12345678 VAT No: GB123456789 " +
	"Bill To: Integrated Optics UAB PO Number: PO-07917 Subtotal USD 1,000.00 VAT 20% 200.00 Total Amount Due: USD 1,200.00");
eq("EN type", en.doc_type, "purchase_invoice");
eq("EN number", en.document_no, "INV-2026-0099");
eq("EN date", en.document_date, "2026-04-22");
eq("EN due", en.payment_due_date, "2026-05-22");
eq("EN supplier", en.supplier_name, "Acme Photonics Ltd");
eq("EN reg", en.supplier_reg_number, "12345678");
eq("EN VAT", en.supplier_tax_id, "GB123456789");
eq("EN total", en.total_amount, 1200);
eq("EN currency", en.currency, "USD");

/* ---- 4. document kinds in the three languages */
function type(s) { return R.parse(s).doc_type; }
eq("LT proforma", type("Išankstinė sąskaita faktūra Nr. IS-12 Data: 2026-01-05 Pardavėjas: Foo, UAB"), "proforma_invoice");
eq("DE proforma", type("Proforma-Rechnung Nr. 55 Datum: 05.01.2026 Foo GmbH"), "proforma_invoice");
eq("LT customs declaration", type("MUITINĖS DEKLARACIJA Importo deklaracija MRN 26LT123456789012345"), "customs_declaration");
eq("DE customs declaration", type("Einfuhranmeldung Zollanmeldung MRN 26DE1234567890123"), "customs_declaration");
eq("EN customs declaration", type("Customs declaration - Single Administrative Document"), "customs_declaration");
eq("DE freight invoice", type("Frachtrechnung Nr. 4711 Speditionsrechnung Spedition Schmidt GmbH"), "shipping_invoice");
eq("LT shipping invoice", type("PVM sąskaita faktūra Nr. 12 Krovinio gabenimo paslaugos Transporto UAB"), "shipping_invoice");
eq("EN customs broker invoice", type("Invoice 123 customs clearance fee - customs broker services"), "cd_invoice");

/* ---- 5. numbers and dates */
var I = R._internals;
eq("1.234,56", I.parseAmount("1.234,56"), 1234.56);
eq("1,234.56", I.parseAmount("1,234.56"), 1234.56);
eq("3 856,39", I.parseAmount("3 856,39"), 3856.39);
eq("3856.39", I.parseAmount("3856.39"), 3856.39);
eq("3.9500", I.parseAmount("3.9500"), 3.95);
eq("1.234 (thousands)", I.parseAmount("1.234"), 1234);
eq("12,50", I.parseAmount("12,50"), 12.5);
function d1(s) { var d = I.findDates(I.fold(s)); return d.length ? d[0].iso : null; }
eq("LT rugsėjo", d1("2026 m. rugsėjo 3 d."), "2026-09-03");
eq("LT rugpjūčio", d1("2026 m. rugpjūčio 31 d."), "2026-08-31");
eq("LT gruodžio", d1("2025 m. gruodžio 1 d."), "2025-12-01");
eq("DE Dezember", d1("1. Dezember 2025"), "2025-12-01");
eq("DE Mai", d1("12. Mai 2026"), "2026-05-12");
eq("EN 22nd April", d1("22nd April 2026"), "2026-04-22");
eq("ISO", d1("2026-04-22"), "2026-04-22");
eq("dd.mm.yy", d1("22.04.26"), "2026-04-22");

/* ---- 6. text quality (scans / broken fonts) */
eq("real text is usable", R.textQuality(fs.readFileSync(path.join(__dirname, "fixtures/lt-purchase-invoice.pdfjs.txt"), "utf8")).ok, true);
eq("empty text is not", R.textQuality("").ok, false);
eq("a few characters are not", R.textQuality("  1  \n\n ").ok, false);
eq("garbled glyphs are not", R.textQuality(new Array(200).join("\u0001\u0002� «» ")).ok, false);

/* ---- 7. our own company is never the supplier */
var own = R.parse("PVM sąskaita faktūra Nr. 1 Data: 2026-04-22 Pirkėjas: Integrated Optics UAB Įmonės kodas: 302833442 Suma, EUR: 10.00");
eq("buyer-only text yields no supplier", own.supplier_name, null);
eq("own codes are never taken", own.supplier_reg_number, null);

/* ---- 8. sales documents: we are the issuer, the other party is the customer */
var sale = R.parse("PVM sąskaita faktūra Serija IO Nr. 2026-117 Data: 2026 m. gegužės 2 d. Apmokėti iki: 2026-06-01 " +
	"Pardavėjas: Integrated Optics UAB Įmonės kodas: 302833442 PVM mokėtojo kodas: LT100007179012 " +
	"Pirkėjas: Photon Systems GmbH Įmonės kodas: HRB 556677 PVM kodas: DE811234567 Užsakymo Nr. PO-4411 Suma, EUR: 1 210,00");
eq("sale: type", sale.doc_type, "sales_invoice");
eq("sale: issued by us (UAB)", [sale.issuer_is_ours, sale.issuer_entity], [true, "UAB"]);
eq("sale: no supplier", [sale.supplier_name, sale.supplier_reg_number, sale.supplier_tax_id], [null, null, null]);
eq("sale: customer", sale.customer_name, "Photon Systems GmbH");
eq("sale: customer VAT (not ours)", sale.customer_tax_id, "DE811234567");
eq("sale: number, date, total", [sale.document_no, sale.document_date, sale.total_amount], ["IO2026-117", "2026-05-02", 1210]);

var inter = R.parse("Sąskaita faktūra Nr. IO-55 Data: 2026-06-10 Pardavėjas: Integrated Optics UAB Įmonės kodas: 302833442 " +
	"Pirkėjas: IO Integrated Optics GmbH USt-IdNr.: DE123456789 Suma, EUR: 500,00");
eq("intercompany: UAB sells to GmbH", [inter.doc_type, inter.issuer_entity, inter.customer_name, inter.customer_tax_id],
	["sales_invoice", "UAB", "IO Integrated Optics GmbH", "DE123456789"]);
eq("intercompany is flagged in the notes", /between our own companies/.test(inter.notes), true);

/* the GmbH is an ordinary counterparty: it bills UAB -> a purchase, supplier = the GmbH with its own codes */
var g2u = R.parse("Rechnung Rechnungsnummer: 2026-001 Rechnungsdatum: 03.06.2026 Verkäufer: IO Integrated Optics GmbH Hauptstraße 1 " +
	"Handelsregister: HRB 37938 USt-IdNr.: DE355412240 Rechnungsempfänger: Integrated Optics UAB Įmonės kodas: 302833442 PVM kodas: LT100007179012 Gesamtbetrag: 1.190,00 EUR");
eq("GmbH bills UAB: purchase with the GmbH as supplier", [g2u.doc_type, g2u.issuer_is_ours, g2u.supplier_name, g2u.supplier_reg_number, g2u.supplier_tax_id, g2u.customer_name],
	["purchase_invoice", false, "IO Integrated Optics GmbH", "HRB 37938", "DE355412240", null]);
eq("GmbH bills UAB: noted as from the subsidiary", /subsidiary IO Integrated Optics GmbH to UAB/.test(g2u.notes), true);
var g2u2 = R.parse("Invoice No. G-5 Date: 2026-08-01 IO Integrated Optics GmbH HRB 37938 USt-IdNr. DE355412240 Integrated Optics UAB Company code 302833442 Total: 10.00 EUR");
eq("unlabelled GmbH + UAB: UAB is the buyer", [g2u2.issuer_is_ours, g2u2.supplier_name], [false, "IO Integrated Optics GmbH"]);
var gsale = R.parse("Rechnung Rechnungsnummer: 2026-002 Rechnungsdatum: 03.06.2026 Verkäufer: IO Integrated Optics GmbH Hauptstraße 1 " +
	"USt-IdNr.: DE355412240 Rechnungsempfänger: Acme Photonics Ltd VAT No: GB123456789 Gesamtbetrag: 1.190,00 EUR");
eq("GmbH bills a third party: not a UAB document, flagged", [gsale.issuer_is_ours, /not a UAB document/.test(gsale.notes)], [false, true]);

var proforma = R.parse("Proforma invoice No. PF-9 Date: 2026-07-01 Seller: Integrated Optics UAB Buyer: Foo Oy VAT: FI12345678 Total: EUR 99.00");
eq("proforma issued by UAB keeps its kind and finds the customer", [proforma.doc_type, proforma.issuer_is_ours, proforma.customer_name],
	["proforma_invoice", true, "Foo Oy"]);
eq("isUabName: UAB yes, GmbH no, bare name yes", [R.isUabName("Integrated Optics UAB"), R.isUabName("IO Integrated Optics GmbH"), R.isUabName("Integrated Optics")], [true, false, true]);

/* unlabelled letterhead: the Sales Invoice choice breaks the tie, otherwise we are the buyer */
var bare = "Integrated Optics UAB Company code: 302833442 Foo Optics UAB Company code: 111222333 Invoice No. A-1 Date: 2026-01-05 Total: 10.00 EUR";
eq("unlabelled, no hint: we are the buyer, the other company is the supplier", [R.parse(bare).issuer_is_ours, R.parse(bare).supplier_name], [false, "Foo Optics UAB"]);
eq("unlabelled + Sales Invoice chosen: we issued it", [R.parse(bare, "sales_invoice").issuer_is_ours, R.parse(bare, "sales_invoice").customer_name], [true, "Foo Optics UAB"]);
eq("unlabelled is flagged", /no seller\/buyer labels/.test(R.parse(bare).notes), true);

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
