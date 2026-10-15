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
["docrules", "accdoc", "newdocs", "newui", "history", "docscan"].forEach(function (n) { src[n] = fs.readFileSync(A + n + ".js", "utf8"); });
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
			if (dt === "Account") return Promise.resolve([{ name: "2441 - PVM - IO", account_type: "Tax", root_type: "Asset" }, { name: "4430 - Transport - IO", account_type: "", root_type: "Expense" }]);
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
	st.store = {};
	w.Android = { readData: function (n) { return st.store[n] || ""; }, writeData: function (n, c) { st.store[n] = c; return true; } };
	w.eval(src.docrules); w.eval(src.accdoc); w.eval(src.newdocs); w.eval(src.newui); w.eval(src.history); w.eval(src.docscan);
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


	/* charges: VAT, shipping and a discount on the review screen, in the Purchase Taxes and Charges table */
	var INV2 = JSON.parse(JSON.stringify(INV));
	INV2.total_amount = 24.57;
	INV2.charges = [{ kind: "vat", description: "PVM 21%", rate: 21, amount: 3.57 }, { kind: "shipping", description: "Shipping & handling", amount: 4 }, { kind: "vat", description: "PVM 0%", rate: 0, amount: 0 }];
	p = page({ ai: INV2 });
	p.w.onDocPicked({ ok: true, name: "inv.pdf", dataUrl: PDF });
	await settle();
	check("charges: two rows shown (the zero VAT row is dropped) in the charges box", p.el("d-box-charges").style.display !== "none" && p.el("d-charges").querySelectorAll(".ch").length === 2, p.el("d-charges").innerHTML.slice(0, 200));
	check("charges: lines 17 + charges 7.57 = 24.57 matches the document total", /Lines 17\.00 \+ charges 7\.57 = 24\.57/.test(p.el("d-charge-sum").textContent) && /matches/.test(p.el("d-charge-sum").textContent), p.el("d-charge-sum").textContent);
	var amt = p.el("d-charges").querySelectorAll('input[data-f="amount"]')[1];
	amt.value = "9"; amt.dispatchEvent(new p.w.Event("change", { bubbles: true }));
	check("charges: editing an amount updates the check and flags the difference", /difference \+5\.00/.test(p.el("d-charge-sum").textContent), p.el("d-charge-sum").textContent);
	amt = p.el("d-charges").querySelectorAll('input[data-f="amount"]')[1];
	amt.value = "4"; amt.dispatchEvent(new p.w.Event("change", { bubbles: true }));
	p.el("btn-charge-add").click();
	check("charges: 'Add a charge' adds an empty row", p.el("d-charges").querySelectorAll(".ch").length === 3);
	p.el("d-charges").querySelectorAll('[data-del]')[2].click();
	p.el("d-send-live").checked = false;
	p.el("btn-doc-approve").click();
	await settle();
	var pi2 = p.st.created.filter(function (c) { return c.dt === "Purchase Invoice"; })[0];
	check("charges: the Purchase Invoice has the VAT row and the shipping row", !!pi2 && pi2.doc.taxes && pi2.doc.taxes.length === 2 && pi2.doc.taxes[0].tax_amount === 3.57 && pi2.doc.taxes[0].account_head === "2441 - PVM - IO" &&
		pi2.doc.taxes[1].account_head === "4430 - Transport - IO" && pi2.doc.taxes[1].tax_amount === 4, JSON.stringify(pi2 && pi2.doc.taxes));

	/* upload history */
	var hist = p.w.document.getElementById("d-hist");
	check("history: the test-server upload is listed as Sent with the document number and the ERPNext name", /Sent/.test(hist.textContent) && /MTPA1/.test(hist.textContent) && /Test/.test(hist.textContent) && /Purchase Invoice/.test(hist.textContent), hist.textContent);
	check("history: it is stored on the device", p.st.store["upload-history.json"] && JSON.parse(p.st.store["upload-history.json"]).length === 1);
	p = page({ ai: INV });
	p.w.onDocPicked({ ok: true, name: "inv.pdf", dataUrl: PDF });
	await settle();
	p.w.CS_ACC.createMain = function () { return Promise.reject(Object.assign(new Error("x"), { errors: [{ message: "ERPNext rejected the Accounts Document: Value missing for Accounts Document: Document No" }] })); };
	p.el("btn-doc-approve").click();
	await settle();
	var ht = p.w.document.getElementById("d-hist").textContent;
	check("history: a failed live send is listed as Failed with ERPNext's own error, the test send as not sent", /Failed/.test(ht) && /Value missing for Accounts Document: Document No/.test(ht) && /not sent/.test(ht), ht);
	for (var hi = 0; hi < 34; hi++) p.w.CS_HISTORY.record({ type: "Purchase Invoice", docNo: "N" + hi, supplier: "S", results: [{ server: "Test", ok: hi % 5 !== 0, name: "PINV-" + hi, message: "boom" }] });
	check("history: 30 records are shown, the rest behind 'Show older records'", p.w.document.querySelectorAll("#d-hist .uhrow").length === 30 && /Show older records \(5 more\)/.test(p.el("btn-hist-more").textContent) && p.el("btn-hist-more").style.display !== "none", p.el("btn-hist-more").textContent);
	p.el("btn-hist-more").click();
	check("history: expanded it lists all 35 and can be folded again", p.w.document.querySelectorAll("#d-hist .uhrow").length === 35 && /latest 30/.test(p.el("btn-hist-more").textContent) && p.el("d-hist").className.indexOf("open") >= 0);
	p.el("btn-hist-more").click();
	check("history: folded again to 30", p.w.document.querySelectorAll("#d-hist .uhrow").length === 30);

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
