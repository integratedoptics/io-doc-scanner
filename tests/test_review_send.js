/* test_review_send.js — the manual-review note travels with the document: Accounts Document comment (live server)
   and remarks of Purchase Invoice / Purchase Receipt (test server); a Supplier Quotation without a remarks field says so. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var dir = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var created = [], remarksField = true, quotationHasRemarks = false, receiptDoc = null;
var S = { erp_test_url: "https://test.example.com", new_item_group: "Components", new_stock_uom: "Nos", new_company: "", new_taxes: "",
	new_vat_account: "", new_shipping_account: "", new_other_account: "", new_charge_category: "", new_cost_center: "" };
var fake = {
	getList: function (dt) {
		if (dt === "Item") return Promise.resolve([{ name: "ABC-1", item_code: "ABC-1", item_name: "Resistor" }]);
		if (dt === "Supplier") return Promise.resolve([{ name: "Nano Vita Ltd", supplier_name: "Nano Vita Ltd", reg_number: "", tax_id: "" }]);
		if (dt === "Company") return Promise.resolve([{ name: "IO", default_currency: "EUR" }]);
		return Promise.resolve([]);
	},
	fetchDoc: function (dt, name) { return Promise.resolve(dt === "Accounts Document" ? { name: name, naming_series: "PURCHASE-", is_parent_document: 1, document_no: "INV-9", document_date: "2026-09-01" } : null); },
	describe: function (dt) {
		var f = { scanned_invoice: {}, bill_no: {}, tracking_awb_no: {} };
		if (dt === "Purchase Invoice" && remarksField) f.remarks = {};
		if (dt === "Purchase Receipt") f.remarks = {};
		if (dt === "Supplier Quotation" && quotationHasRemarks) f.remarks = {};
		return Promise.resolve({ fields: f, complete: true });
	},
	clean: function (dt, doc, notes) { return Promise.resolve({ doc: doc, notes: notes }); },
	createDoc: function (dt, doc) { created.push({ dt: dt, doc: JSON.parse(JSON.stringify(doc)) }); return Promise.resolve("X-" + created.length); },
	attachFile: function () { return Promise.resolve({ state: "created", url: "/private/files/x.pdf" }); },
	callMethod: function () { return Promise.resolve({ doctype: "Purchase Receipt", remarks: "from the PO", items: [] }); },
	updateDoc: function () { return Promise.resolve({}); }
};
var sandbox = { window: {}, console: console };
sandbox.window.CS_ERP = { shared: fake };
sandbox.window.CS_ERP_TEST = { shared: fake };
sandbox.window.CS = { settings: function () { return S; } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(dir + "accdoc.js", "utf8"), sandbox);
vm.runInContext(fs.readFileSync(dir + "newdocs.js", "utf8"), sandbox);
var ACC = sandbox.window.CS_ACC, N = sandbox.window.CS_NEW, fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }
var D = "data:application/pdf;base64,QUJD";
var NOTE = "Manual review: Checked — OK — 3 of 3 values checked. Reviewed by Evaldas, 2026-10-16 14:20.\nNote: total matches";
function last(dt) { return created.filter(function (c) { return c.dt === dt; }).pop(); }

(async function () {
	/* live server */
	await ACC.createMain({ documentNo: "INV-1", documentDate: "2026-09-01", supplierName: "", namingSeries: "PURCHASE-", reviewNote: NOTE }, D, "i.pdf");
	var a = last("Accounts Document");
	check("a new Accounts Document carries the review in its comment", a && a.doc.comment === NOTE, JSON.stringify(a && a.doc));
	await ACC.createMain({ documentNo: "INV-2", documentDate: "2026-09-01", namingSeries: "PURCHASE-", poUnmatched: ["PO-1"], poMatched: [], reviewNote: NOTE }, D, "i.pdf");
	a = last("Accounts Document");
	check("…after the unmatched-PO remark, not instead of it", /could not be matched/.test(a.doc.comment) && a.doc.comment.indexOf(NOTE) > 0, a.doc.comment);
	await ACC.createMain({ documentNo: "INV-3", documentDate: "2026-09-01", namingSeries: "PURCHASE-" }, D, "i.pdf");
	a = last("Accounts Document");
	check("no review recorded: no comment is made up", !a.doc.comment, JSON.stringify(a.doc));
	await ACC.createChild("cd", "ACC-1", { documentNo: "26LTVA1", documentDate: "2026-09-02", reviewNote: NOTE }, D, "cd.pdf");
	a = last("Accounts Document");
	check("a customs declaration record carries it too", a.doc.comment === NOTE, JSON.stringify(a.doc));
	await ACC.createChild("attachment", "ACC-1", { comment: "Waybill", reviewNote: NOTE }, D, "w.pdf");
	a = last("Accounts Document");
	check("an attachment keeps its own comment and adds the review", a.doc.comment === "Waybill\n" + NOTE, a.doc.comment);

	/* test server */
	var f = { documentNo: "INV-1", documentDate: "2026-09-01", supplierName: "Nano Vita Ltd", currency: "EUR", reviewNote: NOTE };
	var ln = [{ item_code: "ABC-1", description: "Resistor", quantity: 10, unit_price: 1 }].map(N.normalizeLine);
	await N.matchLines(ln);
	await N.createPurchaseInvoice(f, ln, null, []);
	var pi = last("Purchase Invoice");
	check("Purchase Invoice remarks = the review note", pi.doc.remarks === NOTE, JSON.stringify(pi.doc.remarks));
	remarksField = false; N.useServer(null);   /* forget the cached field names */
	var r = await N.createPurchaseInvoice(Object.assign({}, f, { documentNo: "INV-2" }), ln, null, []);
	pi = last("Purchase Invoice");
	check("a server without a remarks field: not set, no error", pi.doc.remarks === undefined && !!r.name);
	remarksField = true; N.useServer(null);
	await N.createPurchaseInvoice({ documentNo: "INV-4", documentDate: "2026-09-01", supplierName: "Nano Vita Ltd", currency: "EUR" }, ln, null, []);
	check("no review: no remarks", last("Purchase Invoice").doc.remarks === undefined);

	var q = await N.createSupplierQuotation({ documentNo: "Q-1", documentDate: "2026-09-01", supplierName: "Nano Vita Ltd", currency: "EUR", reviewNote: NOTE }, ln, null, []);
	check("a Supplier Quotation without a remarks field: not set, and the result says where the review went", last("Supplier Quotation").doc.remarks === undefined &&
		q.notes.some(function (n) { return /upload history/.test(n.message); }), JSON.stringify(q.notes));
	quotationHasRemarks = true; N.useServer(null);
	await N.createSupplierQuotation({ documentNo: "Q-2", documentDate: "2026-09-01", supplierName: "Nano Vita Ltd", currency: "EUR", reviewNote: NOTE }, ln, null, []);
	check("…and with one it is filled", last("Supplier Quotation").doc.remarks === NOTE);

	var rs = await N.createReceipts(["PO-1"], "5554865912", { dataUrl: D, name: "w.pdf" }, NOTE);
	var pr = last("Purchase Receipt");
	check("Purchase Receipt remarks: the PO's own remark is kept and the review added", rs[0].name && pr.doc.remarks === "from the PO\n" + NOTE, JSON.stringify(pr && pr.doc.remarks));

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log("CRASH", e && e.stack || e); process.exit(1); });
