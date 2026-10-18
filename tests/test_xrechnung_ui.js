/* test_xrechnung_ui.js — 1.8.0: the "Sales invoices -> XRechnung" card on the Export screen, with a fake ERPNext.
       JSDOM_PATH=/tmp/jsd/node_modules/jsdom node tests/test_xrechnung_ui.js */
"use strict";
var fs = require("fs"), path = require("path");
var JSDOM;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; }
catch (e) { console.log("skipped: jsdom is not installed (set JSDOM_PATH)"); process.exit(0); }
var A = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var raw = fs.readFileSync(A + "index.html", "utf8");
var scripts = (raw.match(/<script src="[^"]+"><\/script>/g) || []).map(function (t) { return /src="([^"]+)"/.exec(t)[1]; })
	.filter(function (n) { return !/xlsx|pdf\.min|pdfview/.test(n); });
var html = raw.replace(/<script src[\s\S]*?<\/script>/g, "");
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x === undefined ? "" : (typeof x === "string" ? x : JSON.stringify(x))))); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var INV = {
	name: "IOG-2026-00012", naming_series: "IOG-.YYYY.-", docstatus: 1, company: "Integrated Optics UAB", posting_date: "2026-10-05", due_date: "2026-11-04", currency: "EUR", conversion_rate: 1,
	customer: "BAFA", customer_name: "Bundesamt", tax_id: "DE811234567", customer_address: "B-Bill", company_address: "IO-Bill", company_tax_id: "LT100007179012", contact_email: "einkauf@bafa.example",
	leitweg_id: "", owner: "e@io.example", remarks: "No Remarks",
	items: [{ item_code: "LD", item_name: "Laser diode", description: "", qty: 2, uom: "Nos", rate: 100, net_rate: 100, amount: 200, net_amount: 200 }],
	taxes: [{ charge_type: "On Net Total", account_head: "VAT 21%", description: "VAT 21%", rate: 21, tax_amount: 42 }], net_total: 200, grand_total: 242, rounded_total: 0, total_advance: 0
};
var DOCS = {
	"Sales Invoice": { "IOG-2026-00012": INV },
	"Company": { "Integrated Optics UAB": { name: "Integrated Optics UAB", company_name: "Integrated Optics UAB", tax_id: "LT100007179012", country: "Lithuania", default_bank_account: "SEB", phone_no: "+370 1", email: "i@io.example" } },
	"Address": { "IO-Bill": { address_line1: "Mokslininku g. 6A", city: "Vilnius", pincode: "08412", country: "Lithuania" }, "B-Bill": { address_line1: "Frankfurter Str. 29", city: "Eschborn", pincode: "65760", country: "Germany" } },
	"Bank Account": { "SEB": { iban: "LT601010012345678901", account_name: "Integrated Optics UAB", bank: "SEB" } },
	"Bank": { "SEB": { swift_number: "CBVILT2XXXX" } },
	"Customer": { "BAFA": { customer_name: "Bundesamt" } },
	"User": { "e@io.example": { full_name: "Evaldas", mobile_no: "+370 600", email: "e@io.example" } }
};
var asked = [], attached = [], savedFiles = [];
var io = {
	getList: function (dt, filters, fields) { asked.push({ dt: dt, filters: filters }); if (dt === "Country") return Promise.resolve([{ name: "Germany", code: "de" }, { name: "Lithuania", code: "lt" }]);
		if (dt === "Sales Invoice") return Promise.resolve([{ name: "IOG-2026-00012", posting_date: "2026-10-05", customer: "BAFA", customer_name: "Bundesamt", currency: "EUR", grand_total: 242, leitweg_id: "" }]);
		return Promise.resolve([]); },
	fetchDoc: function (dt, n) { return Promise.resolve((DOCS[dt] || {})[n] || null); },
	attachFile: function (dt, n, d, f) { attached.push({ dt: dt, n: n, f: f, d: d }); return Promise.resolve({ state: "created" }); }
};

(async function () {
	var store = { "settings.json": "{}" };
	var dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, beforeParse: function (w) {
		w.Android = { platform: function () { return "desktop"; }, appVersion: function () { return "1.8.0"; },
			readData: function (n) { return store[n] || ""; }, writeData: function (n, c) { store[n] = c; return true; }, toast: function () {}, readAsset: function () { return ""; },
			saveToDocuments: function (name, b64) { savedFiles.push({ name: name, xml: Buffer.from(b64, "base64").toString("utf8") }); return JSON.stringify({ ok: true, path: "Documents/CardScanner/" + name, uri: "x" }); } };
		w.setTimeout = function (f, ms) { return setTimeout(f, ms > 1000 ? 5 : ms); };
	} });
	var w = dom.window, d = w.document, $ = function (id) { return d.getElementById(id); };
	scripts.forEach(function (n) { try { w.eval(fs.readFileSync(A + n, "utf8")); } catch (e) { console.log("script " + n + ": " + e.message); } });
	await wait(150);
	check("the card exists on the Export screen with the series, dates and the list button", !!$("card-xr") && !!$("btn-xr-list") && $("xr-series").value === "IOG" && $("v-export").contains($("card-xr")));
	var S = {}; var changed = 0;
	w.CS_XR.init({ settings: function () { return S; }, save: function () { changed++; }, toast: function () {}, erp: function () { return io; }, erpReady: function () { return ""; },
		saveFile: function (n, b, m) { return w.Android.saveToDocuments(n, b, m); } });

	$("btn-xr-list").click(); await wait(60);
	var invFilter = JSON.stringify(asked.filter(function (a) { return a.dt === "Sales Invoice"; })[0].filters);
	check("listing asks for submitted invoices of the IOG series", invFilter.indexOf('"naming_series","like","IOG%"') > 0 && invFilter.indexOf('"docstatus","=",1') > 0, invFilter);
	check("the invoice is listed", /IOG-2026-00012/.test($("xr-list").textContent) && !!d.querySelector("[data-xr-tick]"));
	d.querySelector("[data-xr-tick]").click();
	$("btn-xr-prep").click(); await wait(80);
	check("the Leitweg-ID is missing -> not ready, with an input for it", /Leitweg-ID/.test($("xr-list").textContent) && /Not ready/.test($("xr-list").textContent) && !!d.querySelector('[data-xr-fix="leitweg"]'));
	$("btn-xr-make").click(); await wait(80);
	check("a not-ready invoice is not exported", savedFiles.length === 0 && /not exported/.test($("xr-result").textContent), $("xr-result").textContent);

	var inp = d.querySelector('[data-xr-fix="leitweg"]'); inp.value = "991-01234-44"; inp.dispatchEvent(new w.Event("change")); await wait(30);
	check("typing the Leitweg-ID makes the invoice ready", /Ready to export/.test($("xr-list").textContent), $("xr-list").textContent.slice(-300));
	$("btn-xr-make").click(); await wait(100);
	check("the XML is saved through the file bridge", savedFiles.length === 1 && savedFiles[0].name === "IOG-2026-00012_xrechnung.xml" && /<cbc:BuyerReference>991-01234-44</.test(savedFiles[0].xml), savedFiles.map(function (f) { return f.name; }));
	check("and attached to the Sales Invoice in ERPNext", attached.length === 1 && attached[0].dt === "Sales Invoice" && /^data:application\/xml;base64,/.test(attached[0].d), attached);
	check("the export is remembered", S.xr_done && S.xr_done["IOG-2026-00012"] && changed > 0);
	check("result line names the file", /IOG-2026-00012_xrechnung\.xml/.test($("xr-result").textContent));

	/* an invoice outside the series cannot be opened by number */
	DOCS["Sales Invoice"]["SINV-1"] = Object.assign({}, INV, { name: "SINV-1", naming_series: "SINV-.YYYY.-" });
	$("xr-no").value = "SINV-1"; var toasts = [];
	w.CS_XR.init({ settings: function () { return S; }, save: function () {}, toast: function (m) { toasts.push(m); }, erp: function () { return io; }, erpReady: function () { return ""; }, saveFile: function () { return "{}"; } });
	$("xr-no").value = "SINV-1"; $("btn-xr-open").click(); await wait(60);
	check("an invoice of another series is refused", toasts.some(function (t) { return /not in the/.test(t); }), toasts);

	/* ERPNext not set up -> a message, no crash */
	w.CS_XR.init({ settings: function () { return S; }, save: function () {}, toast: function (m) { toasts.push(m); }, erp: function () { return null; }, erpReady: function () { return "Set the ERPNext address in Settings first."; }, saveFile: function () { return "{}"; } });
	$("btn-xr-list").click(); await wait(20);
	check("without ERPNext the card says so", toasts.some(function (t) { return /Set the ERPNext address/.test(t); }));
	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
