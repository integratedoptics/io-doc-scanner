/* test_newflow_ui.js — the Documents screen with the test server switched on: item lines with their marks, send to
   both servers, retry of the test send only, quotations, waybills, and the screen with the test server off.
       JSDOM_PATH=/tmp/jsd/node_modules/jsdom node tests/test_newflow_ui.js */
"use strict";
var fs = require("fs"), path = require("path");
var JSDOM;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; }
catch (e) { console.log("skipped: jsdom is not installed (set JSDOM_PATH)"); process.exit(0); }
var A = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var html = fs.readFileSync(A + "index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
var src = {};
["docrules", "accdoc", "newdocs", "newui", "docscan"].forEach(function (n) { src[n] = fs.readFileSync(A + n + ".js", "utf8"); });
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }
function tick() { return new Promise(function (r) { setTimeout(r, 15); }); }
async function settle() { for (var i = 0; i < 12; i++) await tick(); }
var PDF = "data:application/pdf;base64,QUJD";

function page(opts) {
	var dom = new JSDOM(html, { runScripts: "outside-only" });
	var w = dom.window, st = { live: [], created: [], attached: [], methods: [], items: [
		{ name: "ABC-12345", item_code: "ABC-12345", item_name: "Resistor" }, { name: "LASER-100K", item_code: "LASER-100K", item_name: "Laser" }] };
	var settings = { extract_key: "k", erp_test_url: opts.noTest ? "" : "https://test.example.com", new_item_group: "Components", new_stock_uom: "Nos" };
	var suppliers = [{ name: 'UAB "Skubios siuntos"', supplier_name: 'UAB "Skubios siuntos"', reg_number: "", tax_id: "LT100007179012" }];
	var pos = { "PO-08353": { name: "PO-08353", docstatus: 1, items: [{ name: "poi-1", item_code: "ABC-12345", qty: 100, received_qty: 40, rate: 0.5 }] } };
	var fake = {
		getList: function (dt) {
			if (dt === "Item") return Promise.resolve(st.items.slice());
			if (dt === "Supplier") return Promise.resolve(suppliers);
			if (dt === "Company") return Promise.resolve([{ name: "IO", default_currency: "EUR" }]);
			if (dt === "Purchase Order") return Promise.resolve([{ name: "PO-08353", supplier: "S", transaction_date: "2026-09-01", status: "To Receive", per_received: 40, docstatus: 1, tracking_awb_no: "5554865912" }]);
			return Promise.resolve([]);
		},
		fetchDoc: function (dt, n) { return Promise.resolve(dt === "Item" ? (st.items.filter(function (i) { return i.name === n; })[0] || null) : (dt === "Purchase Order" ? pos[n] || null : (dt === "Purchase Invoice" ? { grand_total: 12 } : null))); },
		describe: function (dt) { var f = {}; if (dt === "Purchase Invoice") f.scanned_invoice = {}; if (dt !== "Supplier Quotation") f.tracking_awb_no = {}; return Promise.resolve({ fields: f, complete: true }); },
		clean: function (dt, d, n) { return Promise.resolve({ doc: d, notes: n }); },
		createDoc: function (dt, d) { st.created.push({ dt: dt, doc: JSON.parse(JSON.stringify(d)) }); if (dt === "Item") { st.items.push({ name: d.item_code, item_code: d.item_code, item_name: d.item_name }); return Promise.resolve(d.item_code); } return Promise.resolve(dt.slice(0, 3).toUpperCase() + "-" + st.created.length); },
		attachFile: function (dt, n, d, fn, f) { st.attached.push([dt, n, f]); return Promise.resolve({ state: "created", url: "/private/files/x" }); },
		callMethod: function (name, a) { st.methods.push(name); if (/exchange/.test(name)) return Promise.resolve(null); return Promise.resolve({ doctype: "Purchase Receipt", __islocal: 1, items: [{ item_code: "ABC-12345", qty: 60 }] }); }
	};
	w.CS = { settings: function () { return settings; } };
	w.CS_PDF = { extractText: function () { return Promise.resolve({ text: "", pages: 1 }); } };
	w.CS_EXTRACT = { ready: function () { return ""; },
		extractFields: function () { return Promise.reject(new Error("x")); },
		extractFromFile: function () { return Promise.resolve({ fields: opts.ai }); } };
	w.CS_ERP = { ready: function () { return ""; }, shared: { getList: function () { return Promise.resolve([]); } } };
	w.CS_ERP_TEST = { ready: function () { return ""; }, shared: fake };
	w.CS_ERP_TEST_ENABLED = function (s) { return !!(s && s.erp_test_url); };
	w.Android = {};
	w.eval(src.docrules); w.eval(src.accdoc); w.eval(src.newdocs); w.eval(src.newui); w.eval(src.docscan);
	w.CS_ACC.findExactSupplier = function () { return Promise.resolve(null); };
	w.CS_ACC.findSupplierMatches = function () { return Promise.resolve([]); };
	w.CS_ACC.suggestParents = function () { return Promise.resolve([]); };
	w.CS_ACC.checkReferences = function () { return Promise.resolve({ po: {}, salesInvoice: null }); };
	w.CS_ACC.createMain = function (f) { st.live.push(f.documentNo); return Promise.resolve({ name: "ACC-1", file: { state: "created" }, notes: [] }); };
	w.CS_ACC.attachToParent = function (n) { st.live.push("attach:" + n); return Promise.resolve({ name: "ACC-9", parent: n, file: { state: "created" } }); };
	w.CS_DOCSCAN.init();
	var d = w.document;
	return { w: w, d: d, st: st, v: function (id) { return d.getElementById(id).value; }, el: function (id) { return d.getElementById(id); },
		set: function (id, v) { d.getElementById(id).value = v; } };
}

var INV = { doc_type: "purchase_invoice", document_no: "MTPA1", document_date: "2026-10-09", supplier_name: "SKUBIOS SIUNTOS, UAB", supplier_tax_id: "LT100007179012",
	purchase_order_reference: "PO-08353", currency: "EUR", total_amount: 12, confidence: 0.9, related_references: [],
	lines: [
		{ item_code: "ABC-12345", description: "Resistor", quantity: 60, unit_price: 0.1 },
		{ item_code: "LASER-100K1", description: "Laser", quantity: 1, unit_price: 5 },
		{ item_code: "NEW-1", description: "New part", quantity: 2, unit_price: 3 }] };

(async function () {
	var p = page({ ai: INV });
	p.w.onDocPicked({ ok: true, name: "inv.pdf", dataUrl: PDF });
	await settle();
	check("panel is shown with both switches on", p.el("d-new").style.display !== "none" && p.el("d-send-live").checked && p.el("d-send-test").checked);
	var pills = Array.prototype.map.call(p.d.querySelectorAll("#d-lines .pill"), function (e) { return e.className.replace("pill ", ""); });
	check("marks: green, orange, red", pills.join() === "green,orange,red", pills.join());
	var rows = p.d.querySelectorAll("#d-lines .li");
	check("three lines; the orange one has the use/create switch with 'Use' on, the red one 'Create new'", rows.length === 3 &&
		rows[0].querySelector(".seg") === null && rows[1].querySelector(".seg button.on").dataset.mode === "use" && rows[2].querySelector(".seg button.on").dataset.mode === "create");
	check("PO comparison shown for the first line (ordered 100, received 40, this document 60)", /ordered 100, received so far 40, this document 60/.test(rows[0].textContent), rows[0].textContent);

	/* flip the red line to "use": the closest item list is empty, so it explains */
	rows[2].querySelector('[data-mode="use"]').click();
	check("'Use' on a line with nothing similar explains what to do", /No similar item/.test(p.d.querySelectorAll("#d-lines .li")[2].textContent));
	p.d.querySelectorAll("#d-lines .li")[2].querySelector('[data-mode="create"]').click();

	/* send to both */
	p.el("btn-doc-approve").click();
	await settle();
	var types = p.st.created.map(function (c) { return c.dt; });
	check("live got the Accounts Document, test got the new item first and then the Purchase Invoice", p.st.live.join() === "MTPA1" && types.join() === "Item,Purchase Invoice", types.join() + " / " + p.st.live.join());
	check("the new item has the printed code, group and UOM", p.st.created[0].doc.item_code === "NEW-1" && p.st.created[0].doc.item_group === "Components");
	check("the invoice lines carry the chosen items (green, the closest orange, the new one)", p.st.created[1].doc.items.map(function (i) { return i.item_code; }).join() === "ABC-12345,LASER-100K,NEW-1", JSON.stringify(p.st.created[1].doc.items));
	check("invoice file attached to the Scanned Invoice field", p.st.attached.some(function (a) { return a[0] === "Purchase Invoice" && a[2] === "scanned_invoice"; }));
	var stat = p.el("d-stat").textContent;
	check("status shows both servers", /Live server/.test(stat) && /Test server/.test(stat) && /Purchase Invoice/.test(stat), stat);
	check("form reset after both succeeded", p.el("box-doc-form").style.display === "none");

	/* test failure after live success: live is not repeated */
	var bad = JSON.parse(JSON.stringify(INV)); bad.supplier_name = "Unknown Trader GmbH"; bad.supplier_tax_id = "";
	p = page({ ai: bad });
	p.w.onDocPicked({ ok: true, name: "inv2.pdf", dataUrl: PDF });
	await settle();
	p.el("btn-doc-approve").click();
	await settle();
	check("live saved, test refused (unknown supplier) with a clear message", p.st.live.length === 1 && /no Supplier like/.test(p.el("d-stat").textContent), p.el("d-stat").textContent);
	check("the form stays and the live switch is off", p.el("box-doc-form").style.display !== "none" && !p.el("d-send-live").checked);
	p.el("btn-doc-approve").click();
	await settle();
	check("pressing Approve again does not repeat the live send", p.st.live.length === 1, p.st.live.join());

	/* quotation: test only */
	var q = { doc_type: "supplier_quotation", document_no: "Q-1", document_date: "2026-10-01", supplier_name: "Skubios siuntos", currency: "EUR", valid_until: "2026-12-31",
		lines: [{ item_code: "ABC-12345", quantity: 1, unit_price: 1 }, { item_code: "ABC-12345", quantity: 100, unit_price: 0.8 }] };
	p = page({ ai: q });
	p.w.onDocPicked({ ok: true, name: "q.pdf", dataUrl: PDF });
	await settle();
	check("quotation: no live switch, valid-until shown", p.el("d-send-live-row").style.display === "none" && p.el("d-box-valid").style.display !== "none" && p.v("d-valid_until") === "2026-12-31");
	p.el("btn-doc-approve").click();
	await settle();
	var sq = p.st.created.filter(function (c) { return c.dt === "Supplier Quotation"; })[0];
	check("quotation: sent to the test server only, two rows for the price break", p.st.live.length === 0 && sq && sq.doc.items.length === 2 && sq.doc.items[1].qty === 100 && sq.doc.items[1].rate === 0.8, JSON.stringify(sq));

	/* waybill */
	var wb = { doc_type: "attachment", attachment_kind: "waybill", tracking_number: "5554865912", document_date: "2026-10-05", related_references: [], lines: [] };
	p = page({ ai: wb });
	p.w.onDocPicked({ ok: true, name: "awb.pdf", dataUrl: PDF });
	await settle();
	check("waybill: type switches to Waybill, the AWB is filled in and the Purchase Order found", p.v("d-type") === "waybill" && p.v("d-tracking_number") === "5554865912" && /PO-08353/.test(p.el("d-awb-list").textContent), p.el("d-awb-list").textContent);
	p.el("d-send-live").checked = false;
	p.el("btn-doc-approve").click();
	await settle();
	var pr = p.st.created.filter(function (c) { return c.dt === "Purchase Receipt"; })[0];
	check("waybill: a Purchase Receipt is made from the order and the waybill attached to it", !!pr && p.st.attached.some(function (a) { return a[0] === "Purchase Receipt"; }) && /Purchase Receipt/.test(p.el("d-stat").textContent), p.el("d-stat").textContent);

	/* test server off */
	p = page({ ai: INV, noTest: true });
	p.w.onDocPicked({ ok: true, name: "inv.pdf", dataUrl: PDF });
	await settle();
	check("test server off: no panel, live send only", p.el("d-new").style.display === "none");
	p.el("btn-doc-approve").click();
	await settle();
	check("test server off: the old flow works unchanged", p.st.live.join() === "MTPA1" && p.st.created.length === 0 && /Saved as ACC-1/.test(p.el("d-stat").textContent) && !/Live server/.test(p.el("d-stat").textContent), p.el("d-stat").textContent);
	p = page({ ai: q, noTest: true });
	p.w.onDocPicked({ ok: true, name: "q.pdf", dataUrl: PDF });
	await settle();
	p.el("btn-doc-approve").click();
	await settle();
	check("test server off: a quotation says it needs the test server", /test server only/.test(p.el("d-stat").textContent) || /test server only/.test(p.el("d-new-hint").textContent), p.el("d-stat").textContent);

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
