/* test_charges.js — VAT / shipping / handling / other charges become rows of the Purchase Taxes and Charges table
   (newdocs.js), against a fake test server. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var dir = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var created = [];
var S = { erp_test_url: "https://test.example.com", new_item_group: "Components", new_stock_uom: "Nos", new_company: "", new_taxes: "",
	new_vat_account: "", new_shipping_account: "", new_other_account: "", new_charge_category: "", new_cost_center: "" };
var accounts = [
	{ name: "2441 - PVM pirkimų - IO", account_type: "Tax", root_type: "Asset" },
	{ name: "4430 - Transportas - IO", account_type: "Chargeable", root_type: "Expense" },
	{ name: "6000 - Draudimas - IO", account_type: "", root_type: "Expense" },
	{ name: "5000 - Pardavimai - IO", account_type: "", root_type: "Income" }
];
var template = [{ account_head: "2441 - PVM pirkimų - IO", rate: 21 }];
var noAccounts = false;
var fake = {
	getList: function (dt) {
		if (dt === "Item") return Promise.resolve([{ name: "ABC-1", item_code: "ABC-1", item_name: "Resistor" }]);
		if (dt === "Supplier") return Promise.resolve([{ name: "Nano Vita Ltd", supplier_name: "Nano Vita Ltd", reg_number: "", tax_id: "" }]);
		if (dt === "Company") return Promise.resolve([{ name: "Integrated Optics UAB", default_currency: "EUR" }]);
		if (dt === "Account") return noAccounts ? Promise.reject(new Error("no permission")) : Promise.resolve(accounts.slice());
		return Promise.resolve([]);
	},
	fetchDoc: function (dt, name) {
		if (dt === "Purchase Taxes and Charges Template") return Promise.resolve(name === "Lithuania VAT 21%" ? { name: name, taxes: template } : null);
		if (dt === "Purchase Invoice") return Promise.resolve({ name: name, grand_total: 110.5 });
		return Promise.resolve(null);
	},
	describe: function () { return Promise.resolve({ fields: { scanned_invoice: {}, bill_no: {} }, complete: true }); },
	clean: function (dt, doc, notes) { return Promise.resolve({ doc: doc, notes: notes }); },
	createDoc: function (dt, doc) { created.push({ dt: dt, doc: JSON.parse(JSON.stringify(doc)) }); return Promise.resolve("X-" + created.length); },
	attachFile: function () { return Promise.resolve({ state: "created", url: "/private/files/x.pdf" }); },
	callMethod: function () { return Promise.resolve(null); }
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
	var raw = [
		{ kind: "VAT", description: "PVM 21%", rate: 21, amount: "17,50" },
		{ kind: "shipping", description: "Shipping & handling", amount: 10 },
		{ kind: "discount", description: "Nuolaida", amount: 5 },
		{ kind: "vat", description: "PVM 0%", rate: 0, amount: 0 },
		{ kind: "something odd", description: "Bank fee", amount: 1.5 },
		{ kind: "handling", description: "no amount" }
	];
	var ch = N.normalizeCharges(raw);
	check("zero and missing amounts are dropped, 4 charges left", ch.length === 4, JSON.stringify(ch));
	check("European decimal comma is read", ch[0].kind === "vat" && ch[0].amount === 17.5 && ch[0].rate === 21);
	check("a discount is always negative", ch[2].kind === "discount" && ch[2].amount === -5);
	check("an unknown kind is 'other'", ch[3].kind === "other");
	check("sum of charges", N.chargesSum(ch) === 24, N.chargesSum(ch));

	var lines = [{ code: "ABC-1", qty: 100, rate: 0.85 }, { code: "X", qty: 1, rate: 10 }];
	var t = N.totalCheck(lines, ch, 119);
	check("lines 95 + charges 24 = 119: matches the document total", t.lines === 95 && t.sum === 119 && t.ok === true, JSON.stringify(t));
	check("a different total is flagged with the difference", N.totalCheck(lines, ch, 120).ok === false && N.totalCheck(lines, ch, 120).diff === -1);
	check("no total known: no verdict", N.totalCheck(lines, ch, null).ok === null);

	/* accounts found from the company's chart (no settings, no template) */
	var notes = [];
	var rows = await N.taxRows(ch, "Integrated Optics UAB", notes);
	check("VAT row: the Tax account of the chart, charge type Actual, category Total", rows[0] && rows[0].account_head === "2441 - PVM pirkimų - IO" && rows[0].charge_type === "Actual" &&
		rows[0].category === "Total" && rows[0].add_deduct_tax === "Add" && rows[0].tax_amount === 17.5 && rows[0].description === "PVM 21%", JSON.stringify(rows[0]));
	check("shipping row: the transport account", rows[1] && rows[1].account_head === "4430 - Transportas - IO" && rows[1].tax_amount === 10, JSON.stringify(rows[1]));
	check("discount and 'other' have no account in the chart: left out and said so, with the 'Other charges' setting named", rows.length === 2 && notes.length === 2 &&
		/Nuolaida/.test(notes[0].message) && /Bank fee/.test(notes[1].message) && /Settings/.test(notes[0].message), JSON.stringify(notes));

	/* settings win; the template is used when no setting and accounts are unreadable */
	N.forgetAccounts();
	S.new_vat_account = "2449 - VAT - IO"; S.new_shipping_account = "4400 - Freight - IO"; S.new_other_account = "6900 - Other - IO";
	S.new_charge_category = "Valuation and Total"; S.new_cost_center = "Main - IO";
	rows = await N.taxRows(ch, "Integrated Optics UAB", []);
	check("a discount is a Deduct row with a positive amount", rows[2] && rows[2].add_deduct_tax === "Deduct" && rows[2].tax_amount === 5, JSON.stringify(rows));
	check("accounts from Settings are used", rows[0].account_head === "2449 - VAT - IO" && rows[1].account_head === "4400 - Freight - IO" && rows[2].account_head === "6900 - Other - IO" && rows[3].account_head === "6900 - Other - IO", JSON.stringify(rows));
	check("category from Settings for charges, never for VAT; cost center on every row", rows[0].category === "Total" && rows[1].category === "Valuation and Total" && rows.every(function (r) { return r.cost_center === "Main - IO"; }), JSON.stringify(rows));
	S.new_vat_account = ""; S.new_shipping_account = ""; S.new_other_account = ""; S.new_charge_category = ""; S.new_cost_center = "";
	N.forgetAccounts(); noAccounts = true; S.new_taxes = "Lithuania VAT 21%";
	rows = await N.taxRows([ch[0]], "Integrated Optics UAB", []);
	check("VAT account taken from the tax template when the account list cannot be read", rows[0] && rows[0].account_head === "2441 - PVM pirkimų - IO", JSON.stringify(rows));
	noAccounts = false; S.new_taxes = ""; N.forgetAccounts();

	/* a Purchase Invoice carries the rows, and not the template name */
	var f = { documentNo: "INV-1", documentDate: "2026-10-09", supplierName: "Nano Vita Ltd", currency: "EUR", totalAmount: 110.5 };
	var ln = [{ item_code: "ABC-1", description: "Resistor", quantity: 100, unit_price: 0.85 }].map(N.normalizeLine);
	await N.matchLines(ln);
	var r = await N.createPurchaseInvoice(f, ln, { dataUrl: D, name: "i.pdf" }, ch);
	var pi = created.filter(function (c) { return c.dt === "Purchase Invoice"; })[0];
	check("Purchase Invoice has the taxes table with the two rows that have accounts", pi && pi.doc.taxes && pi.doc.taxes.length === 2 && !pi.doc.taxes_and_charges, JSON.stringify(pi && pi.doc.taxes));
	check("the row left out is reported in the result notes", r.notes.some(function (n) { return /Bank fee/.test(n.message); }) && r.notes.some(function (n) { return /Nuolaida/.test(n.message); }), JSON.stringify(r.notes));
	check("the invoice was still created and the total compared (110.5 equals the document)", r.name && !r.note, JSON.stringify(r));

	/* no charges: the template name is kept as before */
	S.new_taxes = "Lithuania VAT 21%";
	await N.createPurchaseInvoice(f, ln, null, []);
	var pi2 = created.filter(function (c) { return c.dt === "Purchase Invoice"; })[1];
	check("without charges the configured template is set as before and no rows are made up", pi2.doc.taxes_and_charges === "Lithuania VAT 21%" && !pi2.doc.taxes, JSON.stringify(pi2.doc));

	/* a Supplier Quotation carries them too */
	S.new_taxes = "";
	var sq = await N.createSupplierQuotation({ documentNo: "Q-1", documentDate: "2026-10-09", supplierName: "Nano Vita Ltd", currency: "EUR" }, ln, null, [ch[1]]);
	var q = created.filter(function (c) { return c.dt === "Supplier Quotation"; })[0];
	check("Supplier Quotation has the shipping row", q && q.doc.taxes && q.doc.taxes.length === 1 && q.doc.taxes[0].account_head === "4430 - Transportas - IO", JSON.stringify(q && q.doc));

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log("CRASH", e && e.stack || e); process.exit(1); });
