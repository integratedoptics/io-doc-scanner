/* test_accdoc_refs.js — parent search by shared numbers, PO checks and plain attachments in accdoc.js,
   against a stub of the ERPNext layer. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/accdoc.js");
var created = [], updates = [], failUpdate = false, docs = { "ACC-1": { name: "ACC-1", naming_series: "PURCHASE-" }, "ACC-3": { name: "ACC-3", naming_series: "PROFORMA-", is_parent_document: 1 }, "ACC-C": { name: "ACC-C", naming_series: "PURCHASE-", parent_document: "ACC-1" } };
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
	attachFile: function (dt, name, data, fn, field) { calls.push({ attach: [dt, name, fn, field] }); return Promise.resolve({ state: "created", name: "F-" + name, url: "/private/files/" + name + "-" + (field || "x") + ".pdf" }); },
	fetchDoc: function (dt, name) { return Promise.resolve(docs[name] || null); },
	clean: function (dt, doc, notes) { return Promise.resolve({ doc: doc, notes: notes }); },
	createDoc: function (dt, doc) { created.push(doc); return Promise.resolve("ACC-NEW-" + created.length); },
	updateDoc: function (dt, name, patch) { if (failUpdate) return Promise.reject(new Error("no")); updates.push([name, patch]); return Promise.resolve({}); }
} };
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(file, "utf8"), sandbox);
var ACC = sandbox.window.CS_ACC, fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }

rows = [
	{ name: "ACC-1", naming_series: "PURCHASE-", supplier: "Shenzhen Flygold Circuit Co., Limited", document_date: "2026-08-22", document_no: "20260730-FG394", purchase_order_reference: "PO-08258", cd_document_no: "26LTVA100025C7F4R1" },
	{ name: "ACC-2", naming_series: "SALES-", customer: "UniNanoTech Co., Ltd.", document_date: "2026-09-23", document_no: "IO26-02602", sales_invoice_reference: "IO26-02602" },
	{ name: "ACC-3", naming_series: "PROFORMA-", supplier: "Shenzhen Best Parts Co., Ltd", document_date: "2026-09-15", document_no: "BST260915-B17720", purchase_order_reference: "PO-08353" },
	{ name: "ACC-4", naming_series: "PURCHASE-", supplier: "Other Supplier UAB", document_date: "2026-08-23", document_no: "X-1" },
	{ name: "ACC-C", naming_series: "PURCHASE-", supplier: "Shenzhen Flygold Circuit Co., Limited", document_date: "2026-08-22", cd_document_no: "26LTVA100025C7F4R1", parent_document: "ACC-1" }
];
(async function () {
	var p = await ACC.suggestParents({ documentNo: "VS396551", references: ["26LTVA100025C7F4R1", "5554865912"], supplierName: "UAB DHL LIETUVA", documentDate: "2026-08-26" });
	check("DHL clearance invoice finds the purchase through the customs declaration number", p[0] && p[0].name === "ACC-1" && p[0].exact && /customs declaration no/.test(p[0].reasons.join()), JSON.stringify(p));
	check("a child record is never offered as a parent", p.every(function (x) { return x.name !== "ACC-C"; }), JSON.stringify(p));
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

	var a = await ACC.attachToParent("ACC-1", "data:application/pdf;base64,QUJD", "waybill.pdf", "Waybill — waybill.pdf");
	var c0 = created[created.length - 1];
	check("attachment: a child record of the chosen parent, same series, file in `file`, no other field",
		a.name === "ACC-NEW-1" && a.parent === "ACC-1" && a.file.state === "created" && c0.parent_document === "ACC-1" &&
		c0.naming_series === "PURCHASE-" && c0.comment === "Waybill — waybill.pdf" && !c0.purchase_invoice_received && !c0.is_parent_document &&
		calls[calls.length - 1].attach[1] === "ACC-NEW-1" && calls[calls.length - 1].attach[3] === "file", JSON.stringify([a, c0]));
	check("the parent gets is_parent_document = 1 when it was not marked", updates.length === 1 && updates[0][0] === "ACC-1" && updates[0][1].is_parent_document === 1, JSON.stringify(updates));
	var a3 = await ACC.attachToParent("ACC-3", "data:application/pdf;base64,QUJD", "pay.pdf", "Payment order");
	check("child of a PROFORMA- gets the PROFORMA- series; an already marked parent is not updated again",
		created[created.length - 1].naming_series === "PROFORMA-" && updates.length === 1, JSON.stringify(updates));

	var cd = await ACC.createChild("cd", "ACC-1", { documentNo: "26LTVA100025C7F4R1", documentDate: "2026-08-25", supplierName: "Muitinės departamentas" }, "data:application/pdf;base64,QUJD", "cd.pdf");
	var c1 = created[created.length - 1];
	check("customs declaration: separate child record with its own section, linked to the parent",
		c1.parent_document === "ACC-1" && c1.naming_series === "PURCHASE-" && c1.cd_document_no === "26LTVA100025C7F4R1" && c1.customs_declaration_cd_received === 1 &&
		!c1.document_no && !c1.purchase_invoice_received && calls[calls.length - 1].attach[3] === "cd_file" && cd.parent === "ACC-1", JSON.stringify(c1));
	var pu = updates[updates.length - 1];
	check("customs declaration: the PARENT's cd_file shows the child's file and its section is switched on",
		pu[0] === "ACC-1" && pu[1].cd_file === "/private/files/ACC-NEW-3-cd_file.pdf" && pu[1].customs_declaration_cd_received === 1, JSON.stringify(updates));
	check("the child keeps its own file in its own cd_file", calls[calls.length - 1].attach[1] === "ACC-NEW-3" && calls[calls.length - 1].attach[3] === "cd_file");
	var sh = await ACC.createChild("shipping", "ACC-1", { documentNo: "VS396551", documentDate: "2026-08-26", supplierName: "UAB DHL LIETUVA" }, "x", "s.pdf");
	check("shipping invoice child uses the shipping section and file field", created[created.length - 1].shipping_invoice_document_no === "VS396551" && calls[calls.length - 1].attach[3] === "shipping_invoice_file");
	var pu2 = updates[updates.length - 1];
	check("shipping invoice: the parent's shipping_invoice_file links to the child's file", pu2[1].shipping_invoice_file === "/private/files/ACC-NEW-4-shipping_invoice_file.pdf" && pu2[1].invoice_for_shipping_received === 1, JSON.stringify(pu2));
	var ci = await ACC.createChild("cdInvoice", "ACC-3", { documentNo: "VS1", documentDate: "2026-09-01", supplierName: "UAB DHL LIETUVA" }, "x", "ci.pdf");
	var pu3 = updates[updates.length - 1];
	check("CD invoice: the parent's cd_invoice_file links to the child's file; an already marked parent keeps its mark untouched", pu3[0] === "ACC-3" && /cd_invoice_file/.test(JSON.stringify(pu3[1])) && !("is_parent_document" in pu3[1]), JSON.stringify(pu3));
	failUpdate = true; docs["ACC-9"] = { name: "ACC-9", naming_series: "SALES-" };
	var warn = await ACC.createChild("cdInvoice", "ACC-9", { documentNo: "N", documentDate: "2026-01-01", supplierName: "S" }, "x", "i.pdf");
	check("if the parent cannot be marked, the child still exists and a note says so", warn.name && warn.notes.some(function (n) { return /parent document/.test(n.message); }), JSON.stringify(warn));
	failUpdate = false;
	var e2 = null; try { await ACC.createChild("cd", "ACC-C", { documentNo: "N" }, "x", "y"); } catch (x) { e2 = x; }
	check("a child cannot be chosen as a parent", !!e2 && /child of ACC-1/.test(e2.message), e2 && e2.message);
	var e3 = null; try { await ACC.createChild("cd", "NOPE", { documentNo: "N" }, "x", "y"); } catch (x) { e3 = x; }
	check("an unknown parent is reported", !!e3 && /NOPE/.test(e3.message));

	var cm = await ACC.createMain({ documentNo: "N1", documentDate: "2026-01-01", supplierName: "S", namingSeries: "SALES-" }, "x", "m.pdf");
	var cmd = created[created.length - 1];
	check("a main document (purchase / sales / proforma invoice) is always saved as a parent document", cmd.is_parent_document === 1 && cmd.naming_series === "SALES-" && !cmd.parent_document, JSON.stringify(cmd));
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
