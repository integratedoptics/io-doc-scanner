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
		extractFromFile: function (d, s, h) { calls.file.push({ d: d, h: h }); return opts.ai ? opts.ai(d) : Promise.reject(new Error("no ai")); }
	};
	w.CS_ACC = { findExactSupplier: function () { return Promise.resolve(null); }, findSupplierMatches: function () { return Promise.resolve([]); },
		suggestParents: function () { return Promise.resolve([]); } };
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
	check("AI asked with the text, not the file", p.calls.text.length === 1 && p.calls.file.length === 0 && p.calls.text[0].t === TEXT);
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

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
