/* test_field_routing.js — an invoice fills Document No / Document Date / File and nothing of the CD, CD invoice or
   shipping sections; a customs declaration (etc.) fills its own section fields and its own file field. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/accdoc.js");
var created = [], attached = [], updates = [];
var sandbox = { window: {}, console: console };
sandbox.window.CS_ERP = { shared: {
	getList: function () { return Promise.resolve([]); },
	attachFile: function (dt, name, d, fn, field) { attached.push({ name: name, field: field }); return Promise.resolve({ state: "created", url: "/private/files/" + fn }); },
	fetchDoc: function (dt, n) { return Promise.resolve({ name: n, naming_series: "PURCHASE-", is_parent_document: 1, document_no: "INV-1", document_date: "2026-10-01" }); },
	clean: function (dt, doc, notes) { return Promise.resolve({ doc: doc, notes: notes }); },
	createDoc: function (dt, doc) { created.push(doc); return Promise.resolve("ACC-" + created.length); },
	updateDoc: function (dt, n, p) { updates.push(p); return Promise.resolve({}); }
} };
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(file, "utf8"), sandbox);
var ACC = sandbox.window.CS_ACC, fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }
var SECTION_KEYS = /^(cd_|customs_declaration|invoice_for_|shipping_)/;
var D = "data:application/pdf;base64,QUJD";

(async function () {
	var f = { documentNo: "MTPA261000114", documentDate: "2026-10-09", supplierName: "Skubios siuntos", supplierCode: "LT1" };
	var r = await ACC.createMain(f, D, "inv.pdf");
	var d = created[0];
	check("invoice: Document No and Document Date set", d.document_no === "MTPA261000114" && d.document_date === "2026-10-09", JSON.stringify(d));
	check("invoice: no CD / CD invoice / shipping field at all", !Object.keys(d).some(function (k) { return SECTION_KEYS.test(k); }), JSON.stringify(d));
	check("invoice: file goes to “file” only", attached.length === 1 && attached[0].field === "file", JSON.stringify(attached));
	check("invoice: only its own received box", d.purchase_invoice_received === 1);

	var cases = [["cd", "cd_file", "cd_document_no", "cd_date"], ["cdInvoice", "cd_invoice_file", "cd_invoice_document_no", "cd_invoice_date"], ["shipping", "shipping_invoice_file", "shipping_invoice_document_no", "shipping_invoice_date"]];
	for (var i = 0; i < cases.length; i++) {
		var c = cases[i]; attached.length = 0;
		await ACC.createChild(c[0], "ACC-1", { documentNo: "X-" + i, documentDate: "2026-10-10", supplierName: "Agent" }, D, "s.pdf");
		var ch = created[created.length - 1];
		check(c[0] + ": own number/date fields filled", ch[c[2]] === "X-" + i && ch[c[3]] === "2026-10-10", JSON.stringify(ch));
		check(c[0] + ": file goes to " + c[1] + " only", attached.length === 1 && attached[0].field === c[1], JSON.stringify(attached));
		check(c[0] + ": other sections stay empty", !Object.keys(ch).some(function (k) { return SECTION_KEYS.test(k) && [c[1], c[2], c[3]].indexOf(k) < 0 && !/_supplier|_provider|_service|received|invoice_for|customs_declaration_cd_received/.test(k); }), JSON.stringify(ch));
	}
	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
