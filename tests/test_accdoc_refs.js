/* test_accdoc_refs.js — parent search by shared numbers, PO checks and plain attachments in accdoc.js,
   against a stub of the ERPNext layer. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/accdoc.js");
var calls = [], rows = [], purchaseOrders = ["PO-08258"];
var sandbox = { window: {}, console: console };
sandbox.window.CS_ERP = { shared: {
	getList: function (dt, filters, fields, limit, order) {
		calls.push({ dt: dt, filters: filters, order: order });
		if (dt === "Accounts Document") return Promise.resolve(rows);
		if (dt === "Purchase Order") return Promise.resolve(purchaseOrders.indexOf(filters[0][2]) >= 0 ? [{ name: filters[0][2] }] : []);
		if (dt === "Sales Invoice") return Promise.reject(new Error("no permission"));
		return Promise.resolve([]);
	},
	attachFile: function (dt, name, data, fn, field) { calls.push({ attach: [dt, name, fn, field] }); return Promise.resolve({ state: "created" }); }
} };
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(file, "utf8"), sandbox);
var ACC = sandbox.window.CS_ACC, fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }

rows = [
	{ name: "ACC-1", naming_series: "PURCHASE-", supplier: "Shenzhen Flygold Circuit Co., Limited", document_date: "2026-08-22", document_no: "20260730-FG394", purchase_order_reference: "PO-08258", cd_document_no: "26LTVA100025C7F4R1" },
	{ name: "ACC-2", naming_series: "SALES-", customer: "UniNanoTech Co., Ltd.", document_date: "2026-09-23", document_no: "IO26-02602", sales_invoice_reference: "IO26-02602" },
	{ name: "ACC-3", naming_series: "PROFORMA-", supplier: "Shenzhen Best Parts Co., Ltd", document_date: "2026-09-15", document_no: "BST260915-B17720", purchase_order_reference: "PO-08353" },
	{ name: "ACC-4", naming_series: "PURCHASE-", supplier: "Other Supplier UAB", document_date: "2026-08-23", document_no: "X-1" }
];
(async function () {
	var p = await ACC.suggestParents({ documentNo: "VS396551", references: ["26LTVA100025C7F4R1", "5554865912"], supplierName: "UAB DHL LIETUVA", documentDate: "2026-08-26" });
	check("DHL clearance invoice finds the purchase through the customs declaration number", p[0] && p[0].name === "ACC-1" && p[0].exact && /customs declaration no/.test(p[0].reasons.join()), JSON.stringify(p));
	check("searched every series, newest first", calls[0].filters === null && calls[0].order === "modified desc");

	p = await ACC.suggestParents({ documentNo: "", references: ["PO:08353", "877621665538"], documentDate: "2026-09-16" });
	check("payment order finds the proforma by 'PO:08353'", p[0] && p[0].name === "ACC-3" && p[0].series === "PROFORMA-", JSON.stringify(p));

	p = await ACC.suggestParents({ documentNo: "", references: ["IO26-02602", "877621665538"], documentDate: "2026-09-23" });
	check("export declaration finds the sales record by the invoice number", p[0] && p[0].name === "ACC-2", JSON.stringify(p));

	p = await ACC.suggestParents({ documentNo: "ZZ-9", supplierName: "Nobody", documentDate: "2025-01-01" });
	check("nothing matches: no suggestion", p.length === 0, JSON.stringify(p));

	var r = await ACC.checkReferences(["PO:08258", "PO-08353"], "IO26-02602");
	check("PO check: exists / missing, spelling normalised", r.po["PO-08258"] === true && r.po["PO-08353"] === false, JSON.stringify(r));
	check("a sales invoice that cannot be read is neither confirmed nor flagged", r.salesInvoice === null);

	var a = await ACC.attachToParent("ACC-1", "data:application/pdf;base64,QUJD", "waybill.pdf");
	check("attachment: plain file on the chosen record, no field", a.name === "ACC-1" && a.file.state === "created" &&
		calls[calls.length - 1].attach[3] === "" && calls[calls.length - 1].attach[0] === "Accounts Document");
	var e = null; try { await ACC.attachToParent("", "x", "y"); } catch (x) { e = x; }
	check("attachment without a record is refused", !!e);

	/* PO handling in the patch */
	var pm = ACC.sectionPatch("main", { documentNo: "N1", documentDate: "2026-01-01", supplierName: "S", poMatched: ["PO-08353"], purchaseOrderReference: "PO-08353" });
	check("matched PO fills the Link field, no comment", pm.purchase_order_reference === "PO-08353" && !pm.comment);
	var pu = ACC.sectionPatch("main", { documentNo: "N1", documentDate: "2026-01-01", supplierName: "S", poUnmatched: ["PO-09999"], purchaseOrderReference: "PO-09999" });
	check("unmatched PO is left out and written to the comment for the logistics specialist",
		!pu.purchase_order_reference && /PO-09999/.test(pu.comment) && /manually/.test(pu.comment), JSON.stringify(pu));
	var pn = ACC.sectionPatch("main", { documentNo: "N1", documentDate: "2026-01-01", supplierName: "S", purchaseOrderReference: "PO-1" });
	check("not checked (offline): the PO is passed through unchanged", pn.purchase_order_reference === "PO-1");

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
