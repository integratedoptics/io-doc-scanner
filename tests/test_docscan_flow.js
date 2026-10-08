/* test_docscan_flow.js — the Documents screen end to end, in a simulated page:
   the real index.html, docrules.js and docscan.js, with the PDF reader, the AI
   call and ERPNext stubbed. Uses the text pdf.js extracted from a real
   Lithuanian invoice. Needs jsdom (not a dependency of the app):
       npm install --prefix /tmp/jsd jsdom && JSDOM_PATH=/tmp/jsd/node_modules/jsdom node tests/test_docscan_flow.js */
"use strict";
var fs = require("fs"), path = require("path");
var JSDOM;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; }
catch (e) { console.log("skipped: jsdom is not installed (set JSDOM_PATH)"); process.exit(0); }

var A = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var html = fs.readFileSync(A + "index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
var rulesSrc = fs.readFileSync(A + "docrules.js", "utf8"), scanSrc = fs.readFileSync(A + "docscan.js", "utf8");
var TEXT = fs.readFileSync(path.join(__dirname, "fixtures/lt-purchase-invoice.pdfjs.txt"), "utf8");

var fails = 0;
function check(l, c, extra) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (extra || ""))); }
function tick() { return new Promise(function (r) { setTimeout(r, 15); }); }
async function settle() { for (var i = 0; i < 8; i++) await tick(); }

function page(opts) {
	var dom = new JSDOM(html, { runScripts: "outside-only" });
	var w = dom.window, calls = { text: [], file: [] };
	w.CS = { settings: function () { return { extract_key: opts.key || "" }; } };
	w.CS_PDF = { extractText: function () { return Promise.resolve({ text: opts.pdfText === undefined ? TEXT : opts.pdfText, pages: 1 }); } };
	w.CS_EXTRACT = {
		ready: function (s) { return s && s.key ? "" : "no key"; },
		extractFields: function (t, s, h) { calls.text.push({ t: t, h: h }); return opts.ai ? opts.ai(t) : Promise.reject(new Error("no ai")); },
		extractFromFile: function (d, s, h, t) { calls.file.push({ d: d, h: h, t: t, s: s }); return opts.ai ? opts.ai(d) : Promise.reject(new Error("no ai")); }
	};
	w.CS_ACC = { findExactSupplier: function () { return Promise.resolve(null); }, findSupplierMatches: function () { return Promise.resolve([]); },
		suggestParents: function () { return Promise.resolve([]); } };
	if (opts.acc) Object.keys(opts.acc).forEach(function (k) { w.CS_ACC[k] = opts.acc[k]; });
	w.CS_ACC._internals = { normPo: function (v) { var m = /^P\.?O\.?[-\s#:]*(\d[A-Za-z0-9\-]*)$/i.exec(String(v || "").trim()); return m ? "PO-" + m[1] : String(v || "").trim(); } };
	if (opts.customers) w.CS_ACC.findCustomerMatches = function (n, codes) { calls.cust = { n: n, codes: codes }; return Promise.resolve(opts.customers); };
	w.CS_ERP = { ready: function () { return ""; } };
	w.Android = opts.android || {};
	w.eval(rulesSrc); w.eval(scanSrc);
	w.CS_DOCSCAN.init();
	return { w: w, d: w.document, calls: calls, v: function (id) { return w.document.getElementById(id).value; } };
}

(async function () {
	var PDF = "data:application/pdf;base64,QUJD", JPG = "data:image/jpeg;base64,QUJD";

	/* 1. no key: the offline reader fills the form from the real Lithuanian invoice */
	var p = page({});
	p.w.onDocPicked({ ok: true, name: "E202604-122_1021.pdf", dataUrl: PDF });
	await settle();
	check("no key: type", p.v("d-type") === "purchase_invoice");
	check("no key: number", p.v("d-document_no") === "E202604-122", p.v("d-document_no"));
	check("no key: date", p.v("d-document_date") === "2026-04-22");
	check("no key: due", p.v("d-payment_due_date") === "2026-05-22");
	check("no key: supplier", p.v("d-supplier_name") === "ESEMDA, UAB", p.v("d-supplier_name"));
	check("no key: reg + VAT", p.v("d-supplier_reg_number") === "125816838" && p.v("d-supplier_tax_id") === "LT258168314");
	check("no key: PO", p.v("d-purchase_order_reference") === "PO-07917, PO-07808");
	check("no key: currency + total", p.v("d-currency") === "EUR" && p.v("d-total_amount") === "3856.39");
	check("no key: says it was the built-in reader", /built-in reader/.test(p.d.getElementById("d-warn").textContent));
	check("no key: the AI was not called", p.calls.text.length === 0 && p.calls.file.length === 0);
	check("no key: language shown", /Lithuanian/.test(p.d.getElementById("d-notes").textContent));

	/* 2. key: the AI names OUR company as supplier (the classic mistake) -> the seller is kept */
	p = page({ key: "k", ai: function () { return Promise.resolve({ fields: { doc_type: "purchase_invoice", document_no: "E202604-122",
		document_date: "2026-04-22", supplier_name: "Integrated Optics UAB", supplier_reg_number: "302833442",
		supplier_tax_id: "LT100007179012", total_amount: 3856.39, currency: "EUR", confidence: 0.9, notes: "", language: "lt" } }); } });
	p.w.onDocPicked({ ok: true, name: "a.pdf", dataUrl: PDF });
	await settle();
	check("a PDF with a text layer goes to the AI as the file, with its text beside it", p.calls.file.length === 1 && p.calls.text.length === 0 && p.calls.file[0].d === PDF && p.calls.file[0].t === TEXT);
	check("AI wrong supplier is replaced by the seller", p.v("d-supplier_name") === "ESEMDA, UAB", p.v("d-supplier_name"));
	check("our own codes are not used", p.v("d-supplier_reg_number") === "125816838" && p.v("d-supplier_tax_id") === "LT258168314");
	check("the correction is explained", /replaced by the seller/.test(p.d.getElementById("d-notes").textContent));

	/* 3. key: the AI leaves fields empty -> the offline reader fills the gaps */
	p = page({ key: "k", ai: function () { return Promise.resolve({ fields: { supplier_name: "ESEMDA, UAB", document_no: null, total_amount: null, confidence: 0.4 } }); } });
	p.w.onDocPicked({ ok: true, name: "a.pdf", dataUrl: PDF });
	await settle();
	check("gaps in the AI answer are filled by the rules", p.v("d-document_no") === "E202604-122" && p.v("d-total_amount") === "3856.39");

	/* 4. key: AI fails -> the offline result stays, with a clear message */
	p = page({ key: "k" });
	p.w.onDocPicked({ ok: true, name: "a.pdf", dataUrl: PDF });
	await settle();
	check("AI failure keeps the offline reading", p.v("d-supplier_name") === "ESEMDA, UAB" && p.v("d-document_no") === "E202604-122");
	check("AI failure is reported", /no ai/.test(p.d.getElementById("d-warn").textContent) && /built-in reader found/.test(p.d.getElementById("d-warn").textContent));

	/* 5. scanned PDF (no text layer) with a key -> the PDF itself goes to the AI */
	p = page({ key: "k", pdfText: "  ", ai: function () { return Promise.resolve({ fields: { document_no: "S-1", supplier_name: "Foo GmbH", language: "de" } }); } });
	p.w.onDocPicked({ ok: true, name: "scan.pdf", dataUrl: PDF });
	await settle();
	check("scan: the file is sent, not the empty text", p.calls.file.length === 1 && p.calls.file[0].d === PDF && p.calls.text.length === 0);
	check("scan: AI fields land in the form", p.v("d-document_no") === "S-1" && p.v("d-supplier_name") === "Foo GmbH");

	/* 6. scanned PDF without a key */
	p = page({ pdfText: "" });
	p.w.onDocPicked({ ok: true, name: "scan.pdf", dataUrl: PDF });
	await settle();
	check("scan without key: explains what to do", /no readable text/.test(p.d.getElementById("d-warn").textContent) && /Anthropic key/.test(p.d.getElementById("d-warn").textContent));

	/* 7. photo with a key: sent as a picture, preview shown */
	p = page({ key: "k", ai: function () { return Promise.resolve({ fields: { document_no: "P-9", supplier_name: "Acme Ltd", currency: "GBP", total_amount: 10 } }); } });
	p.w.onDocPicked({ ok: true, name: "document-1.jpg", dataUrl: JPG });
	await settle();
	check("photo: sent to the AI as a file", p.calls.file.length === 1 && p.calls.file[0].d === JPG);
	check("photo: preview is visible", p.d.getElementById("d-preview").style.display !== "none" && p.d.getElementById("d-preview").getAttribute("src") === JPG);
	check("photo: fields filled", p.v("d-document_no") === "P-9" && p.v("d-currency") === "GBP");

	/* 8. photo without a key */
	p = page({});
	p.w.onDocPicked({ ok: true, name: "document-1.jpg", dataUrl: JPG });
	await settle();
	check("photo without key: asks for the key", /Anthropic key/.test(p.d.getElementById("d-warn").textContent));

	/* 9. Android hands the file over through readPickedDocument() */
	p = page({ android: { readPickedDocument: function () { return PDF; } } });
	p.w.onDocPicked({ ok: true, name: "native.pdf" });
	await settle();
	check("Android two-step hand-over works", p.v("d-document_no") === "E202604-122" && p.d.getElementById("d-file-name").textContent === "native.pdf");

	/* 10. a cancelled or failed pick */
	p = page({});
	p.w.onDocPicked({ ok: false, error: "No file chosen." });
	check("cancel shows the message", p.d.getElementById("d-file-name").textContent === "No file chosen.");

	/* 11. buttons */
	var opened = 0;
	p = page({ android: { pickDocument: function () { opened++; }, captureDocument: function () { opened += 10; } } });
	check("photo button is shown when the shell can capture", p.d.getElementById("btn-doc-photo").style.display !== "none");
	p.d.getElementById("btn-doc-pick").click(); p.d.getElementById("btn-doc-photo").click();
	check("pick and capture reach the native bridge", opened === 11);
	p = page({});
	check("no camera, no photo button", p.d.getElementById("btn-doc-photo").style.display === "none");
	p = page({}); p.w.CS_CAMERA = { available: function () { return true; }, open: function () { return Promise.resolve(JPG); } };
	p.w.CS_DOCSCAN.init();
	p.d.getElementById("btn-doc-photo").click();
	await settle();
	check("webcam path: captured picture is accepted", /^document-\d+\.jpg$/.test(p.d.getElementById("d-file-name").textContent));

	/* 12. sales invoices: we issue, the customer is matched against ERPNext */
	var SALE = "Pardavėjas: Integrated Optics UAB Įmonės kodas: 302833442 PVM kodas: LT100007179012 " +
		"PVM SĄSKAITA FAKTŪRA Serija IO Nr. 1001 2026-06-02 Pirkėjas: Photon Systems GmbH Įmonės kodas: HRB 556677 " +
		"PVM kodas: DE811234567 Suma, EUR: 1 210,00";
	var C = function (name, cname, score, code) { return { customer: { name: name, customer_name: cname }, score: score, codeMatch: !!code }; };
	p = page({ pdfText: SALE, customers: [C("Photon Systems GmbH", "Photon Systems GmbH", 1, true), C("Photon Systems AG", "Photon Systems AG", 0.7)] });
	p.w.onDocPicked({ ok: true, name: "s.pdf", dataUrl: PDF });
	await settle();
	check("sale: type is sales invoice", p.v("d-type") === "sales_invoice", p.v("d-type"));
	check("sale: series SALES-", p.v("d-naming_series") === "SALES-", p.v("d-naming_series"));
	check("sale: customer read", p.v("d-customer_name") === "Photon Systems GmbH" && p.v("d-customer_tax_id") === "DE811234567", p.v("d-customer_name"));
	check("sale: supplier block hidden, customer block shown", p.d.getElementById("d-box-supplier").style.display === "none" &&
		p.d.getElementById("d-box-customer").style.display !== "none");
	check("sale: no supplier filled in", p.v("d-supplier_name") === "");
	check("sale: both codes offered to the matcher", p.calls.cust && p.calls.cust.codes.indexOf("DE811234567") >= 0);
	check("sale: code match is picked automatically", /Customer in ERPNext/.test(p.d.getElementById("d-cust-box").textContent) &&
		/Photon Systems GmbH/.test(p.d.getElementById("d-cust-box").textContent));
	check("sale: issuer shown", /Issued by Integrated Optics UAB/.test(p.d.getElementById("d-issuer-note").textContent));

	/* ambiguous match: the closest customers are listed, nothing is chosen for the employee */
	p = page({ pdfText: SALE, customers: [C("Photon Systems A", "Photon Systems A", 0.66), C("Photon Sys", "Photon Sys", 0.62)] });
	p.w.onDocPicked({ ok: true, name: "s.pdf", dataUrl: PDF });
	await settle();
	check("sale: weak matches are offered, not auto-picked", p.d.querySelectorAll("#d-cust-box [data-cust]").length === 2 &&
		!/Customer in ERPNext/.test(p.d.getElementById("d-cust-box").textContent));
	p.d.querySelector("#d-cust-box [data-cust]").click();
	check("sale: choosing one links it", /Customer in ERPNext/.test(p.d.getElementById("d-cust-box").textContent) &&
		/Photon Systems A/.test(p.d.getElementById("d-cust-box").textContent));

	/* no similar customer */
	p = page({ pdfText: SALE, customers: [] });
	p.w.onDocPicked({ ok: true, name: "s.pdf", dataUrl: PDF });
	await settle();
	check("sale: no similar customer says so", /No similar customer/.test(p.d.getElementById("d-cust-box").textContent));

	/* intercompany: UAB bills the GmbH */
	var INTER = "Pardavėjas: Integrated Optics UAB Įmonės kodas: 302833442 PVM kodas: LT100007179012 Sąskaita faktūra Nr. IO-77 " +
		"Data: 2026-07-01 Pirkėjas: IO Integrated Optics GmbH USt-IdNr.: DE123456789 Suma, EUR: 500,00";
	p = page({ pdfText: INTER, customers: [C("IO Integrated Optics GmbH", "IO Integrated Optics GmbH", 1, true)] });
	p.w.onDocPicked({ ok: true, name: "i.pdf", dataUrl: PDF });
	await settle();
	check("intercompany: sales invoice to the GmbH", p.v("d-type") === "sales_invoice" && p.v("d-customer_name") === "IO Integrated Optics GmbH", p.v("d-customer_name"));
	check("intercompany: flagged", /intercompany/.test(p.d.getElementById("d-issuer-note").textContent));

	/* GmbH bills UAB: a purchase from the GmbH, with the GmbH's own codes; the AI naming the GmbH is NOT "our company" */
	var G2U = "Rechnung Rechnungsnummer: 2026-001 Rechnungsdatum: 03.06.2026 Verkäufer: IO Integrated Optics GmbH Hauptstraße 1 " +
		"Handelsregister: HRB 37938 USt-IdNr.: DE355412240 Rechnungsempfänger: Integrated Optics UAB Įmonės kodas: 302833442 Gesamtbetrag: 1.190,00 EUR";
	p = page({ pdfText: G2U });
	p.w.onDocPicked({ ok: true, name: "g.pdf", dataUrl: PDF });
	await settle();
	check("GmbH->UAB: purchase invoice from the GmbH", p.v("d-type") === "purchase_invoice" && p.v("d-supplier_name") === "IO Integrated Optics GmbH" &&
		p.v("d-supplier_tax_id") === "DE355412240" && p.v("d-supplier_reg_number") === "HRB 37938", p.v("d-type") + "/" + p.v("d-supplier_name"));
	check("GmbH->UAB: supplier block shown, series PURCHASE-", p.d.getElementById("d-box-supplier").style.display !== "none" && p.v("d-naming_series") === "PURCHASE-");
	p = page({ key: "k", pdfText: G2U, ai: function () { return Promise.resolve({ fields: { doc_type: "purchase_invoice", document_no: "2026-001",
		supplier_name: "IO Integrated Optics GmbH", supplier_tax_id: "DE355412240", customer_name: "Integrated Optics UAB", issuer_is_ours: false } }); } });
	p.w.onDocPicked({ ok: true, name: "g.pdf", dataUrl: PDF });
	await settle();
	check("GmbH->UAB with AI: the GmbH stays the supplier", p.v("d-supplier_name") === "IO Integrated Optics GmbH" && p.v("d-supplier_tax_id") === "DE355412240" &&
		!/our own company/.test(p.d.getElementById("d-notes").textContent), p.v("d-supplier_name") + " | " + p.d.getElementById("d-notes").textContent);

	/* AI mixes it up: names the GmbH as both issuer and customer, supplier slot holds the buyer */
	p = page({ key: "k", pdfText: SALE, customers: [], ai: function () { return Promise.resolve({ fields: { doc_type: "purchase_invoice",
		document_no: "IO1001", document_date: "2026-06-02", supplier_name: "Photon Systems GmbH", supplier_tax_id: "DE811234567",
		issuer_is_ours: true, confidence: 0.8 } }); } });
	p.w.onDocPicked({ ok: true, name: "s.pdf", dataUrl: PDF });
	await settle();
	check("AI: our issuer makes it a sales invoice with the other party as customer", p.v("d-type") === "sales_invoice" &&
		p.v("d-customer_name") === "Photon Systems GmbH" && p.v("d-supplier_name") === "", p.v("d-type") + "/" + p.v("d-customer_name"));
	check("AI: document no. from the AI wins", p.v("d-document_no") === "IO1001");

	/* AI says it is NOT ours but names us as customer: stays a purchase, customer cleared */
	p = page({ key: "k", ai: function () { return Promise.resolve({ fields: { doc_type: "purchase_invoice", document_no: "E202604-122",
		supplier_name: "ESEMDA, UAB", customer_name: "Integrated Optics UAB", issuer_is_ours: false } }); } });
	p.w.onDocPicked({ ok: true, name: "a.pdf", dataUrl: PDF });
	await settle();
	check("purchase: supplier block shown, customer ignored", p.d.getElementById("d-box-customer").style.display === "none" &&
		p.v("d-customer_name") === "" && p.v("d-supplier_name") === "ESEMDA, UAB");

	/* proforma: direction follows the issuer, and can be flipped by hand */
	var PF = "Proforma invoice No. PF-9 Date: 2026-07-01 Seller: Integrated Optics UAB Buyer: Foo Oy VAT: FI12345678 Total: EUR 99.00";
	p = page({ pdfText: PF, customers: [C("Foo Oy", "Foo Oy", 0.95)] });
	p.w.onDocPicked({ ok: true, name: "pf.pdf", dataUrl: PDF });
	await settle();
	check("proforma by us: direction out, series PROFORMA-, customer block", p.v("d-type") === "proforma_invoice" &&
		p.v("d-direction") === "out" && p.v("d-naming_series") === "PROFORMA-" && p.d.getElementById("d-box-customer").style.display !== "none",
		p.v("d-type") + "/" + p.v("d-direction") + "/" + p.v("d-naming_series"));
	check("proforma by us: customer auto-picked at 95%", /Customer in ERPNext/.test(p.d.getElementById("d-cust-box").textContent));
	p.d.getElementById("d-direction").value = "in";
	p.d.getElementById("d-direction").dispatchEvent(new p.w.Event("change"));
	check("proforma flipped to received: supplier block back, series stays PROFORMA-", p.d.getElementById("d-box-supplier").style.display !== "none" &&
		p.v("d-naming_series") === "PROFORMA-");

	/* approve a sale: the customer link and series reach accdoc */
	var sent2 = null;
	p = page({ pdfText: SALE, customers: [C("Photon Systems GmbH", "Photon Systems GmbH", 1, true)] });
	p.w.CS_ERP.ready = function () { return ""; };
	p.w.CS_ACC.createMain = function (f) { sent2 = f; return Promise.resolve({ name: "ACC-1", file: { state: "created" }, notes: [] }); };
	p.w.onDocPicked({ ok: true, name: "s.pdf", dataUrl: PDF });
	await settle();
	p.d.getElementById("btn-doc-approve").click();
	await settle();
	check("approve sale: customer link, no supplier", !!sent2 && sent2.customerLink === "Photon Systems GmbH" &&
		sent2.customerName === "Photon Systems GmbH" && sent2.supplierName === "" && sent2.namingSeries === "SALES-", JSON.stringify(sent2));
	p = page({ pdfText: SALE.replace(/Pirkėjas:.*Suma/, "Suma"), customers: [] });
	p.w.onDocPicked({ ok: true, name: "s.pdf", dataUrl: PDF });
	await settle();
	p.d.getElementById("d-type").value = "sales_invoice"; p.d.getElementById("d-type").dispatchEvent(new p.w.Event("change"));
	p.d.getElementById("d-customer_name").value = "";
	p.d.getElementById("btn-doc-approve").click();
	check("approve sale without customer: refused", /customer name are required/.test(p.d.getElementById("d-stat").textContent), p.d.getElementById("d-stat").textContent);

	/* 13. the nine-document sets (real pdf.js text) */
	var SETS = path.join(__dirname, "fixtures/sets/");
	var setText = function (n) { return fs.readFileSync(SETS + n + ".pdfjs.txt", "utf8"); };
	var asked = null;
	var accStub = function (po) {
		return { checkReferences: function (list, si) { var r = { po: {}, salesInvoice: si ? true : null }; list.forEach(function (x) { r.po[x] = po.indexOf(x) >= 0; }); asked = { list: list, si: si }; return Promise.resolve(r); },
			suggestParents: function (f) { asked = f; return Promise.resolve([{ name: "ACC-0007", document_no: "20260730-FG394", series: "PURCHASE-", supplier: "Flygold", document_date: "2026-08-22", score: 1, exact: true, reasons: ["shared number"] }]); } };
	};
	p = page({ pdfText: setText("purchase-commercial-invoice"), acc: accStub(["PO-08258"]) });
	p.w.onDocPicked({ ok: true, name: "c.pdf", dataUrl: PDF });
	await settle();
	check("set: commercial invoice read (supplier with CO.,LIMITED, number, PO)", p.v("d-supplier_name") === "SHENZHEN FLYGOLD CIRCUIT CO.,LIMITED" &&
		p.v("d-document_no") === "20260730-FG394" && p.v("d-purchase_order_reference") === "PO-08258" && p.v("d-currency") === "USD");
	check("set: PO found in ERPNext is confirmed, not highlighted", /PO-08258 found/.test(p.d.getElementById("d-po-status").textContent) &&
		!p.d.getElementById("d-purchase_order_reference").classList.contains("warn"));

	p = page({ pdfText: setText("proforma-supplier-invoice"), acc: accStub(["PO-08258"]) });
	p.d.getElementById("d-type").value = "proforma_invoice";
	p.w.onDocPicked({ ok: true, name: "pf.pdf", dataUrl: PDF });
	await settle();
	check("set: 'PO:08353' is read as PO-08353", p.v("d-purchase_order_reference") === "PO-08353", p.v("d-purchase_order_reference"));
	check("set: unknown PO is highlighted for the logistics specialist", p.d.getElementById("d-purchase_order_reference").classList.contains("warn") &&
		/not a Purchase Order in ERPNext/.test(p.d.getElementById("d-po-status").textContent) && /manually|type it here/.test(p.d.getElementById("d-po-status").textContent));
	check("set: proforma from a supplier: PROFORMA- series, supplier block", p.v("d-type") === "proforma_invoice" && p.v("d-naming_series") === "PROFORMA-" &&
		p.v("d-supplier_name") === "SHENZHEN BEST PARTS CO., LTD" && p.v("d-document_no") === "BST260915-B17720" && p.v("d-document_date") === "2026-09-15");
	check("set: the unmatched PO reaches accdoc, not the PO link", (function () { var f = null; p.w.CS_ACC.createMain = function (x) { f = x; return Promise.resolve({ name: "A", file: { state: "created" }, notes: [] }); };
		p.d.getElementById("btn-doc-approve").click(); return !!f && f.poUnmatched && f.poUnmatched[0] === "PO-08353" && !(f.poMatched && f.poMatched.length); })());

	p = page({ pdfText: setText("purchase-import-declaration"), acc: accStub(["PO-08258"]) });
	p.d.getElementById("d-type").value = "customs_declaration";
	p.w.onDocPicked({ ok: true, name: "cd.pdf", dataUrl: PDF });
	await settle();
	check("set: declaration no. is the MRN, supplier is the customs authority", p.v("d-document_no") === "26LTVA100025C7F4R1" &&
		/Muitinės departamentas prie Lietuvos Respublikos finansų ministerijos/.test(p.v("d-supplier_name")), p.v("d-supplier_name"));
	check("set: declaration is matched to its purchase through the numbers it cites", asked && asked.references.indexOf("PO-08258") >= 0 &&
		asked.references.indexOf("20260730-FG394") >= 0 && p.v("d-parent") === "ACC-0007");
	check("set: a form without a key says only its numbers were read", /form/.test(p.d.getElementById("d-warn").textContent));

	p = page({ key: "k", pdfText: setText("purchase-import-declaration"), acc: accStub([]), ai: function () { return Promise.resolve({ fields: { doc_type: "customs_declaration", document_no: "26LTVA100025C7F4R1",
		document_date: "2026-08-26", supplier_name: "UAB DHL LIETUVA", related_references: ["PO-08258", "5554865912"] } }); } });
	p.d.getElementById("d-type").value = "customs_declaration";
	p.w.onDocPicked({ ok: true, name: "cd.pdf", dataUrl: PDF });
	await settle();
	check("set: a form goes to the AI as the file, not the text", p.calls.file.length === 1 && p.calls.text.length === 0);
	check("set: the AI naming the declarant does not replace the customs authority", /Muitinės departamentas/.test(p.v("d-supplier_name")));

	p = page({ pdfText: setText("purchase-dhl-clearance-invoice"), acc: accStub([]) });
	p.w.onDocPicked({ ok: true, name: "vs.pdf", dataUrl: PDF });
	await settle();
	check("set: DHL clearance invoice is a customs invoice from DHL, found through the MRN", p.v("d-type") === "cd_invoice" && p.v("d-document_no") === "VS396551" &&
		p.v("d-supplier_name") === "UAB DHL LIETUVA" && p.v("d-parent") === "ACC-0007" && asked.references.indexOf("26LTVA100025C7F4R1") >= 0);

	p = page({ pdfText: setText("sales-fedex-label"), acc: accStub([]) });
	p.w.onDocPicked({ ok: true, name: "label.pdf", dataUrl: PDF });
	await settle();
	check("set: courier label becomes an attachment with only the record picker", p.v("d-type") === "attachment" &&
		p.d.getElementById("d-box-supplier").style.display === "none" && p.d.getElementById("d-box-customer").style.display === "none" &&
		p.d.getElementById("d-row-parent").style.display !== "none" && p.d.getElementById("d-row-main-extra").style.display === "none");
	var att = null;
	p.w.CS_ACC.attachToParent = function (n, d, f, note) { att = [n, d, f, note]; return Promise.resolve({ name: "ACC-0099", parent: n, file: { state: "created" } }); };
	p.d.getElementById("btn-doc-approve").click();
	await settle();
	check("set: approving an attachment saves it as a child of the chosen record", !!att && att[0] === "ACC-0007" && att[1] === PDF && att[2] === "label.pdf" &&
		/Waybill/.test(att[3]) && /Saved as ACC-0099, a child of ACC-0007/.test(p.d.getElementById("d-stat").textContent), JSON.stringify(att));

	p = page({ pdfText: setText("sales-invoice"), acc: accStub([]), customers: [C("UniNanoTech Co., Ltd.", "UniNanoTech Co., Ltd.", 0.97, false)] });
	p.w.onDocPicked({ ok: true, name: "s.pdf", dataUrl: PDF });
	await settle();
	check("set: sales invoice number goes into the sales invoice reference and is checked", p.v("d-document_no") === "IO26-02602" &&
		p.v("d-sales_invoice_reference") === "IO26-02602" && /found in ERPNext/.test(p.d.getElementById("d-sales-status").textContent) &&
		p.v("d-customer_name") === "UniNanoTech Co., Ltd");

	/* payment order: typed values live in form fields, which pdfview now appends to the text */
	p = page({ pdfText: "Mokėjimo nurodymas Nr. Payment Order No. 2026-09-16 457.00 USD BEST PARTS CO.,LIMITED Payment for purchase order No. PO-08353, BST260915-B17720 and a few more words to make this readable text here", acc: accStub([]) });
	p.w.onDocPicked({ ok: true, name: "pay.pdf", dataUrl: PDF });
	await settle();
	check("set: payment order is an attachment, found through the PO it names", p.v("d-type") === "attachment" && asked && asked.references.indexOf("PO-08353") >= 0);

	/* the Nano Vita invoice (seller and buyer side by side): the AI names OUR company as supplier -> replaced by the
	   seller the layout-aware offline reader found */
	var NV = fs.readFileSync(path.join(__dirname, "fixtures/purchase-nanovita.flat.pdfjs.txt"), "utf8");
	var items = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/purchase-nanovita.items.json"), "utf8")).map(function (a) { return { str: a[0], transform: [1, 0, 0, 1, a[1], a[2]], width: a[3] }; });
	var pvSrc = fs.readFileSync(path.join(__dirname, "../android/CardScanner/app/src/main/assets/pdfview.js"), "utf8");
	var NVT = (new Function("window", pvSrc + "; return window.CS_PDF.layoutText;"))({}) ;
	var layoutNV = typeof NVT === "function" ? NVT(items) : NV;
	p = page({ key: "k", pdfText: layoutNV, ai: function () { return Promise.resolve({ fields: { doc_type: "purchase_invoice", document_no: "2333",
		document_date: "2026-09-07", supplier_name: "UAB \"Integrated optics\"", total_amount: 3298.46, currency: "EUR", confidence: 0.8, notes: "", language: "lt" } }); } });
	p.w.onDocPicked({ ok: true, name: "PO-08286.pdf", dataUrl: PDF });
	await settle();
	check("Nano Vita: the AI mistake (our own company as supplier) is replaced by the real seller", /Nano Vita/.test(p.v("d-supplier_name")) && !/Integrated/i.test(p.v("d-supplier_name")), p.v("d-supplier_name"));
	check("Nano Vita: the supplier's own codes, not ours", p.v("d-supplier_reg_number") === "301920531", p.v("d-supplier_reg_number"));

	/* the file cannot be sent (e.g. too big): a PDF with a text layer falls back to the text */
	var tries = [];
	p = page({ key: "k" });
	p.w.CS_EXTRACT.extractFromFile = function () { tries.push("file"); return Promise.reject(new Error("too big")); };
	p.w.CS_EXTRACT.extractFields = function (t) { tries.push("text"); return Promise.resolve({ fields: { doc_type: "purchase_invoice", document_no: "E202604-122", document_date: "2026-04-22", supplier_name: "ESEMDA, UAB", confidence: 0.9, notes: "", language: "lt" } }); };
	p.w.onDocPicked({ ok: true, name: "a.pdf", dataUrl: PDF });
	await settle();
	check("file refused -> falls back to the text", tries.join() === "file,text" && p.v("d-supplier_name") === "ESEMDA, UAB", tries.join() + " " + p.v("d-supplier_name"));

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
