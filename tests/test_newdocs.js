/* test_newdocs.js — the new document flow (newdocs.js) against a fake test server. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var dir = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var calls = [], created = [], attached = [], methods = [];
var S = { erp_test_url: "https://test.example.com", new_item_group: "Components", new_stock_uom: "Nos", new_service_item: "", new_company: "", new_taxes: "" };
var items = [
	{ name: "ABC-12345", item_code: "ABC-12345", item_name: "Resistor" },
	{ name: "XYZ 9000", item_code: "XYZ 9000", item_name: "Lens" },
	{ name: "LASER-100K", item_code: "LASER-100K", item_name: "Laser" }
];
var suppliers = [{ name: 'UAB "Skubios siuntos"', supplier_name: 'UAB "Skubios siuntos"', reg_number: "", tax_id: "LT100007179012" }, { name: "Nano Vita Ltd", supplier_name: "Nano Vita Ltd", reg_number: "", tax_id: "" }];
var pos = { "PO-08353": { name: "PO-08353", docstatus: 1, supplier: "Nano Vita Ltd", items: [
	{ name: "poi-1", item_code: "ABC-12345", qty: 100, received_qty: 40, rate: 0.5, uom: "Nos" },
	{ name: "poi-2", item_code: "LASER-100K", qty: 2, received_qty: 0, rate: 900, uom: "Nos" }] } };
var poRows = [{ name: "PO-08353", supplier: "Nano Vita Ltd", transaction_date: "2026-09-01", status: "To Receive and Bill", per_received: 10, docstatus: 1, tracking_awb_no: "1234 5678 90" }];
var describeNone = false;
var sqSeries = "PUR-SQTN-.YYYY.-\nRFQ-\nSQTN-", sqValidField = "valid_till", forgot = [];
var fake = {
	getList: function (dt, filters, fields) {
		calls.push(["getList", dt]);
		if (dt === "Item") return Promise.resolve(items.slice());
		if (dt === "Supplier") return Promise.resolve(suppliers.slice());
		if (dt === "Company") return Promise.resolve([{ name: "Integrated Optics UAB", default_currency: "EUR" }]);
		if (dt === "Purchase Order") return Promise.resolve(poRows.slice());
		if (dt === "Purchase Receipt") return Promise.resolve([]);
		return Promise.resolve([]);
	},
	fetchDoc: function (dt, name) {
		if (dt === "Item") return Promise.resolve(items.filter(function (i) { return i.name === name; })[0] || null);
		if (dt === "Purchase Order") return Promise.resolve(pos[name] || null);
		if (dt === "Purchase Invoice") return Promise.resolve({ name: name, grand_total: 100 });
		return Promise.resolve(null);
	},
	describe: function (dt) {
		if (describeNone) return Promise.resolve(null);
		var f = {};
		if (dt === "Purchase Invoice") { f.scanned_invoice = {}; f.tracking_awb_number = {}; f.bill_no = {}; }
		if (dt === "Purchase Order" || dt === "Purchase Receipt") { f.tracking_awb_no = {}; }
		if (dt === "Supplier Quotation") {
			if (sqValidField) f[sqValidField] = { type: "Date" };
			f.naming_series = { type: "Select", options: sqSeries };
		}
		return Promise.resolve({ fields: f, complete: true });
	},
	forgetMeta: function (dt) { forgot.push(dt); },
	clean: function (dt, doc, notes) { return Promise.resolve({ doc: doc, notes: notes }); },
	createDoc: function (dt, doc) {
		created.push({ dt: dt, doc: JSON.parse(JSON.stringify(doc)) });
		if (dt === "Item") { items.push({ name: doc.item_code, item_code: doc.item_code, item_name: doc.item_name }); return Promise.resolve(doc.item_code); }
		return Promise.resolve(dt.replace(/ /g, "").slice(0, 4).toUpperCase() + "-" + created.length);
	},
	attachFile: function (dt, name, d, fn, field) { attached.push({ dt: dt, name: name, field: field }); return Promise.resolve({ state: "created", url: "/private/files/" + fn }); },
	callMethod: function (name, args) {
		methods.push([name, args]);
		if (/get_exchange_rate/.test(name)) return Promise.resolve(1.08);
		if (/make_purchase_receipt/.test(name)) return Promise.resolve({ doctype: "Purchase Receipt", __islocal: 1, __unsaved: 1, supplier: "Nano Vita Ltd", items: [{ __islocal: 1, item_code: "ABC-12345", qty: 60, purchase_order: args.source_name, purchase_order_item: "poi-1" }] });
		return Promise.resolve(null);
	}
};
var sandbox = { window: {}, console: console };
sandbox.window.CS_ERP = { shared: fake };
sandbox.window.CS_ERP_TEST = { shared: fake };
sandbox.window.CS = { settings: function () { return S; } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(dir + "accdoc.js", "utf8"), sandbox);
vm.runInContext(fs.readFileSync(dir + "newdocs.js", "utf8"), sandbox);
var N = sandbox.window.CS_NEW, fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }
var D = "data:application/pdf;base64,QUJD";

(async function () {
	check("same code is 100", N.similarity("ABC-12345", "abc-12345 ") === 100);
	check("separators only: 99, orange", N.similarity("ABC 12345", "ABC-12345") === 99 && N.levelOf(99) === "orange");
	check("one wrong character in ten: 90, orange", N.similarity("ABCDEFGHIJ", "ABCDEFGHIK") === 90 && N.levelOf(90) === "orange");
	check("two wrong in nine: under 90, red", N.similarity("ABC-12345", "ABC-12354") < 90 && N.levelOf(N.similarity("ABC-12345", "ABC-12354")) === "red");
	check("nothing in common: low", N.similarity("QQQ", "ABC-12345") < 30);

	var lines = [
		{ item_code: "ABC-12345", description: "Resistor 10k", quantity: 60, unit_price: 0.5, po_reference: "PO-08353" },
		{ item_code: "LASER-100K1", description: "Laser", quantity: 1, unit_price: 900 },
		{ item_code: "NEW-777", description: "A brand new part", quantity: 5, unit_price: 2 },
		{ description: "Freight", quantity: 1, unit_price: 20 }
	].map(N.normalizeLine);
	await N.matchLines(lines);
	check("exact code: green, use it", lines[0].match.level === "green" && lines[0].decision.mode === "use" && lines[0].decision.itemCode === "ABC-12345");
	check("close code: orange, 'use' the closest by default", lines[1].match.level === "orange" && lines[1].match.score === 90 && lines[1].decision.mode === "use" && lines[1].decision.itemCode === "LASER-100K", JSON.stringify(lines[1].match));
	check("unknown code: red, 'create new' by default with the printed code", lines[2].match.level === "red" && lines[2].decision.mode === "create" && lines[2].decision.newCode === "NEW-777");
	check("a line without a code and no service item: red, create from the description", lines[3].match.level === "red" && lines[3].decision.mode === "create" && lines[3].decision.newCode === "FREIGHT");

	var po = await N.loadPurchaseOrders(["PO-08353", "PO-99999"]);
	check("a missing PO is reported", po.missing.join() === "PO-99999");
	N.annotatePo(lines, po);
	check("PO compare: ordered 100, received 40, this document 60", lines[0].po && lines[0].po.ordered === 100 && lines[0].po.received === 40 && /ordered 100, received so far 40, this document 60/.test(lines[0].poNote) && !lines[0].poWarn, lines[0].poNote);
	check("PO compare: the closest item (LASER-100K) is looked up on the order", lines[1].po && lines[1].po.detail === "poi-2" && /more than the 2 still open|this document 1/.test(lines[1].poNote), lines[1].poNote);

	/* purchase invoice: new item first, then the document */
	var f = { documentNo: "MTPA1", documentDate: "2026-10-09", paymentDueDate: "2026-11-08", supplierName: "SKUBIOS SIUNTOS, UAB", supplierCode: "LT100007179012", currency: "USD", totalAmount: 100, trackingNumber: "1234567890" };
	lines[3].decision.newCode = "FREIGHT"; lines[3].qty = 1; lines[3].rate = 20;
	var r = await N.createPurchaseInvoice(f, lines, { dataUrl: D, name: "inv.pdf" });
	var itemCreates = created.filter(function (c) { return c.dt === "Item"; });
	var pi = created.filter(function (c) { return c.dt === "Purchase Invoice"; })[0];
	check("two new items created (NEW-777 and FREIGHT) with group and UOM from settings", itemCreates.length === 2 && itemCreates[0].doc.item_code === "NEW-777" && itemCreates[0].doc.item_group === "Components" && itemCreates[0].doc.stock_uom === "Nos", JSON.stringify(itemCreates));
	check("items are created BEFORE the invoice", created.indexOf(itemCreates[1]) < created.indexOf(pi));
	check("supplier matched to the stored name", pi.doc.supplier === 'UAB "Skubios siuntos"');
	check("bill no / bill date / due date / currency / rate / company", pi.doc.bill_no === "MTPA1" && pi.doc.bill_date === "2026-10-09" && pi.doc.posting_date === "2026-10-09" && pi.doc.due_date === "2026-11-08" && pi.doc.currency === "USD" && pi.doc.conversion_rate === 1.08 && pi.doc.company === "Integrated Optics UAB", JSON.stringify(pi.doc));
	check("tracking number goes to the resolved AWB field", pi.doc.tracking_awb_number === "1234567890");
	check("four item lines with qty and rate; the matched PO line is linked", pi.doc.items.length === 4 && pi.doc.items[0].item_code === "ABC-12345" && pi.doc.items[0].qty === 60 && pi.doc.items[0].rate === 0.5 && pi.doc.items[0].purchase_order === "PO-08353" && pi.doc.items[0].po_detail === "poi-1", JSON.stringify(pi.doc.items));
	check("a new item's row carries the Stock UOM from settings", pi.doc.items[2].uom === "Nos" && pi.doc.items[2].conversion_factor === 1, JSON.stringify(pi.doc.items[2]));
	check("the 'use' line carries the chosen item (LASER-100K)", pi.doc.items[1].item_code === "LASER-100K");
	check("file attached to the Scanned Invoice field", attached.length === 1 && attached[0].dt === "Purchase Invoice" && attached[0].field === "scanned_invoice", JSON.stringify(attached));
	check("total difference is reported", /differs/.test(r.note || "") === false, r.note);

	/* unknown supplier */
	var e1 = null;
	try { await N.createPurchaseInvoice({ documentNo: "X", documentDate: "2026-10-09", supplierName: "Nobody GmbH" }, lines, null); } catch (e) { e1 = e; }
	check("unknown supplier: a clear error, nothing created", e1 && /no Supplier like/.test(e1.message) && created.filter(function (c) { return c.dt === "Purchase Invoice"; }).length === 1, e1 && e1.message);

	/* a supplier picked with "Use this" is honoured even when the printed name is quite different */
	suppliers.push({ name: "Wavespectrum Laser (Photonics) Group Limited", supplier_name: "Wavespectrum Laser (Photonics) Group Limited", reg_number: "", tax_id: "" });
	var rs = await N.resolveSupplier("WAVESPECTRUM PHOTONICS GROUP LIMITED", "");
	check("similar but not confident: not guessed, the closest is offered", !rs.name && rs.candidates.length && /Wavespectrum Laser/.test(rs.candidates[0].name), JSON.stringify(rs));
	rs = await N.resolveSupplier("WAVESPECTRUM PHOTONICS GROUP LIMITED", "", "Wavespectrum Laser (Photonics) Group Limited");
	check("the chosen supplier (supplierLink) is used", rs.name === "Wavespectrum Laser (Photonics) Group Limited" && rs.how === "chosen by you", JSON.stringify(rs));
	rs = await N.resolveSupplier("Wavespectrum Laser (Photonics) Group Limited", "");
	check("the chosen name typed into the field resolves as the same name", rs.name === "Wavespectrum Laser (Photonics) Group Limited" && rs.how === "same name", JSON.stringify(rs));
	var q0 = created.length;
	await N.createSupplierQuotation({ documentNo: "Q-77", documentDate: "2026-10-01", supplierName: "WAVESPECTRUM PHOTONICS GROUP LIMITED", supplierLink: "Wavespectrum Laser (Photonics) Group Limited", currency: "EUR" }, lines.slice(0, 1), null);
	var wq = created.slice(q0).filter(function (c) { return c.dt === "Supplier Quotation"; })[0];
	check("quotation for a chosen supplier is created for it", wq && wq.doc.supplier === "Wavespectrum Laser (Photonics) Group Limited", JSON.stringify(wq));
	suppliers.pop();

	/* no item group */
	S.new_item_group = "";
	var more = [N.normalizeLine({ item_code: "ZZZ-1", quantity: 1, unit_price: 1 })]; await N.matchLines(more);
	var e2 = null;
	try { await N.createPurchaseInvoice({ documentNo: "X", documentDate: "2026-10-09", supplierName: "Nano Vita Ltd" }, more, null); } catch (e) { e2 = e; }
	check("new item without an Item Group in Settings: asks for it", e2 && /Item Group/.test(e2.message), e2 && e2.message);
	S.new_item_group = "Components";

	/* supplier quotation with price breaks */
	var before = created.length;
	var q = [
		{ item_code: "ABC-12345", description: "Resistor", quantity: 1, unit_price: 1.0 },
		{ item_code: "ABC-12345", description: "Resistor", quantity: 100, unit_price: 0.8 },
		{ item_code: "ABC-12345", description: "Resistor", quantity: 1000, unit_price: 0.6 }
	].map(N.normalizeLine);
	await N.matchLines(q);
	var qr = await N.createSupplierQuotation({ documentNo: "Q-55", documentDate: "2026-10-01", supplierName: "Nano Vita Ltd", currency: "EUR", validUntil: "2026-12-31" }, q, { dataUrl: D, name: "q.pdf" });
	var sq = created.slice(before).filter(function (c) { return c.dt === "Supplier Quotation"; })[0];
	check("quotation: three rows of the same item, each with its quantity and price", sq && sq.doc.items.length === 3 && sq.doc.items.map(function (i) { return i.item_code + "x" + i.qty + "@" + i.rate; }).join() === "ABC-12345x1@1,ABC-12345x100@0.8,ABC-12345x1000@0.6", sq && JSON.stringify(sq.doc.items));
	check("quotation: number, date, validity, supplier part no", sq.doc.quotation_no === "Q-55" && sq.doc.transaction_date === "2026-10-01" && sq.doc.valid_till === "2026-12-31" && sq.doc.items[0].supplier_part_no === "ABC-12345");
	check("quotation: filed under the SQTN- series, not the server default", sq.doc.naming_series === "SQTN-", JSON.stringify(sq.doc));
	check("quotation: the server's field list is read afresh", forgot.indexOf("Supplier Quotation") >= 0);
	var qArgs = { documentNo: "Q-56", documentDate: "2026-10-01", supplierName: "Nano Vita Ltd", currency: "EUR", validUntil: "2026-12-31" };
	function lastSq(b4) { return created.slice(b4).filter(function (c) { return c.dt === "Supplier Quotation"; })[0]; }
	var b4 = created.length;
	sqSeries = "PUR-SQTN-.YYYY.-\nRFQ-";
	var qr2 = await N.createSupplierQuotation(qArgs, q, null);
	check("quotation: only a PUR-SQTN- style series offered -> that one is used", lastSq(b4).doc.naming_series === "PUR-SQTN-.YYYY.-", JSON.stringify(lastSq(b4).doc));
	b4 = created.length; sqSeries = "RFQ-\nOTHER-";
	qr2 = await N.createSupplierQuotation(qArgs, q, null);
	check("quotation: no SQTN series on the server -> default, with a note", !lastSq(b4).doc.naming_series && qr2.notes.some(function (n) { return /SQTN/.test(n.message); }), JSON.stringify(qr2.notes));
	b4 = created.length; sqSeries = "RFQ-\nSQTN-"; sqValidField = "";
	qr2 = await N.createSupplierQuotation(qArgs, q, null);
	check("quotation: no valid_till field -> not sent, with a note", !lastSq(b4).doc.valid_till && qr2.notes.some(function (n) { return /valid_till/.test(n.message); }), JSON.stringify(qr2.notes));
	sqValidField = "valid_till";
	b4 = created.length; describeNone = true;
	qr2 = await N.createSupplierQuotation(qArgs, q, null);
	describeNone = false;
	check("quotation: field list unreadable -> SQTN- and valid_till are still sent", lastSq(b4).doc.naming_series === "SQTN-" && lastSq(b4).doc.valid_till === "2026-12-31", JSON.stringify(lastSq(b4).doc));
	check("quotation: file attached as a normal attachment", attached[attached.length - 1].dt === "Supplier Quotation" && qr.file.state === "created");

	/* waybill */
	var found = await N.findByAwb("1234 5678 90");
	check("AWB finds the Purchase Order that carries it", found.orders.length === 1 && found.orders[0].name === "PO-08353" && found.orders[0].submitted, JSON.stringify(found));
	var rc = await N.createReceipts(["PO-08353"], "1234567890", { dataUrl: D, name: "awb.pdf" });
	var pr = created.filter(function (c) { return c.dt === "Purchase Receipt"; })[0];
	check("receipt made through ERPNext's own mapper, local markers stripped, AWB set", methods.some(function (m) { return /make_purchase_receipt/.test(m[0]) && m[1].source_name === "PO-08353"; }) && pr && !("__islocal" in pr.doc) && !("__islocal" in pr.doc.items[0]) && pr.doc.tracking_awb_no === "1234567890" && pr.doc.items[0].purchase_order === "PO-08353", JSON.stringify(pr));
	check("waybill attached to the new receipt", rc[0].name && rc[0].file.state === "created" && attached[attached.length - 1].dt === "Purchase Receipt", JSON.stringify(rc));

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
