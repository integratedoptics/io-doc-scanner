/* test_supplier_link.js — a supplier read off a document reaches the ERPNext record: confident matches are
   linked to the stored Supplier name, unknown ones are kept in the comment. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/accdoc.js");
var created = [];
var suppliers = [
	{ name: 'UAB "Skubios siuntos"', supplier_name: 'UAB "Skubios siuntos"', reg_number: "", tax_id: "LT100007179012" },
	{ name: "Nano Vita Ltd", supplier_name: "Nano Vita Ltd", reg_number: "", tax_id: "" },
	{ name: "Acme Trading UAB", supplier_name: "Acme Trading UAB", reg_number: "", tax_id: "" },
	{ name: "Acme Trading Ltd", supplier_name: "Acme Trading Ltd", reg_number: "", tax_id: "" }
];
var docs = { "ACC-1": { name: "ACC-1", naming_series: "PURCHASE-", is_parent_document: 1, parent_document: "ACC-1", document_no: "A1", document_date: "2026-10-01" } };
var sandbox = { window: {}, console: console };
sandbox.window.CS_ERP = { shared: {
	getList: function (dt, filters) {
		if (dt !== "Supplier") return Promise.resolve([]);
		if (filters) return Promise.resolve(suppliers.filter(function (s) { return s.supplier_name.toLowerCase() === String(filters[0][2]).toLowerCase(); }));
		return Promise.resolve(suppliers);
	},
	attachFile: function () { return Promise.resolve({ state: "created", url: "/private/files/x.pdf" }); },
	fetchDoc: function (dt, name) { return Promise.resolve(docs[name] || null); },
	/* like the real clean(): a Link to a Supplier that does not exist is dropped */
	clean: function (dt, doc, notes) {
		["supplier", "cd_supplier"].forEach(function (k) {
			if (doc[k] && !suppliers.some(function (s) { return s.name === doc[k]; })) { delete doc[k]; notes.push({ message: "left out " + k }); }
		});
		return Promise.resolve({ doc: doc, notes: notes });
	},
	createDoc: function (dt, doc) { created.push(doc); return Promise.resolve("ACC-NEW-" + created.length); },
	updateDoc: function () { return Promise.resolve({}); }
} };
vm.createContext(sandbox); vm.runInContext(fs.readFileSync(file, "utf8"), sandbox);
var ACC = sandbox.window.CS_ACC, fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }

(async function () {
	var f = { documentNo: "MTPA1", documentDate: "2026-10-09", supplierName: "SKUBIOS SIUNTOS, UAB", supplierCode: "LT100007179012" };
	await ACC.createMain(f, "data:application/pdf;base64,QUJD", "a.pdf");
	var d = created[created.length - 1];
	check("printed name in other case/order is written as the stored Supplier", d.supplier === 'UAB "Skubios siuntos"', JSON.stringify(d));
	check("supplier code is written too", d.supplier_code === "LT100007179012");
	check("no 'please set manually' comment when the supplier was linked", !d.comment, d.comment);

	await ACC.createMain({ documentNo: "N1", documentDate: "2026-10-09", supplierName: "Skubios siuntos" }, "data:application/pdf;base64,QUJD", "a.pdf");
	check("name without legal form still links", created[created.length - 1].supplier === 'UAB "Skubios siuntos"', JSON.stringify(created[created.length - 1]));

	await ACC.createMain({ documentNo: "N2", documentDate: "2026-10-09", supplierName: "Totally New Supplier GmbH" }, "data:application/pdf;base64,QUJD", "a.pdf");
	d = created[created.length - 1];
	check("unknown supplier: left out of the Link but written to the comment", !d.supplier && /Totally New Supplier GmbH/.test(d.comment || ""), JSON.stringify(d));

	await ACC.createMain({ documentNo: "N3", documentDate: "2026-10-09", supplierName: "Acme Trading" }, "data:application/pdf;base64,QUJD", "a.pdf");
	d = created[created.length - 1];
	check("two equally good suppliers: not guessed", !d.supplier, JSON.stringify(d));

	var f2 = { documentNo: "N4", documentDate: "2026-10-09", supplierName: "x", supplierLink: "Nano Vita Ltd" };
	await ACC.createMain(f2, "data:application/pdf;base64,QUJD", "a.pdf");
	check("a supplier the employee picked is kept", created[created.length - 1].supplier === "Nano Vita Ltd");

	await ACC.createChild("cd", "ACC-1", { documentNo: "26LT1", documentDate: "2026-10-09", supplierName: "SKUBIOS SIUNTOS, UAB", supplierCode: "LT100007179012" }, "data:application/pdf;base64,QUJD", "cd.pdf");
	d = created[created.length - 1];
	check("customs declaration party links to the stored Supplier", d.cd_supplier === 'UAB "Skubios siuntos"', JSON.stringify(d));

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
