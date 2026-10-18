/* xrechnung.js — Export menu: ERPNext Sales Invoices -> XRechnung 3.0 (UBL 2.1 "Invoice", EN 16931 CIUS) for German authorities.

   Three layers, so the rules can be tested without a screen or a server:
     collect(io, name)        reads one Sales Invoice and what belongs to it (company, addresses, bank, user…) -> raw
     normalise(raw, ov, conf) turns raw into a flat model and the list of problems (errors block the export, warnings do not)
     toXml(model)             writes the UBL XML
   plus list(io, opt) for the invoice list and a small panel (init) on the Export screen.

   Only Sales Invoices of one naming series (default "IOG") are offered. Money is calculated from the invoice's own net
   amounts; the result must agree with ERPNext's grand total or the invoice is refused instead of exported wrongly.
   The file is saved with the app's normal file bridge (Documents/CardScanner) and, if ticked, also attached to the
   Sales Invoice in ERPNext. Nothing is sent to any authority: uploading the XML to the authority's portal stays a manual step. */
window.CS_XR = (function () {
"use strict";

var CUSTOMIZATION = "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";
var PROFILE = "urn:fdc:peppol.eu:2017:poid:billing:01:1.0";
var EU = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];
var SEPA_EXTRA = ["GB", "CH", "NO", "IS", "LI", "MC", "SM", "AD", "VA"];

/* ERPNext country names -> ISO 3166-1 alpha-2, used only when the Country record has no code */
var COUNTRY = { "austria": "AT", "belgium": "BE", "bulgaria": "BG", "croatia": "HR", "cyprus": "CY", "czech republic": "CZ", "czechia": "CZ",
	"denmark": "DK", "estonia": "EE", "finland": "FI", "france": "FR", "germany": "DE", "greece": "GR", "hungary": "HU", "ireland": "IE",
	"italy": "IT", "latvia": "LV", "lithuania": "LT", "luxembourg": "LU", "malta": "MT", "netherlands": "NL", "poland": "PL", "portugal": "PT",
	"romania": "RO", "slovakia": "SK", "slovenia": "SI", "spain": "ES", "sweden": "SE", "united kingdom": "GB", "switzerland": "CH",
	"norway": "NO", "iceland": "IS", "liechtenstein": "LI", "united states": "US", "united sates": "US", "canada": "CA", "china": "CN",
	"japan": "JP", "india": "IN", "turkey": "TR", "ukraine": "UA", "serbia": "RS", "israel": "IL", "australia": "AU", "singapore": "SG",
	"republic of korea": "KR", "south korea": "KR", "taiwan": "TW", "brazil": "BR", "mexico": "MX", "united arab emirates": "AE" };

/* ERPNext unit of measure -> UN/ECE Recommendation 20 code */
var UOM = { "nos": "C62", "no": "C62", "unit": "C62", "units": "C62", "each": "C62", "piece": "C62", "pieces": "C62", "pcs": "C62", "pc": "C62",
	"kg": "KGM", "gram": "GRM", "g": "GRM", "tonne": "TNE", "meter": "MTR", "metre": "MTR", "m": "MTR", "cm": "CMT", "mm": "MMT", "km": "KMT",
	"litre": "LTR", "liter": "LTR", "l": "LTR", "ml": "MLT", "hour": "HUR", "hr": "HUR", "h": "HUR", "minute": "MIN", "day": "DAY", "month": "MON",
	"year": "ANN", "box": "XBX", "set": "SET", "pair": "PR", "pack": "XPK", "roll": "XRO", "pallet": "PF", "sqm": "MTK", "square meter": "MTK",
	"service": "C62", "lot": "LS" };

var VAT_CATEGORIES = {
	S: { label: "S — standard rate" },
	Z: { label: "Z — zero rated", reason: "" },
	E: { label: "E — exempt from VAT", reason: "Steuerbefreit", code: "" },
	K: { label: "K — intra-community supply (0 %)", reason: "Steuerfreie innergemeinschaftliche Lieferung (Art. 138 MwStSystRL)", code: "VATEX-EU-IC" },
	AE: { label: "AE — reverse charge (0 %)", reason: "Reverse Charge: Steuerschuldnerschaft des Leistungsempfängers (Art. 196 MwStSystRL)", code: "VATEX-EU-AE" },
	G: { label: "G — export outside the EU (0 %)", reason: "Steuerfreie Ausfuhrlieferung (Art. 146 MwStSystRL)", code: "VATEX-EU-G" },
	O: { label: "O — outside the scope of VAT", reason: "Nicht steuerbar", code: "VATEX-EU-O" }
};

/* ------------------------------------------------------------------------------------------- small helpers */

function has(v) { return v !== undefined && v !== null && String(v).trim() !== ""; }
function str(v) { return has(v) ? String(v).trim() : ""; }
function toNum(v) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : 0; }
function round(x, d) { var f = Math.pow(10, d); var s = x < 0 ? -1 : 1; return s * Math.round(Math.abs(x) * f + 1e-9) / f; }
function money(x) { return round(x, 2).toFixed(2); }
function trimNum(x, minDec, maxDec) {
	var s = round(x, maxDec).toFixed(maxDec);
	var dot = s.indexOf(".");
	if (dot < 0) return s;
	var end = s.length;
	while (end > dot + 1 + minDec && s.charAt(end - 1) === "0") end--;
	s = s.slice(0, end);
	return s.charAt(s.length - 1) === "." ? s.slice(0, -1) : s;
}
function xmlEsc(s) {
	return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function plain(html) {
	return String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
function isoDate(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? m[1] + "-" + m[2] + "-" + m[3] : ""; }
function deDate(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? m[3] + "." + m[2] + "." + m[1] : String(s || ""); }

function ibanOk(iban) {
	var s = String(iban || "").replace(/\s+/g, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
	var r = s.slice(4) + s.slice(0, 4), rem = 0;
	for (var i = 0; i < r.length; i++) {
		var c = r.charAt(i), v = /\d/.test(c) ? c : String(c.charCodeAt(0) - 55);
		for (var j = 0; j < v.length; j++) rem = (rem * 10 + Number(v.charAt(j))) % 97;
	}
	return rem === 1;
}

function countryCode(name, codes) {
	var n = str(name);
	if (!n) return "";
	if (/^[A-Za-z]{2}$/.test(n)) return n.toUpperCase();
	var k = n.toLowerCase();
	if (codes && codes[k]) return String(codes[k]).toUpperCase();
	return COUNTRY[k] || "";
}

function uomCode(u) {
	var k = str(u).toLowerCase();
	return UOM[k] || "";
}

/* ------------------------------------------------------------------------------------------- reading ERPNext */

function safe(p) { return p.then(function (v) { return v; }, function () { return null; }); }

/* The Sales Invoices that can be exported: submitted, in the configured series, in a date range.
   opt: { series, from, to }. Resolves rows; `leitweg_id` is read when the server has the field. */
function list(io, opt) {
	opt = opt || {};
	var series = str(opt.series) || "IOG";
	var filters = [["docstatus", "=", 1], ["naming_series", "like", series + "%"]];
	if (isoDate(opt.from)) filters.push(["posting_date", ">=", isoDate(opt.from)]);
	if (isoDate(opt.to)) filters.push(["posting_date", "<=", isoDate(opt.to)]);
	var base = ["name", "posting_date", "customer", "customer_name", "currency", "grand_total", "rounded_total", "is_return", "naming_series"];
	return io.getList("Sales Invoice", filters, base.concat(["leitweg_id"]), 200, "posting_date desc, name desc").catch(function () {
		return io.getList("Sales Invoice", filters, base, 200, "posting_date desc, name desc");
	}).then(function (rows) {
		var q = str(opt.text).toLowerCase();
		return rows.filter(function (r) {
			return !q || (String(r.name) + " " + String(r.customer_name || r.customer || "")).toLowerCase().indexOf(q) >= 0;
		});
	});
}

/* One invoice and everything that belongs to it. Every extra read is best effort: what is missing is reported later,
   as a problem with the field to fill in, never as a crash. Resolves { inv, company, sellerAddr, buyerAddr, shipAddr,
   bank, bic, user, customer, codes } or null when the invoice does not exist. */
function collect(io, name) {
	return io.fetchDoc("Sales Invoice", name).then(function (inv) {
		if (!inv) return null;
		var raw = { inv: inv };
		var companyP = safe(io.fetchDoc("Company", inv.company));
		return Promise.all([
			companyP,
			inv.company_address ? safe(io.fetchDoc("Address", inv.company_address)) : Promise.resolve(null),
			inv.customer_address ? safe(io.fetchDoc("Address", inv.customer_address)) : Promise.resolve(null),
			inv.shipping_address_name ? safe(io.fetchDoc("Address", inv.shipping_address_name)) : Promise.resolve(null),
			safe(io.fetchDoc("Customer", inv.customer)),
			inv.owner ? safe(io.fetchDoc("User", inv.owner)) : Promise.resolve(null),
			safe(io.getList("Country", null, ["name", "code"], 0))
		]).then(function (r) {
			raw.company = r[0]; raw.sellerAddr = r[1]; raw.buyerAddr = r[2]; raw.shipAddr = r[3]; raw.customer = r[4]; raw.user = r[5];
			raw.codes = {};
			(r[6] || []).forEach(function (c) { if (c && c.name && c.code) raw.codes[String(c.name).toLowerCase()] = String(c.code).toUpperCase(); });
			var needSellerAddr = !raw.sellerAddr && inv.company ? safe(io.getList("Address",
				[["Dynamic Link", "link_doctype", "=", "Company"], ["Dynamic Link", "link_name", "=", inv.company]],
				["name", "address_line1", "address_line2", "city", "pincode", "country", "email_id", "phone", "is_primary_address"], 5)) : Promise.resolve(null);
			return needSellerAddr.then(function (rows) {
				if (rows && rows.length) {
					raw.sellerAddr = rows.filter(function (a) { return a.is_primary_address; })[0] || rows[0];
				}
				var bankName = raw.company && raw.company.default_bank_account;
				return bankName ? safe(io.fetchDoc("Bank Account", bankName)) : Promise.resolve(null);
			});
		}).then(function (bank) {
			raw.bank = bank;
			return bank && bank.bank ? safe(io.fetchDoc("Bank", bank.bank)) : Promise.resolve(null);
		}).then(function (bk) {
			raw.bic = bk && (bk.swift_number || bk.bic) || "";
			return raw;
		});
	});
}

/* ------------------------------------------------------------------------------------------- the model */

/* raw -> { model, issues }.
   ov   per-invoice answers typed on the screen: { leitweg, buyerEmail, vatCat, deliveryDate }
   conf the seller contact typed once: { contactName, contactPhone, contactEmail } (overrides what ERPNext knows) */
function normalise(raw, ov, conf) {
	ov = ov || {}; conf = conf || {};
	var inv = raw.inv, issues = [], m = { lines: [], vat: [] };
	function err(field, msg) { issues.push({ level: "error", field: field, msg: msg }); }
	function warn(field, msg) { issues.push({ level: "warn", field: field, msg: msg }); }
	var sign = inv.is_return ? -1 : 1;

	if (Number(inv.docstatus) !== 1) err("", "The invoice is not submitted (" + (Number(inv.docstatus) === 2 ? "cancelled" : "draft") + ").");

	m.id = str(inv.name);
	m.typeCode = inv.is_return ? "381" : "380";
	m.issueDate = isoDate(inv.posting_date);
	m.dueDate = isoDate(inv.due_date) || (inv.payment_schedule && inv.payment_schedule[0] && isoDate(inv.payment_schedule[0].due_date));
	m.currency = str(inv.currency).toUpperCase() || "EUR";
	m.note = /^no remarks$/i.test(str(inv.remarks)) ? "" : plain(inv.remarks).slice(0, 500);
	m.orderRef = str(inv.po_no);
	m.precedingInvoice = inv.is_return ? str(inv.return_against) : "";
	if (!m.issueDate) err("", "The invoice has no posting date.");

	/* Leitweg-ID: the authority's routing address, BT-10, mandatory (BR-DE-15) */
	m.buyerReference = str(ov.leitweg) || str(inv.leitweg_id);
	if (!m.buyerReference) err("leitweg", "The Leitweg-ID (the authority's routing ID) is missing.");
	else if (!/^\d{2,12}(-[A-Za-z0-9]{1,30})?-\d{2}$/.test(m.buyerReference)) warn("leitweg", "“" + m.buyerReference + "” does not look like a Leitweg-ID (for example 991-01234-44).");

	/* seller */
	var co = raw.company || {}, sa = raw.sellerAddr || {};
	var s = m.seller = {
		name: str(co.company_name) || str(co.name) || str(inv.company),
		street: str(sa.address_line1), street2: str(sa.address_line2), city: str(sa.city), zip: str(sa.pincode),
		country: countryCode(sa.country || co.country, raw.codes),
		vatId: str(inv.company_tax_id) || str(co.tax_id), regNo: str(co.reg_number) || str(co.company_registry)
	};
	var u = raw.user || {};
	s.contactName = str(conf.contactName) || str(u.full_name) || [str(u.first_name), str(u.last_name)].filter(Boolean).join(" ");
	s.contactPhone = str(conf.contactPhone) || str(u.phone) || str(u.mobile_no) || str(co.phone_no) || str(sa.phone);
	s.contactEmail = str(conf.contactEmail) || str(u.email) || str(co.email) || str(sa.email_id);
	if (!s.name) err("", "The seller (company) name could not be read.");
	if (!s.street || !s.city || !s.zip || !s.country) err("sellerAddress", "The company's address (street, post code, city, country) is incomplete in ERPNext.");
	if (!s.vatId) err("sellerVat", "The company's VAT ID is missing in ERPNext.");
	if (!s.contactName) err("contactName", "The seller contact person's name is needed (XRechnung rule BR-DE-5).");
	if (!s.contactPhone) err("contactPhone", "The seller contact's telephone number is needed (BR-DE-6).");
	if (!s.contactEmail) err("contactEmail", "The seller contact's e-mail address is needed (BR-DE-7).");

	/* buyer */
	var ba = raw.buyerAddr || {}, cu = raw.customer || {};
	var b = m.buyer = {
		name: str(inv.customer_name) || str(cu.customer_name) || str(inv.customer),
		street: str(ba.address_line1), street2: str(ba.address_line2), city: str(ba.city), zip: str(ba.pincode),
		country: countryCode(ba.country, raw.codes), vatId: str(inv.tax_id) || str(cu.tax_id),
		email: str(ov.buyerEmail) || str(inv.contact_email) || str(ba.email_id) || str(cu.email_id),
		contactName: str(inv.contact_display) || str(inv.contact_person), contactPhone: str(inv.contact_mobile), contactEmail: str(inv.contact_email)
	};
	if (!b.name) err("", "The customer name is missing.");
	if (!b.street || !b.city || !b.zip || !b.country) err("buyerAddress", "The customer's billing address (street, post code, city, country) is incomplete in ERPNext.");
	if (!b.email) err("buyerEmail", "The authority's e-mail address (electronic address, BT-49) is needed.");
	var shipCountry = countryCode((raw.shipAddr || {}).country, raw.codes) || b.country;

	/* VAT rows: "On Net Total" rows are VAT; any other row with an amount is a charge this export does not carry */
	var vatRows = [];
	(inv.taxes || []).forEach(function (t) {
		var amt = Math.abs(toNum(t.tax_amount));
		if (t.charge_type === "On Net Total") { vatRows.push(t); return; }
		if (amt > 0.004) err("", "Tax/charge row “" + (t.description || t.account_head) + "” (" + t.charge_type + ") cannot be exported to XRechnung — put such costs on an item line.");
	});

	/* lines: net amounts as ERPNext holds them (after discounts, without tax) */
	var needCat = false;
	(inv.items || []).forEach(function (it, i) {
		var qty = Math.abs(toNum(it.qty)), net = round(Math.abs(toNum(it.net_amount !== undefined && it.net_amount !== null ? it.net_amount : it.amount)), 2);
		var rate = 0;
		var itr = null;
		if (has(it.item_tax_rate)) { try { itr = typeof it.item_tax_rate === "string" ? JSON.parse(it.item_tax_rate) : it.item_tax_rate; } catch (e) { itr = null; } }
		vatRows.forEach(function (t) {
			var r = itr && itr[t.account_head] !== undefined ? toNum(itr[t.account_head]) : toNum(t.rate);
			rate += r;
		});
		var price = round(Math.abs(toNum(it.net_rate !== undefined && it.net_rate !== null ? it.net_rate : it.rate)), 6);
		if (qty > 0 && Math.abs(qty * price - net) > 0.01) price = round(net / qty, 6);
		var unit = uomCode(it.uom);
		if (!unit) { unit = "C62"; warn("", "Unit “" + (it.uom || "?") + "” has no UN/ECE code in the app's table; “C62” (piece) was used on line " + (i + 1) + "."); }
		if (!(qty > 0)) err("", "Line " + (i + 1) + " has no quantity.");
		var line = { id: String(i + 1), code: str(it.item_code), name: str(it.item_name) || str(it.item_code) || "Item", desc: plain(it.description), qty: qty, unit: unit, price: price, net: net, rate: round(rate, 2) };
		if (line.rate === 0) needCat = true;
		m.lines.push(line);
	});
	if (!m.lines.length) err("", "The invoice has no item lines.");

	/* VAT categories */
	var sellerEU = EU.indexOf(s.country) >= 0, buyerEU = EU.indexOf(b.country) >= 0;
	var zeroCat = str(ov.vatCat).toUpperCase();
	if (!VAT_CATEGORIES[zeroCat] || zeroCat === "S") zeroCat = "";
	if (!zeroCat && needCat) {
		zeroCat = b.country && s.country && b.country === s.country ? "E" : (buyerEU && sellerEU && b.vatId ? "K" : (b.country && !buyerEU ? "G" : "E"));
		m.vatCatGuessed = true;
	}
	m.zeroCat = zeroCat;
	m.needsCat = needCat;
	m.lines.forEach(function (l) {
		l.cat = l.rate > 0 ? "S" : zeroCat;
	});
	var groups = {};
	m.lines.forEach(function (l) {
		var k = l.cat + "|" + l.rate;
		if (!groups[k]) groups[k] = { cat: l.cat, rate: l.rate, taxable: 0, tax: 0 };
		groups[k].taxable += l.net;
	});
	Object.keys(groups).sort().forEach(function (k) {
		var g = groups[k];
		g.taxable = round(g.taxable, 2);
		g.tax = round(g.taxable * g.rate / 100, 2);
		m.vat.push(g);
	});
	m.hasK = m.vat.some(function (g) { return g.cat === "K"; });
	m.hasG = m.vat.some(function (g) { return g.cat === "G"; });
	if (m.hasK) {
		if (!b.vatId) err("buyerVat", "Intra-community supply (category K) needs the customer's VAT ID.");
		m.deliveryDate = isoDate(ov.deliveryDate) || m.issueDate;
	} else if (m.hasG) {
		m.deliveryDate = isoDate(ov.deliveryDate) || m.issueDate;
	}
	var sh = raw.shipAddr || {};
	m.deliveryAddr = { street: str(sh.address_line1) || b.street, city: str(sh.city) || b.city, zip: str(sh.pincode) || b.zip, country: shipCountry };
	if (needCat && ov.vatCat === undefined && m.vatCatGuessed) warn("vatCat", "VAT is 0 % on some lines: category " + zeroCat + " was chosen from the countries — please confirm it.");
	if (m.vat.some(function (g) { return g.cat === "S" && g.rate > 0; }) && !s.vatId) { /* already reported */ }

	/* totals */
	var lineSum = round(m.lines.reduce(function (a, l) { return a + l.net; }, 0), 2);
	var taxSum = round(m.vat.reduce(function (a, g) { return a + g.tax; }, 0), 2);
	var incl = round(lineSum + taxSum, 2);
	var erpGrand = round(Math.abs(toNum(inv.grand_total)), 2);
	var erpPayable = round(Math.abs(toNum(inv.rounded_total)) || erpGrand, 2);
	var prepaid = round(Math.abs(toNum(inv.total_advance)), 2);
	if (Math.abs(erpGrand - incl) > 0.05) {
		err("", "The calculated total (" + money(incl) + " " + m.currency + ") differs from ERPNext's grand total (" + money(erpGrand) + "). Check the item tax rates and charges.");
	}
	var payable = round(erpPayable - prepaid, 2);
	var rounding = round(payable - (incl - prepaid), 2);
	m.totals = { lines: lineSum, taxExclusive: lineSum, tax: taxSum, taxInclusive: incl, prepaid: prepaid, rounding: rounding, payable: payable };
	if (Math.abs(rounding) > 0.004) warn("", "A rounding amount of " + money(rounding) + " " + m.currency + " is shown separately (ERPNext's rounded total).");
	if (m.currency !== "EUR" && taxSum > 0) {
		var cr = toNum(inv.conversion_rate);
		if (cr > 0) m.taxEur = round(taxSum * cr, 2);
		else err("", "The invoice is in " + m.currency + " but has no exchange rate to EUR for the VAT amount.");
	}

	/* payment */
	var bk = raw.bank || {};
	var iban = str(bk.iban).replace(/\s+/g, "").toUpperCase();
	var sepa = m.currency === "EUR" && (EU.indexOf(iban.slice(0, 2)) >= 0 || SEPA_EXTRA.indexOf(iban.slice(0, 2)) >= 0);
	m.payment = {
		meansCode: sepa ? "58" : "30", iban: iban, accountName: str(bk.account_name) || s.name, bic: str(raw.bic) || str(bk.branch_code),
		reference: m.id,
		terms: str(inv.payment_schedule && inv.payment_schedule[0] && inv.payment_schedule[0].description) ||
			(m.dueDate ? "Zahlbar bis " + deDate(m.dueDate) + " ohne Abzug." : "")
	};
	if (!iban) err("bank", "No bank account: set the company's default Bank Account (with IBAN) in ERPNext.");
	else if (!ibanOk(iban)) err("bank", "The company's IBAN “" + iban + "” is not valid.");
	if (!m.dueDate && !m.payment.terms) err("", "The invoice has neither a due date nor payment terms.");
	if (m.payment.bic && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(m.payment.bic.toUpperCase())) m.payment.bic = "";

	return { model: m, issues: issues };
}

/* ------------------------------------------------------------------------------------------- UBL writer */

function toXml(m) {
	var out = [], depth = 0, cur = m.currency, credit = m.typeCode === "381";
	var root = credit ? "CreditNote" : "Invoice";
	function pad() { return new Array(depth + 1).join("  "); }
	function open(n, attrs) { out.push(pad() + "<" + n + (attrs || "") + ">"); depth++; }
	function close(n) { depth--; out.push(pad() + "</" + n + ">"); }
	function leaf(n, v, attrs) { if (has(v)) out.push(pad() + "<" + n + (attrs || "") + ">" + xmlEsc(v) + "</" + n + ">"); }
	function amt(n, v) { out.push(pad() + "<" + n + ' currencyID="' + cur + '">' + money(v) + "</" + n + ">"); }
	function taxCategory(cat, rate) {
		open("cac:TaxCategory");
		leaf("cbc:ID", cat);
		if (cat !== "O") leaf("cbc:Percent", trimNum(rate, 0, 2));
		var vc = VAT_CATEGORIES[cat] || {};
		if (cat !== "S" && cat !== "Z") { leaf("cbc:TaxExemptionReasonCode", vc.code); leaf("cbc:TaxExemptionReason", vc.reason); }
		open("cac:TaxScheme"); leaf("cbc:ID", "VAT"); close("cac:TaxScheme");
		close("cac:TaxCategory");
	}
	function address(a) {
		open("cac:PostalAddress");
		leaf("cbc:StreetName", a.street); leaf("cbc:AdditionalStreetName", a.street2);
		leaf("cbc:CityName", a.city); leaf("cbc:PostalZone", a.zip);
		open("cac:Country"); leaf("cbc:IdentificationCode", a.country); close("cac:Country");
		close("cac:PostalAddress");
	}

	out.push('<?xml version="1.0" encoding="UTF-8"?>');
	open(root, ' xmlns="urn:oasis:names:specification:ubl:schema:xsd:' + root + '-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"');
	leaf("cbc:CustomizationID", CUSTOMIZATION);
	leaf("cbc:ProfileID", PROFILE);
	leaf("cbc:ID", m.id);
	leaf("cbc:IssueDate", m.issueDate);
	if (!credit) leaf("cbc:DueDate", m.dueDate);   /* a UBL credit note has no document-level due date: it goes into PaymentMeans */
	leaf(credit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", m.typeCode);
	leaf("cbc:Note", m.note);
	leaf("cbc:DocumentCurrencyCode", cur);
	if (m.taxEur !== undefined) leaf("cbc:TaxCurrencyCode", "EUR");
	leaf("cbc:BuyerReference", m.buyerReference);
	if (m.orderRef) { open("cac:OrderReference"); leaf("cbc:ID", m.orderRef); close("cac:OrderReference"); }
	if (m.precedingInvoice) { open("cac:BillingReference"); open("cac:InvoiceDocumentReference"); leaf("cbc:ID", m.precedingInvoice); close("cac:InvoiceDocumentReference"); close("cac:BillingReference"); }

	/* seller */
	open("cac:AccountingSupplierParty"); open("cac:Party");
	leaf("cbc:EndpointID", m.seller.contactEmail, ' schemeID="EM"');
	open("cac:PartyName"); leaf("cbc:Name", m.seller.name); close("cac:PartyName");
	address(m.seller);
	if (m.seller.vatId) { open("cac:PartyTaxScheme"); leaf("cbc:CompanyID", m.seller.vatId); open("cac:TaxScheme"); leaf("cbc:ID", "VAT"); close("cac:TaxScheme"); close("cac:PartyTaxScheme"); }
	open("cac:PartyLegalEntity"); leaf("cbc:RegistrationName", m.seller.name); leaf("cbc:CompanyID", m.seller.regNo); close("cac:PartyLegalEntity");
	open("cac:Contact"); leaf("cbc:Name", m.seller.contactName); leaf("cbc:Telephone", m.seller.contactPhone); leaf("cbc:ElectronicMail", m.seller.contactEmail); close("cac:Contact");
	close("cac:Party"); close("cac:AccountingSupplierParty");

	/* buyer */
	open("cac:AccountingCustomerParty"); open("cac:Party");
	leaf("cbc:EndpointID", m.buyer.email, ' schemeID="EM"');
	open("cac:PartyName"); leaf("cbc:Name", m.buyer.name); close("cac:PartyName");
	address(m.buyer);
	if (m.buyer.vatId) { open("cac:PartyTaxScheme"); leaf("cbc:CompanyID", m.buyer.vatId); open("cac:TaxScheme"); leaf("cbc:ID", "VAT"); close("cac:TaxScheme"); close("cac:PartyTaxScheme"); }
	open("cac:PartyLegalEntity"); leaf("cbc:RegistrationName", m.buyer.name); close("cac:PartyLegalEntity");
	if (m.buyer.contactName || m.buyer.contactEmail) {
		open("cac:Contact"); leaf("cbc:Name", m.buyer.contactName); leaf("cbc:Telephone", m.buyer.contactPhone); leaf("cbc:ElectronicMail", m.buyer.contactEmail); close("cac:Contact");
	}
	close("cac:Party"); close("cac:AccountingCustomerParty");

	/* delivery (required for category K) */
	if (m.deliveryDate) {
		open("cac:Delivery"); leaf("cbc:ActualDeliveryDate", m.deliveryDate);
		if (m.deliveryAddr && m.deliveryAddr.country) { open("cac:DeliveryLocation"); open("cac:Address"); leaf("cbc:StreetName", m.deliveryAddr.street); leaf("cbc:CityName", m.deliveryAddr.city); leaf("cbc:PostalZone", m.deliveryAddr.zip); open("cac:Country"); leaf("cbc:IdentificationCode", m.deliveryAddr.country); close("cac:Country"); close("cac:Address"); close("cac:DeliveryLocation"); }
		close("cac:Delivery");
	}

	/* payment */
	open("cac:PaymentMeans");
	leaf("cbc:PaymentMeansCode", m.payment.meansCode);
	if (credit) leaf("cbc:PaymentDueDate", m.dueDate);
	leaf("cbc:PaymentID", m.payment.reference);
	open("cac:PayeeFinancialAccount");
	leaf("cbc:ID", m.payment.iban); leaf("cbc:Name", m.payment.accountName);
	if (m.payment.bic) { open("cac:FinancialInstitutionBranch"); leaf("cbc:ID", m.payment.bic.toUpperCase()); close("cac:FinancialInstitutionBranch"); }
	close("cac:PayeeFinancialAccount");
	close("cac:PaymentMeans");
	if (m.payment.terms) { open("cac:PaymentTerms"); leaf("cbc:Note", m.payment.terms); close("cac:PaymentTerms"); }

	/* VAT */
	open("cac:TaxTotal");
	amt("cbc:TaxAmount", m.totals.tax);
	m.vat.forEach(function (g) {
		open("cac:TaxSubtotal"); amt("cbc:TaxableAmount", g.taxable); amt("cbc:TaxAmount", g.tax); taxCategory(g.cat, g.rate); close("cac:TaxSubtotal");
	});
	close("cac:TaxTotal");
	if (m.taxEur !== undefined) { open("cac:TaxTotal"); out.push(pad() + '<cbc:TaxAmount currencyID="EUR">' + money(m.taxEur) + "</cbc:TaxAmount>"); close("cac:TaxTotal"); }

	/* totals */
	open("cac:LegalMonetaryTotal");
	amt("cbc:LineExtensionAmount", m.totals.lines);
	amt("cbc:TaxExclusiveAmount", m.totals.taxExclusive);
	amt("cbc:TaxInclusiveAmount", m.totals.taxInclusive);
	if (m.totals.prepaid > 0) amt("cbc:PrepaidAmount", m.totals.prepaid);
	if (Math.abs(m.totals.rounding) > 0.004) amt("cbc:PayableRoundingAmount", m.totals.rounding);
	amt("cbc:PayableAmount", m.totals.payable);
	close("cac:LegalMonetaryTotal");

	/* lines */
	m.lines.forEach(function (l) {
		open(credit ? "cac:CreditNoteLine" : "cac:InvoiceLine");
		leaf("cbc:ID", l.id);
		leaf(credit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity", trimNum(l.qty, 0, 4), ' unitCode="' + l.unit + '"');
		amt("cbc:LineExtensionAmount", l.net);
		open("cac:Item");
		leaf("cbc:Description", l.desc && l.desc !== l.name ? l.desc.slice(0, 1000) : "");
		leaf("cbc:Name", l.name.slice(0, 200));
		if (l.code) { open("cac:SellersItemIdentification"); leaf("cbc:ID", l.code); close("cac:SellersItemIdentification"); }
		open("cac:ClassifiedTaxCategory"); leaf("cbc:ID", l.cat);
		if (l.cat !== "O") leaf("cbc:Percent", trimNum(l.rate, 0, 2));
		open("cac:TaxScheme"); leaf("cbc:ID", "VAT"); close("cac:TaxScheme");
		close("cac:ClassifiedTaxCategory");
		close("cac:Item");
		open("cac:Price"); out.push(pad() + '<cbc:PriceAmount currencyID="' + cur + '">' + trimNum(l.price, 2, 6) + "</cbc:PriceAmount>"); close("cac:Price");
		close(credit ? "cac:CreditNoteLine" : "cac:InvoiceLine");
	});

	close(root);
	return out.join("\n") + "\n";
}

/* check = normalise + (when there is no blocking problem) the XML */
function check(raw, ov, conf) {
	var r = normalise(raw, ov, conf);
	r.errors = r.issues.filter(function (i) { return i.level === "error"; });
	r.warnings = r.issues.filter(function (i) { return i.level === "warn"; });
	r.xml = r.errors.length ? "" : toXml(r.model);
	return r;
}

function fileName(id) { return String(id || "invoice").replace(/[^A-Za-z0-9._-]+/g, "_") + "_xrechnung.xml"; }

/* ------------------------------------------------------------------------------------------- screen */

var ctx = { settings: function () { return {}; }, save: function () {}, toast: function () {}, erp: function () { return null; }, erpReady: function () { return "No ERPNext."; }, saveFile: null };
var st = { rows: [], ticked: {}, prepared: {}, ov: {}, busy: false };

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s === undefined || s === null ? "" : s).replace(/[<>&"]/g, function (c) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]; }); }
function S() { return ctx.settings() || {}; }
function conf() { var s = S(); return { contactName: s.xr_contact_name, contactPhone: s.xr_contact_phone, contactEmail: s.xr_contact_email }; }
function series() { return str(S().xr_series) || "IOG"; }
function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function b64(text) {
	var bytes = new TextEncoder().encode(text), bin = "";
	for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
	return btoa(bin);
}
function done() { var s = S(); return (s.xr_done && typeof s.xr_done === "object") ? s.xr_done : {}; }

var FIELD_LABEL = { leitweg: "Leitweg-ID", buyerEmail: "Authority e-mail (BT-49)", contactName: "Seller contact name", contactPhone: "Seller contact phone",
	contactEmail: "Seller contact e-mail", vatCat: "VAT category for 0 % lines", deliveryDate: "Delivery date" };

function html() {
	var s = S();
	return '<h2 class="g">Sales invoices → XRechnung</h2>' +
		'<p class="sub">XRechnung 3.0 (UBL XML) for German authorities. Only submitted Sales Invoices of the series below are listed; the file is checked against the XRechnung rules before it is written.</p>' +
		'<div class="row"><div class="f"><label>Series starts with</label><input id="xr-series" value="' + esc(series()) + '"></div>' +
		'<div class="f"><label>From</label><input id="xr-from" placeholder="YYYY-MM-DD" value="' + esc(daysAgo(90)) + '"></div>' +
		'<div class="f"><label>To</label><input id="xr-to" placeholder="YYYY-MM-DD" value="' + esc(today()) + '"></div>' +
		'<div class="f"><label>Customer or number</label><input id="xr-q" placeholder="optional"></div></div>' +
		'<button class="b" id="btn-xr-list">List invoices</button>' +
		'<div class="row" style="margin-top:6px"><div class="f"><label>Or open one invoice</label><input id="xr-no" placeholder="e.g. IOG-2026-00012"></div>' +
		'<button class="b sec" id="btn-xr-open" style="align-self:flex-end;margin:0 0 10px">Open</button></div>' +
		'<details style="margin:8px 0"><summary class="hint" style="cursor:pointer">Seller contact required by XRechnung (BR-DE-2): leave empty to take it from ERPNext</summary>' +
		'<div class="row"><div class="f"><label>Name</label><input id="xr-cname" value="' + esc(s.xr_contact_name || "") + '"></div>' +
		'<div class="f"><label>Phone</label><input id="xr-cphone" value="' + esc(s.xr_contact_phone || "") + '"></div>' +
		'<div class="f"><label>E-mail</label><input id="xr-cmail" value="' + esc(s.xr_contact_email || "") + '"></div></div></details>' +
		'<div id="xr-list"></div>' +
		'<div id="xr-actions" style="display:none"><label class="hint" style="display:block;margin:6px 0"><input type="checkbox" id="xr-attach" checked> Also attach the XML to the Sales Invoice in ERPNext</label>' +
		'<button class="b" id="btn-xr-prep">Check ticked invoices</button> <button class="b" id="btn-xr-make">Create XRechnung files</button></div>' +
		'<div id="xr-result"></div>';
}

function paintList() {
	var box = $("xr-list"), dn = done();
	if (!st.rows.length) { box.innerHTML = '<p class="hint">No submitted invoice of that series in the period.</p>'; $("xr-actions").style.display = "none"; return; }
	var h = '<table class="xr-tab"><tr><th></th><th>Invoice</th><th>Date</th><th>Customer</th><th>Total</th><th>Leitweg-ID</th><th></th></tr>';
	st.rows.forEach(function (r) {
		var key = r.name, p = st.prepared[key], badge = "";
		if (dn[key]) badge = '<span class="pill">exported ' + esc(dn[key]) + "</span>";
		var total = r.rounded_total || r.grand_total;
		h += '<tr><td><input type="checkbox" data-xr-tick="' + esc(key) + '"' + (st.ticked[key] ? " checked" : "") + "></td><td><b>" + esc(r.name) + "</b>" +
			(r.is_return ? " (credit note)" : "") + "</td><td>" + esc(r.posting_date) + "</td><td>" + esc(r.customer_name || r.customer) + "</td><td>" +
			esc(money(total)) + " " + esc(r.currency || "") + "</td><td>" + (has(r.leitweg_id) ? esc(r.leitweg_id) : '<span style="color:var(--err)">—</span>') + "</td><td>" + badge + "</td></tr>";
		if (p) h += '<tr><td></td><td colspan="6">' + panel(key) + "</td></tr>";
	});
	h += "</table>";
	box.innerHTML = h;
	$("xr-actions").style.display = "";
	Array.prototype.forEach.call(box.querySelectorAll("[data-xr-tick]"), function (c) {
		c.onchange = function () { st.ticked[c.getAttribute("data-xr-tick")] = c.checked; };
	});
	Array.prototype.forEach.call(box.querySelectorAll("[data-xr-fix]"), function (el) {
		el.onchange = function () {
			var key = el.getAttribute("data-xr-inv"), f = el.getAttribute("data-xr-fix");
			if (f === "contactName" || f === "contactPhone" || f === "contactEmail") {
				var map = { contactName: "xr_contact_name", contactPhone: "xr_contact_phone", contactEmail: "xr_contact_email" };
				S()[map[f]] = el.value.trim(); ctx.save(); recheckAll();
			} else {
				(st.ov[key] = st.ov[key] || {})[f] = el.value.trim(); recheck(key); paintList();
			}
		};
	});
}

function panel(key) {
	var p = st.prepared[key];
	if (!p) return "";
	if (p.loading) return '<p class="hint">Reading from ERPNext…</p>';
	if (p.error) return '<p class="hint" style="color:var(--err)">' + esc(p.error) + "</p>";
	var r = p.result, m = r.model, h = "";
	h += '<p class="hint" style="margin:0 0 4px">Net ' + esc(money(m.totals.taxExclusive)) + " + VAT " + esc(money(m.totals.tax)) + " = <b>" + esc(money(m.totals.payable)) + " " + esc(m.currency) + "</b> payable" +
		(m.vat.length ? " — VAT: " + m.vat.map(function (g) { return esc(g.cat + " " + g.rate + " %"); }).join(", ") : "") + "</p>";
	r.issues.forEach(function (i) {
		h += '<p class="hint" style="margin:2px 0;color:' + (i.level === "error" ? "var(--err)" : "var(--violet)") + '">' + (i.level === "error" ? "✗ " : "⚠ ") + esc(i.msg) + "</p>";
	});
	var wanted = {};
	r.issues.forEach(function (i) { if (FIELD_LABEL[i.field]) wanted[i.field] = true; });
	if (m.needsCat) wanted.vatCat = true;
	if (m.hasK || m.hasG) wanted.deliveryDate = true;
	var ov = st.ov[key] || {};
	var fields = Object.keys(wanted);
	if (fields.length) {
		h += '<div class="row">';
		fields.forEach(function (f) {
			var val = "";
			if (f === "vatCat") {
				h += '<div class="f"><label>' + FIELD_LABEL[f] + '</label><select data-xr-inv="' + esc(key) + '" data-xr-fix="vatCat">' +
					["K", "AE", "E", "Z", "G", "O"].map(function (c) { return '<option value="' + c + '"' + (m.zeroCat === c ? " selected" : "") + ">" + esc(VAT_CATEGORIES[c].label) + "</option>"; }).join("") + "</select></div>";
				return;
			}
			if (f === "contactName") val = m.seller.contactName; else if (f === "contactPhone") val = m.seller.contactPhone; else if (f === "contactEmail") val = m.seller.contactEmail;
			else if (f === "deliveryDate") val = m.deliveryDate || ""; else val = ov[f] || "";
			h += '<div class="f"><label>' + FIELD_LABEL[f] + '</label><input data-xr-inv="' + esc(key) + '" data-xr-fix="' + f + '" value="' + esc(val) + '"></div>';
		});
		h += "</div>";
	}
	h += '<p class="hint" style="margin:2px 0;color:' + (r.errors.length ? "var(--err)" : "#1f8a4c") + '">' + (r.errors.length ? "Not ready: fix the points above (or in ERPNext, then check again)." : "Ready to export.") + "</p>";
	return h;
}

function recheck(key) {
	var p = st.prepared[key];
	if (p && p.raw) p.result = check(p.raw, st.ov[key], conf());
}
function recheckAll() { Object.keys(st.prepared).forEach(recheck); paintList(); }

function listClicked() {
	var io = ctx.erp(), bad = ctx.erpReady();
	if (bad || !io) { ctx.toast(bad || "ERPNext is not set up.", "err"); return; }
	var s = S(); s.xr_series = $("xr-series").value.trim() || "IOG"; ctx.save();
	st.busy = true; $("btn-xr-list").disabled = true;
	list(io, { series: s.xr_series, from: $("xr-from").value.trim(), to: $("xr-to").value.trim(), text: $("xr-q").value }).then(function (rows) {
		st.rows = rows; st.ticked = {}; st.prepared = {};
		paintList();
	}).catch(function (e) {
		$("xr-list").innerHTML = '<p class="hint" style="color:var(--err)">' + esc((e && e.errors && e.errors[0] && e.errors[0].message) || (e && e.message) || e) + "</p>";
	}).then(function () { st.busy = false; $("btn-xr-list").disabled = false; });
}

function openClicked() {
	var io = ctx.erp(), bad = ctx.erpReady(), no = $("xr-no").value.trim();
	if (bad || !io) { ctx.toast(bad || "ERPNext is not set up.", "err"); return; }
	if (!no) { ctx.toast("Type a Sales Invoice number.", "err"); return; }
	io.fetchDoc("Sales Invoice", no).then(function (inv) {
		if (!inv) throw new Error("No Sales Invoice " + no + " in ERPNext.");
		if (String(inv.naming_series || inv.name).toUpperCase().indexOf(series().toUpperCase()) !== 0 && String(inv.name).toUpperCase().indexOf(series().toUpperCase()) !== 0) {
			throw new Error(no + " is not in the “" + series() + "” series.");
		}
		var row = { name: inv.name, posting_date: inv.posting_date, customer: inv.customer, customer_name: inv.customer_name, currency: inv.currency,
			grand_total: inv.grand_total, rounded_total: inv.rounded_total, is_return: inv.is_return, leitweg_id: inv.leitweg_id };
		if (!st.rows.some(function (r) { return r.name === row.name; })) st.rows.unshift(row);
		st.ticked[row.name] = true;
		paintList();
		prepare([row.name]);
	}).catch(function (e) { ctx.toast(String((e && e.message) || e), "err"); });
}

function prepare(keys) {
	var io = ctx.erp(), bad = ctx.erpReady();
	if (bad || !io) { ctx.toast(bad || "ERPNext is not set up.", "err"); return Promise.resolve(); }
	keys.forEach(function (k) { st.prepared[k] = { loading: true }; });
	paintList();
	return keys.reduce(function (chain, k) {
		return chain.then(function () {
			return collect(io, k).then(function (raw) {
				if (!raw) { st.prepared[k] = { error: "Invoice not found." }; return; }
				st.prepared[k] = { raw: raw, result: check(raw, st.ov[k], conf()) };
			}).catch(function (e) {
				st.prepared[k] = { error: String((e && e.errors && e.errors[0] && e.errors[0].message) || (e && e.message) || e) };
			}).then(paintList);
		});
	}, Promise.resolve());
}

function prepClicked() {
	var keys = Object.keys(st.ticked).filter(function (k) { return st.ticked[k]; });
	if (!keys.length) { ctx.toast("Tick at least one invoice.", "err"); return; }
	prepare(keys);
}

function makeClicked() {
	var keys = Object.keys(st.ticked).filter(function (k) { return st.ticked[k]; });
	if (!keys.length) { ctx.toast("Tick at least one invoice.", "err"); return; }
	var missing = keys.filter(function (k) { return !st.prepared[k] || !st.prepared[k].result; });
	var go = missing.length ? prepare(missing) : Promise.resolve();
	$("btn-xr-make").disabled = true;
	go.then(function () {
		var io = ctx.erp(), attach = $("xr-attach").checked, lines = [], chain = Promise.resolve();
		keys.forEach(function (k) {
			chain = chain.then(function () {
				var p = st.prepared[k];
				if (!p || !p.result) { lines.push("✗ " + k + " — " + ((p && p.error) || "not checked")); return; }
				if (p.result.errors.length) { lines.push("✗ " + k + " — not exported: " + p.result.errors.map(function (e) { return e.msg; }).join(" ")); return; }
				var name = fileName(k), res;
				try { res = JSON.parse(ctx.saveFile(name, b64(p.result.xml), "application/xml")); } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
				if (!res.ok) { lines.push("✗ " + k + " — could not save: " + res.error); return; }
				var line = "✓ " + k + " → " + res.path;
				var s = S(); s.xr_done = done(); s.xr_done[k] = today(); ctx.save();
				if (!attach || !io || !io.attachFile) { lines.push(line); return; }
				return io.attachFile("Sales Invoice", k, "data:application/xml;base64," + b64(p.result.xml), name).then(function (r) {
					lines.push(line + (r && r.state === "created" ? " (attached in ERPNext)" : " (not attached in ERPNext" + (r && r.errors && r.errors[0] ? ": " + r.errors[0].message : "") + ")"));
				}, function (e) { lines.push(line + " (not attached in ERPNext: " + String((e && e.message) || e) + ")"); });
			});
		});
		return chain.then(function () {
			$("xr-result").innerHTML = '<p class="hint">' + lines.map(esc).join("<br>") + "</p>";
			paintList();
		});
	}).then(function () { $("btn-xr-make").disabled = false; });
}

function init(c) {
	Object.keys(c || {}).forEach(function (k) { ctx[k] = c[k]; });
	var card = $("card-xr");
	if (!card) return;
	card.innerHTML = html();
	$("btn-xr-list").onclick = listClicked;
	$("btn-xr-open").onclick = openClicked;
	$("btn-xr-prep").onclick = prepClicked;
	$("btn-xr-make").onclick = makeClicked;
	[["xr-cname", "xr_contact_name"], ["xr-cphone", "xr_contact_phone"], ["xr-cmail", "xr_contact_email"]].forEach(function (p) {
		$(p[0]).onchange = function () { S()[p[1]] = $(p[0]).value.trim(); ctx.save(); recheckAll(); };
	});
}

return {
	init: init, list: list, collect: collect, normalise: normalise, check: check, toXml: toXml, fileName: fileName,
	_internals: { ibanOk: ibanOk, countryCode: countryCode, uomCode: uomCode, plain: plain, VAT_CATEGORIES: VAT_CATEGORIES, CUSTOMIZATION: CUSTOMIZATION }
};
})();
