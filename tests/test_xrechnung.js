/* test_xrechnung.js — Sales Invoice -> XRechnung 3.0 (UBL) in xrechnung.js, against a fake ERPNext.
   Each generated file is also validated with an offline XRechnung validator when one is installed:
       npm install --prefix /tmp/val @sweberdev/summand && SUMMAND_PATH=/tmp/val/node_modules/@sweberdev/summand node tests/test_xrechnung.js
   (without it, only the app's own checks run). */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var src = fs.readFileSync(path.join(__dirname, "../android/CardScanner/app/src/main/assets/xrechnung.js"), "utf8");
var sandbox = { window: {}, console: console, document: {}, TextEncoder: TextEncoder, btoa: function (s) { return Buffer.from(s, "binary").toString("base64"); } };
vm.createContext(sandbox); vm.runInContext(src, sandbox);
var XR = sandbox.window.CS_XR;
var summand = null;
try { summand = require(process.env.SUMMAND_PATH || "@sweberdev/summand"); } catch (e) { console.log("note: no offline validator (set SUMMAND_PATH) — only the app's own checks are run"); }

var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }

var COMPANY = { name: "Integrated Optics UAB", company_name: "Integrated Optics UAB", tax_id: "LT100007179012", country: "Lithuania", default_bank_account: "IO EUR - SEB", phone_no: "+370 5 2000000", email: "info@integratedoptics.com", reg_number: "302833442" };
var SELLER_ADDR = { name: "IO-Billing", address_line1: "Mokslininkų g. 6A", city: "Vilnius", pincode: "08412", country: "Lithuania" };
var BUYER_ADDR = { name: "BAFA-Billing", address_line1: "Frankfurter Straße 29-35", city: "Eschborn", pincode: "65760", country: "Germany", email_id: "rechnung@bafa.example" };
var BANK = { name: "IO EUR - SEB", iban: "LT601010012345678901", account_name: "Integrated Optics UAB", bank: "SEB" };
function fixture(over) {
	var inv = {
		name: "IOG-2026-00012", naming_series: "IOG-.YYYY.-", docstatus: 1, company: "Integrated Optics UAB", posting_date: "2026-10-05", due_date: "2026-11-04",
		currency: "EUR", conversion_rate: 1, customer: "BAFA", customer_name: "Bundesamt für Wirtschaft und Ausfuhrkontrolle", tax_id: "DE811234567",
		customer_address: "BAFA-Billing", company_address: "IO-Billing", company_tax_id: "LT100007179012", contact_email: "einkauf@bafa.example", contact_display: "Frau Schmidt",
		leitweg_id: "991-01234-44", po_no: "4500012345", remarks: "No Remarks", owner: "evaldas@integratedoptics.com",
		items: [
			{ item_code: "LD-1550", item_name: "Laser diode 1550 nm", description: "<div>Fibre-coupled laser diode,<br>1550 nm</div>", qty: 3, uom: "Nos", rate: 125.5, net_rate: 125.5, amount: 376.5, net_amount: 376.5 },
			{ item_code: "SRV-CAL", item_name: "Calibration service", description: "", qty: 1.5, uom: "Hour", rate: 80, net_rate: 80, amount: 120, net_amount: 120 }
		],
		taxes: [{ charge_type: "On Net Total", account_head: "VAT 21% - IO", description: "VAT 21%", rate: 21, tax_amount: 104.37 }],
		net_total: 496.5, total_taxes_and_charges: 104.27, grand_total: 600.77, rounded_total: 0, total_advance: 0, is_return: 0
	};
	Object.keys(over || {}).forEach(function (k) { inv[k] = over[k]; });
	return inv;
}
function raw(invOver, rawOver) {
	var r = { inv: fixture(invOver), company: COMPANY, sellerAddr: SELLER_ADDR, buyerAddr: BUYER_ADDR, customer: { customer_name: "BAFA" },
		user: { full_name: "Evaldas Test", mobile_no: "+370 600 00000", email: "evaldas@integratedoptics.com" }, bank: BANK, bic: "CBVILT2XXXX", codes: { germany: "DE", lithuania: "LT" } };
	Object.keys(rawOver || {}).forEach(function (k) { r[k] = rawOver[k]; });
	return r;
}
function validate(label, xml) {
	if (!summand) return;
	var res = summand.validateInvoice(xml);
	var errs = (res.errors || []).map(function (e) { return e.id + ": " + e.message; });
	check(label + " — offline XRechnung validator: valid (" + (res.profile && res.profile.label) + ")", res.valid, errs.join(" | "));
}

/* 1. a grand total in ERPNext that the lines and VAT rows do not add up to must be refused */
var bad = XR.check(raw({ grand_total: 610 }), {}, {});
check("calculated total that disagrees with ERPNext's by more than 5 ct is refused", bad.errors.some(function (e) { return /differs from ERPNext/.test(e.msg); }), JSON.stringify(bad.errors));

/* 2. a consistent invoice */
var good = fixture();
good.taxes[0].tax_amount = 104.27; // 496.50 x 21 % = 104.265 -> 104.27 (the app rounds half up)
var r1 = XR.check(raw({ taxes: good.taxes }), {}, {});
check("a complete 21 % invoice has no blocking problem", r1.errors.length === 0, JSON.stringify(r1.errors));
check("totals: net 496.50, VAT 104.27 (rounded half up), payable 600.77", r1.model.totals.taxExclusive === 496.5 && r1.model.totals.tax === 104.27 && r1.model.totals.payable === 600.77, JSON.stringify(r1.model.totals));
check("the XRechnung 3.0 CustomizationID and the Leitweg-ID (BuyerReference) are written", /xrechnung_3\.0<\/cbc:CustomizationID>/.test(r1.xml) && /<cbc:BuyerReference>991-01234-44</.test(r1.xml));
check("hours map to HUR, Nos to C62", /unitCode="HUR">1\.5</.test(r1.xml) && /unitCode="C62">3</.test(r1.xml));
check("HTML in the description is stripped", /<cbc:Description>Fibre-coupled laser diode,\n1550 nm<\/cbc:Description>/.test(r1.xml), r1.xml.match(/<cbc:Description>[\s\S]*?<\/cbc:Description>/));
check("SEPA payment means 58 with IBAN and BIC", /<cbc:PaymentMeansCode>58</.test(r1.xml) && /<cbc:ID>LT601010012345678901</.test(r1.xml) && /CBVILT2XXXX/.test(r1.xml));
validate("21 % invoice", r1.xml);

/* 3. missing Leitweg-ID and buyer e-mail -> blocking, then fixed by typed answers */
var r2 = XR.check(raw({ taxes: good.taxes, leitweg_id: "", contact_email: "" }, { buyerAddr: Object.assign({}, BUYER_ADDR, { email_id: "" }) }), {}, {});
check("no Leitweg-ID and no authority e-mail are blocking", r2.errors.some(function (e) { return e.field === "leitweg"; }) && r2.errors.some(function (e) { return e.field === "buyerEmail"; }), JSON.stringify(r2.errors));
var r2b = XR.check(raw({ taxes: good.taxes, leitweg_id: "", contact_email: "" }, { buyerAddr: Object.assign({}, BUYER_ADDR, { email_id: "" }) }), { leitweg: "991-01234-44", buyerEmail: "x@bafa.example" }, {});
check("typed answers fix them", r2b.errors.length === 0, JSON.stringify(r2b.errors));

/* 4. seller contact: typed once overrides ERPNext; missing everywhere is blocking */
var r3 = XR.check(raw({ taxes: good.taxes }, { user: null, company: Object.assign({}, COMPANY, { phone_no: "", email: "" }) }), {}, {});
check("no seller contact anywhere -> three blocking problems", ["contactName", "contactPhone", "contactEmail"].every(function (f) { return r3.errors.some(function (e) { return e.field === f; }); }), JSON.stringify(r3.errors));
var r3b = XR.check(raw({ taxes: good.taxes }, { user: null, company: Object.assign({}, COMPANY, { phone_no: "", email: "" }) }), {}, { contactName: "Max Muster", contactPhone: "+370 1", contactEmail: "max@io.example" });
check("contact typed in the app is used", r3b.errors.length === 0 && /<cbc:Name>Max Muster</.test(r3b.xml));

/* 5. 0 % VAT to a German customer with VAT ID -> intra-community supply K, delivery date and country present */
var zero = { taxes: [{ charge_type: "On Net Total", account_head: "VAT 0% - IO", description: "VAT 0%", rate: 0, tax_amount: 0 }], total_taxes_and_charges: 0, grand_total: 496.5 };
var r4 = XR.check(raw(zero), {}, {});
check("0 % to a German customer with VAT ID defaults to K", r4.errors.length === 0 && r4.model.zeroCat === "K" && /<cbc:ID>K<\/cbc:ID>/.test(r4.xml) && /VATEX-EU-IC/.test(r4.xml) && /<cbc:ActualDeliveryDate>2026-10-05/.test(r4.xml), JSON.stringify(r4.errors));
check("the guessed category is flagged for confirmation", r4.warnings.some(function (w) { return w.field === "vatCat"; }));
validate("K invoice", r4.xml);
var r4b = XR.check(raw(Object.assign({ tax_id: "" }, zero)), {}, {});
check("0 % without a customer VAT ID is not guessed as K", r4b.model.zeroCat === "E", r4b.model.zeroCat);
var r4c = XR.check(raw(zero), { vatCat: "AE" }, {});
check("a typed category (AE) is used", r4c.model.zeroCat === "AE" && /VATEX-EU-AE/.test(r4c.xml));
validate("AE invoice", r4c.xml);
var r4d = XR.check(raw(Object.assign({ tax_id: "" }, zero)), { vatCat: "K" }, {});
check("category K without customer VAT ID is blocking", r4d.errors.some(function (e) { return e.field === "buyerVat"; }));

/* 6. credit note, prepayment, rounding, discount distributed into the lines, foreign currency */
var cn = raw({ taxes: good.taxes, is_return: 1, return_against: "IOG-2026-00010",
	items: [{ item_code: "LD-1550", item_name: "Laser diode 1550 nm", qty: -1, uom: "Nos", rate: 125.5, net_rate: 125.5, amount: -125.5, net_amount: -125.5 }],
	net_total: -125.5, grand_total: -151.86, total_taxes_and_charges: -26.36 });
var r5 = XR.check(cn, {}, {});
check("credit note: type 381, positive amounts, reference to the original invoice", r5.errors.length === 0 && r5.model.typeCode === "381" && r5.model.totals.payable === 151.86 && /<cbc:ID>IOG-2026-00010</.test(r5.xml), JSON.stringify(r5.errors));
validate("credit note", r5.xml);
var disc = raw({ taxes: good.taxes, items: [{ item_code: "A", item_name: "Part A", qty: 7, uom: "Nos", rate: 10, net_rate: 9.0286, amount: 70, net_amount: 63.2 }], net_total: 63.2, grand_total: 76.47, rounded_total: 76, total_taxes_and_charges: 13.27, total_advance: 20 });
var r6 = XR.check(disc, {}, {});
check("discounted line uses ERPNext's net amount; rounding and prepayment are separate", r6.errors.length === 0 && r6.model.totals.lines === 63.2 && r6.model.totals.prepaid === 20 && Math.abs(r6.model.totals.rounding + 0.47) < 0.001 && r6.model.totals.payable === 56, JSON.stringify(r6.model.totals) + JSON.stringify(r6.errors));
validate("rounding + prepayment", r6.xml);
var usd = raw({ taxes: good.taxes, currency: "USD", conversion_rate: 0.9 });
var r7 = XR.check(usd, {}, {});
check("foreign currency: VAT also stated in EUR (BT-6 / second TaxTotal)", r7.errors.length === 0 && /<cbc:TaxCurrencyCode>EUR</.test(r7.xml) && /<cbc:TaxAmount currencyID="EUR">93\.84</.test(r7.xml), r7.xml && r7.xml.match(/TaxCurrencyCode/));
validate("USD invoice", r7.xml);

/* 7. unsupported extra charge, bad IBAN, missing bank, draft */
var ch = XR.check(raw({ taxes: good.taxes.concat([{ charge_type: "Actual", account_head: "Freight", description: "Freight", tax_amount: 15 }]) }), {}, {});
check("an 'Actual' charge row is refused with its name", ch.errors.some(function (e) { return /Freight/.test(e.msg); }));
check("bad IBAN is blocking", XR.check(raw({ taxes: good.taxes }, { bank: Object.assign({}, BANK, { iban: "LT601010012345678902" }) }), {}, {}).errors.some(function (e) { return e.field === "bank"; }));
check("no bank account is blocking", XR.check(raw({ taxes: good.taxes }, { bank: null }), {}, {}).errors.some(function (e) { return e.field === "bank"; }));
check("a draft is blocking", XR.check(raw({ taxes: good.taxes, docstatus: 0 }), {}, {}).errors.length > 0);
check("IBAN checker accepts a valid IBAN", XR._internals.ibanOk("DE89 3704 0044 0532 0130 00") && !XR._internals.ibanOk("DE89 3704 0044 0532 0130 01"));

/* 8. escaping */
var esc = XR.check(raw({ taxes: good.taxes, customer_name: 'Amt für "Q&A" <Test>' }), {}, {});
check("special characters are escaped", /Amt für &quot;Q&amp;A&quot; &lt;Test&gt;/.test(esc.xml));
check("file name is safe", XR.fileName("IOG/2026/1") === "IOG_2026_1_xrechnung.xml");

/* 9. the invoice list asks for the series and tolerates a server without leitweg_id */
var asked = [];
var io = { getList: function (dt, filters, fields) { asked.push({ dt: dt, filters: filters, fields: fields }); if (fields.indexOf("leitweg_id") >= 0) return Promise.reject(new Error("no field")); return Promise.resolve([{ name: "IOG-1", customer_name: "A" }, { name: "IOG-2", customer_name: "B" }]); } };
XR.list(io, { series: "IOG", from: "2026-01-01", to: "2026-12-31", text: "b" }).then(function (rows) {
	check("list: series filter, submitted only, retried without leitweg_id, text filter", asked.length === 2 && JSON.stringify(asked[0].filters).indexOf('"naming_series","like","IOG%"') > 0 && JSON.stringify(asked[0].filters).indexOf('"docstatus","=",1') > 0 && rows.length === 1 && rows[0].name === "IOG-2", JSON.stringify(asked));
	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
});
