/* docrules.js — reads an accounts document's text WITHOUT any network or AI,
   in English, Lithuanian and German. It is used (a) to pre-fill the review
   form instantly, even when no Anthropic key is set, (b) as a safety net when
   the AI call fails or answers with the wrong company, and (c) to decide
   whether a PDF's text layer is usable at all (scans have none).

   It is deliberately conservative: a field it is not reasonably sure about is
   left null so the employee (or the AI) fills it in rather than being handed
   a confident wrong value.

   Everything runs on a "folded" copy of the text in which accented letters
   are replaced by plain ASCII ones one-for-one (ž -> z, ä -> a, Ą -> A ...),
   so a pattern such as /saskaita faktura/ matches "SĄSKAITA FAKTŪRA" and the
   character positions in the folded copy are the same as in the original —
   which lets names be cut out of the ORIGINAL text with their real accents. */
window.CS_RULES = (function () {
"use strict";

/* Our own company. Never the supplier on a purchase invoice, and its
   registration/VAT codes must never be mistaken for the supplier's. */
var OWN = { names: ["integrated optics"], codes: ["302833442", "LT100007179012"] };
function setOwn(o) {
	if (o && o.names) OWN.names = o.names.map(function (n) { return fold(n).toLowerCase(); });
	if (o && o.codes) OWN.codes = o.codes.map(function (c) { return String(c).replace(/\s+/g, "").toUpperCase(); });
}

/* ------------------------------------------------------------------ folding */

var FOLD = {};
(function () {
	var pairs = "ąa čc ęe ėe įi šs ųu ūu žz äa öo üu ßs ée èe êe ëe àa âa áa åa ãa ôo óo òo õo øo çc ñn " +
		"łl śs źz żz ćc ńn ěe řr ýy íi ìi ïi úu ùu ůu őo űu œo æa ďd ťt ňn";
	pairs.split(" ").forEach(function (p) {
		FOLD[p.charAt(0)] = p.charAt(1);
		FOLD[p.charAt(0).toUpperCase()] = p.charAt(1).toUpperCase();
	});
	FOLD[" "] = " "; FOLD["–"] = "-"; FOLD["—"] = "-"; FOLD["−"] = "-";
	FOLD["’"] = "'"; FOLD["„"] = '"'; FOLD["“"] = '"'; FOLD["”"] = '"';
})();

/* same length as the input, accents removed, case kept */
function fold(s) {
	return String(s || "").replace(/[^\x00-\x7f]/g, function (c) { return FOLD[c] || c; });
}

/* ------------------------------------------------------------------ numbers */

var AMOUNT_RE = "-?\\d{1,3}(?:[ .,]\\d{3})+(?:[.,]\\d{1,4})?|-?\\d+(?:[.,]\\d{1,4})?";

function parseAmount(s) {
	var t = String(s || "").replace(/[\s ]/g, "");
	if (!/\d/.test(t)) return null;
	var neg = /^-/.test(t);
	t = t.replace(/^-/, "");
	var lastDot = t.lastIndexOf("."), lastCom = t.lastIndexOf(",");
	var dec = -1;
	if (lastDot >= 0 && lastCom >= 0) dec = Math.max(lastDot, lastCom);
	else if (lastDot >= 0 || lastCom >= 0) {
		var p = Math.max(lastDot, lastCom);
		var after = t.length - p - 1;
		var sepCount = (t.match(/[.,]/g) || []).length;
		// "1.234" / "1,234" with exactly three digits after a single separator = thousands
		dec = (after === 3 && sepCount === 1 && p <= 3) ? -1 : (sepCount > 1 && after === 3 ? -1 : p);
	}
	var intPart = dec >= 0 ? t.slice(0, dec) : t;
	var frac = dec >= 0 ? t.slice(dec + 1) : "";
	intPart = intPart.replace(/[.,]/g, "");
	var n = parseFloat(intPart + (frac ? "." + frac : ""));
	if (isNaN(n)) return null;
	return neg ? -n : n;
}

/* ------------------------------------------------------------------- dates */

var MONTHS = [["sau", 1], ["jan", 1], ["jae", 1], ["vas", 2], ["feb", 2], ["kov", 3], ["mar", 3], ["mae", 3],
	["bal", 4], ["apr", 4], ["geg", 5], ["mai", 5], ["may", 5], ["bir", 6], ["jun", 6], ["lie", 7],
	["jul", 7], ["rugp", 8], ["aug", 8], ["rugs", 9], ["sep", 9], ["spa", 10], ["okt", 10], ["oct", 10],
	["lap", 11], ["nov", 11], ["gru", 12], ["dez", 12], ["dec", 12]];

function monthFromWord(w) {
	w = fold(w).toLowerCase();
	if (w.length < 3) return 0;
	for (var i = 0; i < MONTHS.length; i++) if (w.indexOf(MONTHS[i][0]) === 0) return MONTHS[i][1];
	return 0;
}

function iso(y, m, d) {
	y = Number(y); m = Number(m); d = Number(d);
	if (y < 100) y += 2000;
	if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
	function z(n) { return (n < 10 ? "0" : "") + n; }
	return y + "-" + z(m) + "-" + z(d);
}

/* every date in `t` (already folded), earliest first: [{iso, index, end}] */
function findDates(t) {
	var out = [], m, re;
	function add(i, len, v) { if (v) out.push({ iso: v, index: i, end: i + len }); }

	re = /(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/g;                       // 2026-04-22, 2026.04.22
	while ((m = re.exec(t))) add(m.index, m[0].length, iso(m[1], m[2], m[3]));

	re = /(\d{4})\s*m\.?\s*([A-Za-z]{3,})\s*(\d{1,2})\s*d?\b/gi;                // 2026 m. balandzio 22 d.
	while ((m = re.exec(t))) { var lm = monthFromWord(m[2]); if (lm) add(m.index, m[0].length, iso(m[1], lm, m[3])); }

	re = /(\d{1,2})(?:st|nd|rd|th)?\.?\s*(?:of\s+)?([A-Za-z]{3,})\.?,?\s*(\d{4})/gi;  // 22. April 2026, 22 Apr 2026
	while ((m = re.exec(t))) { var dm = monthFromWord(m[2]); if (dm) add(m.index, m[0].length, iso(m[3], dm, m[1])); }

	re = /([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/gi;          // April 22, 2026
	while ((m = re.exec(t))) { var em = monthFromWord(m[1]); if (em) add(m.index, m[0].length, iso(m[3], em, m[2])); }

	re = /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})(?!\d)/g;                  // 22.04.2026, 22/04/26 (day first)
	while ((m = re.exec(t))) {
		var a = Number(m[1]), b = Number(m[2]);
		add(m.index, m[0].length, (b > 12 && a <= 12) ? iso(m[3], a, b) : iso(m[3], b, a));
	}

	out.sort(function (x, y) { return x.index - y.index; });
	// drop a date that sits inside an earlier one (e.g. "2026.04.22" also read as d.m.y)
	return out.filter(function (d, i) {
		return !out.some(function (o, j) { return j !== i && o.index <= d.index && o.end >= d.end && (o.end - o.index) > (d.end - d.index); });
	});
}

var DATE_LABELS = ["saskaitos israsymo data", "saskaitos faktura data", "saskaitos data", "israsymo data",
	"dokumento data", "rechnungsdatum", "belegdatum", "ausstellungsdatum", "invoice date", "date of issue",
	"issue date", "datum", "data", "date"];
var DUE_LABELS = ["apmoketi iki", "apmokejimo terminas", "apmokejimo data", "moketi iki", "moketinas iki",
	"mokejimo terminas", "apmoketi per", "zahlbar bis", "zahlbar innerhalb", "fallig am", "falligkeitsdatum",
	"falligkeit", "zahlungsziel", "zahlungsfrist", "due date", "payment due date", "payment due", "pay by",
	"pay until", "due on", "due"];

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function labelledDate(t, labels, rejectBefore) {
	for (var i = 0; i < labels.length; i++) {
		var re = new RegExp("\\b" + esc(labels[i]).replace(/ /g, "\\s+") + "\\b", "gi"), m;
		while ((m = re.exec(t))) {
			var before = t.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
			if (rejectBefore && rejectBefore.test(before)) continue;
			var win = t.slice(m.index + m[0].length, m.index + m[0].length + 48);
			var ds = findDates(win);
			if (ds.length && ds[0].index <= 14) return { iso: ds[0].iso, at: m.index + m[0].length + ds[0].index };
		}
	}
	return null;
}

/* ----------------------------------------------------------- small helpers */

function tidy(s) { return String(s || "").replace(/^[\s.,;:]+|[\s.,;:]+$/g, ""); }
function codeKey(s) { return String(s || "").replace(/[\s.\-]/g, "").toUpperCase(); }
function isOwnCode(c) { var k = codeKey(c); return !!k && OWN.codes.some(function (o) { return codeKey(o) === k; }); }
function isOwnName(n) {
	var f = fold(n).toLowerCase();
	return OWN.names.some(function (o) { return f.indexOf(o) >= 0; });
}

/* ------------------------------------------------------------ document no. */

function findDocumentNo(t, orig) {
	var m = /serij\w*[:\s]*([A-Za-z0-9]{1,6})\s*(?:nr|no|numeris)\b\.?[:\s]*([A-Za-z0-9][A-Za-z0-9\-\/]*\d[A-Za-z0-9\-\/]*)/i.exec(t);
	if (m) return tidy(m[1] + m[2]);

	var re = /(?:saskaitos?\s*(?:faktura\s*)?(?:nr|numeris|no)|saskaita\s*faktura\s*(?:nr|no)|invoice\s*(?:no|nr|number|num|#)|rechnungs?-?\s*(?:nr|nummer)|rechnung\s*(?:nr|no)|faktura\s*(?:nr|no)|beleg-?\s*(?:nr|nummer)|dokumento\s*(?:nr|numeris))\b\.?\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9\-\/.]{1,24})/gi;
	while ((m = re.exec(t))) {
		var v = tidy(m[1]);
		if (/\d/.test(v) && !/^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}$/.test(v)) return v;
	}
	return null;
}

/* ---------------------------------------------------------------- supplier */

var STOP_WORDS = ["pvm", "saskaita", "saskaitos", "faktura", "invoice", "rechnung", "serija", "data", "date", "datum",
	"pirkejas", "pardavejas", "tiekejas", "seller", "buyer", "from", "to", "bill", "sold", "verkaufer", "kaufer",
	"lieferant", "kunde", "adresas", "address", "adresse", "company", "code", "vat", "no", "nr", "tel", "email",
	"proforma", "pro", "forma", "isankstine", "kreditine", "debetine", "page", "puslapis", "seite", "the", "and",
	"imones", "kodas", "reg", "registration", "registrierung", "iban", "tel", "fax", "web", "www", "adr"];
var BANK_RE = /bank|banka|bankas|sparkasse|volksbank|credit|luminor|revolut|paysera|swedbank|\bseb\b|citadele|siauliu|dnb|nordea/i;

var SUFFIX = "(?:UAB|AB|MB|II|VsI|SIA|OU|GmbH(?:\\s*&\\s*Co\\.?\\s*KG)?|AG|KGaA|KG|OHG|UG|e\\.K\\.|eG|Ltd\\.?|LLC|Inc\\.?|Oy|BV|SARL|S\\.r\\.l\\.|S\\.A\\.|Sp\\.\\s*z\\s*o\\.o\\.)";
var PREFIX = "(?:UAB|AB|MB|II|VsI|SIA|OU)";

function dropLeadingStops(words) {
	while (words.length > 1 && STOP_WORDS.indexOf(fold(words[0]).toLowerCase().replace(/[^a-z]/g, "")) >= 0) words.shift();
	return words;
}

function companyCandidates(t, orig) {
	var out = [], m, re;
	// "ESEMDA, UAB"  /  "Müller Optik GmbH"
	re = new RegExp("((?:[A-Z0-9][\\w&'.\\-]*\\s+){0,4}[A-Z0-9][\\w&'.\\-]*)\\s*,?\\s*(" + SUFFIX + ")(?![A-Za-z])", "g");
	while ((m = re.exec(t))) {
		var words = dropLeadingStops(m[1].split(/\s+/));
		var lead = m[1].length - words.join(" ").length;
		if (lead < 0) lead = 0;
		var start = m.index + (m[1].length - words.join(" ").length);
		var end = m.index + m[0].length;
		out.push({ name: tidy(orig.slice(start, end)), at: start, end: end });
	}
	// "UAB Foo Bar" — only when that UAB is not just the tail of an earlier "Foo, UAB"
	var suffixed = out.slice();
	re = new RegExp("\\b(" + PREFIX + ")\\s+((?:[A-Z0-9][\\w&'.\\-]*\\s*){1,4})", "g");
	while ((m = re.exec(t))) {
		var at = m.index;
		if (suffixed.some(function (c) { return c.end > at && c.end <= at + 6; })) continue;
		var toks = orig.slice(m.index, m.index + m[0].length).split(/\s+/).filter(Boolean);
		while (toks.length > 1 && STOP_WORDS.indexOf(fold(toks[toks.length - 1]).toLowerCase().replace(/[^a-z]/g, "")) >= 0) toks.pop();
		if (toks.length < 2) continue;
		var nm = tidy(toks.join(" "));
		out.push({ name: nm, at: at, end: at + nm.length });
	}
	out.sort(function (a, b) { return a.at - b.at; });
	return out.filter(function (c) {
		if (!c.name || c.name.length < 3) return false;
		if (BANK_RE.test(fold(c.name))) return false;
		var after = t.slice(c.end, c.end + 8);
		if (/^\s*bank/i.test(after)) return false;
		return true;
	});
}

var BUYER_CTX = /(pirkejas|gavejas|kunde|kaufer|rechnungsempfanger|bill\s*to|buyer|customer|sold\s*to|ship\s*to|deliver\s*to|klientas|auftraggeber|empfanger)[^a-z0-9]{0,3}$/i;
var SELLER_CTX = /(pardavejas|tiekejas|israse|issued\s*by|verkaufer|lieferant|rechnungssteller|aussteller|seller|supplier|vendor|from)[^a-z0-9]{0,3}$/i;

function findSupplier(t, orig) {
	var cands = companyCandidates(t, orig);
	var best = null, firstForeign = null, ownCand = null;
	cands.forEach(function (c) {
		var ctx = t.slice(Math.max(0, c.at - 40), c.at);
		c.buyer = BUYER_CTX.test(ctx);
		c.seller = SELLER_CTX.test(ctx);
		c.own = isOwnName(c.name);
		if (c.own) { if (!ownCand) ownCand = c; return; }
		if (c.buyer) return;
		if (c.seller && !best) best = c;
		if (!firstForeign) firstForeign = c;
	});
	return best || firstForeign || null;
	/* ownCand is reported separately by the caller (sales invoice case) */
}

/* ------------------------------------------------------------------- codes */

function allMatches(re, t, groupFn) {
	var out = [], m;
	while ((m = re.exec(t))) { var g = groupFn(m); if (g) out.push({ value: g, at: m.index }); }
	return out;
}

function findCodes(t) {
	var reg = allMatches(
		/(?:company\s*(?:code|reg(?:istration)?\.?\s*(?:no|number|nr)?)|reg(?:istration)?\.?\s*(?:no|number|nr|code)|imones\s*kodas|im\.?\s*kodas|registernummer|org(?:anisation)?\.?\s*(?:nr|no|number)|companies\s*house\s*(?:no|number)?)\b[\s.:#]*([A-Za-z0-9][A-Za-z0-9\-]{3,14})/gi,
		t, function (m) { return /\d{4}/.test(m[1]) ? m[1] : null; })
		.concat(allMatches(/\b(HR[AB])\s*(\d{3,8})\b/gi, t, function (m) { return m[1].toUpperCase() + " " + m[2]; }));
	var vat = allMatches(
		/\b(?:vat|pvm|ust|umsatzsteuer|mwst|tax\s*id)[A-Za-z .\-]{0,30}?[:#]?\s*((?:[A-Z]{2}\d{9}B\d{2})|(?:[A-Z]{2}(?:\s?\d){8,12})|\d{9,12})(?!\d)/gi,
		t, function (m) { return m[1].replace(/\s+/g, "").toUpperCase(); });
	return { reg: reg, vat: vat };
}

function nearest(list, from) {
	var best = null;
	list.forEach(function (c) {
		if (isOwnCode(c.value)) return;
		var d = c.at - from;
		if (from >= 0 && d < -20) return;       // codes printed well before the name belong to someone else
		if (from >= 0 && d > 700) return;
		if (!best || Math.abs(d) < Math.abs(best.d)) best = { v: c.value, d: d };
	});
	return best ? best.v : null;
}
function firstForeignCode(list) {
	for (var i = 0; i < list.length; i++) if (!isOwnCode(list[i].value)) return list[i].value;
	return null;
}

/* ----------------------------------------------------------- PO references */

function findPurchaseOrders(t) {
	var seen = {}, out = [], m;
	function push(v) {
		v = tidy(v).toUpperCase();
		if (v.length >= 4 && /\d/.test(v) && !seen[v]) { seen[v] = 1; out.push(v); }
	}
	var re = /\b(?:PO|P\.O\.)[-\s#:]?\s?\d{3,}[A-Z0-9\-]*/gi;
	while ((m = re.exec(t))) push(m[0].replace(/\s+/g, "-").replace(/^P\.O\.-?/i, "PO-"));
	re = /(?:uzsakymo\s*(?:nr|numeris)|bestell(?:nummer|nr)|ihre\s*bestellung|ihr\s*auftrag|auftrags(?:nummer|nr)|purchase\s*order(?:\s*(?:no|nr|number))?|order\s*(?:no|nr|number|ref\w*)|your\s*order|customer\s*order)\b\.?\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{3,20})/gi;
	while ((m = re.exec(t))) push(m[1]);
	return out.slice(0, 6);
}

/* ---------------------------------------------------------------- currency */

function findCurrency(t) {
	var counts = {}, m, re = /\b(EUR|USD|GBP|CHF|PLN|SEK|NOK|DKK|CZK|RON|HUF|JPY|CNY|CAD|AUD)\b/gi;
	while ((m = re.exec(t))) { var c = m[1].toUpperCase(); counts[c] = (counts[c] || 0) + 1; }
	counts.EUR = (counts.EUR || 0) + (t.match(/€/g) || []).length;
	counts.USD = (counts.USD || 0) + (t.match(/\$/g) || []).length;
	counts.GBP = (counts.GBP || 0) + (t.match(/£/g) || []).length;
	var best = null;
	Object.keys(counts).forEach(function (k) { if (counts[k] > 0 && (!best || counts[k] > counts[best])) best = k; });
	return best;
}

/* ------------------------------------------------------------------- total */

var STRONG_TOTAL = ["suma\\s*(?:moketi|apmoketi)?\\s*,?\\s*(?:eur|usd|gbp)", "moketina\\s*suma", "viso\\s*moketi", "viso\\s*apmoketi",
	"viso\\s*su\\s*pvm", "suma\\s*su\\s*pvm", "bendra\\s*suma", "gesamtbetrag", "rechnungsbetrag", "rechnungssumme", "bruttobetrag",
	"zahlbetrag", "endbetrag", "gesamtsumme", "zu\\s*zahlen", "amount\\s*due", "total\\s*due", "grand\\s*total", "total\\s*amount",
	"balance\\s*due", "invoice\\s*total", "total\\s*incl\\w*\\.?\\s*(?:vat|tax)", "total\\s*\\(?(?:eur|usd|gbp)\\)?"];
var WEAK_TOTAL = ["viso", "total", "summe", "suma"];
var NET_WORDS = /^[^0-9]{0,22}?(be\s*pvm|ohne|excl|exkl|netto|net\b|before\s*vat|zwischen|sub)/i;

function findTotal(t) {
	function scan(labels, weak) {
		var best = null;
		labels.forEach(function (lab) {
			var re = new RegExp("(?:^|[^a-z])(" + lab + ")(?![a-z])", "gi"), m;
			while ((m = re.exec(t))) {
				var from = m.index + m[0].length;
				var win = t.slice(from, from + 40);
				if (NET_WORDS.test(win)) continue;
				var pre = t.slice(Math.max(0, m.index - 6), m.index + 1).toLowerCase();
				if (weak && /sub\s*$|zwischen\s*$|net\s*$/.test(pre)) continue;
				var nm = new RegExp("[^0-9\\-]{0,24}?(" + AMOUNT_RE + ")").exec(win);
				if (!nm) continue;
				var v = parseAmount(nm[1]);
				if (v !== null && (best === null || v > best)) best = v;
			}
		});
		return best;
	}
	var s = scan(STRONG_TOTAL, false);
	return s !== null ? s : scan(WEAK_TOTAL, true);
}

/* ------------------------------------------------------------ doc type, lang */

function detectLanguage(t) {
	var f = t.toLowerCase();
	function n(words) { return words.reduce(function (a, w) { return a + (f.split(w).length - 1); }, 0); }
	var lt = n(["saskaita", "faktura", "pvm", "apmoketi", "pirkejas", "pardavejas", "imones kodas", "uzsakymo", "viso", "suma"]);
	var de = n(["rechnung", "datum", "betrag", "ust-", "zahlbar", "lieferant", "summe", "kunde", "bestellung", "mwst", "gmbh"]);
	var en = n(["invoice", "date", "total", "amount", "vat no", "due", "order", "supplier", "bill to", "payment"]);
	var best = Math.max(lt, de, en);
	if (best < 2) return "";
	return best === lt ? "lt" : (best === de ? "de" : "en");
}
var LANG_NAME = { lt: "Lithuanian", de: "German", en: "English" };

function detectType(t, supplierIsOwn) {
	var f = t.toLowerCase();
	var hasInvoice = /saskaita|rechnung|invoice|faktura/.test(f);
	var decl = /muitines\s*deklaracij|importo\s*deklaracij|eksporto\s*deklaracij|bendrasis\s*administracinis|zollanmeldung|einfuhranmeldung|ausfuhranmeldung|customs\s*declaration|single\s*administrative\s*document|import\s*declaration|export\s*declaration/.test(f);
	var broker = /muitines\s*tarpinink|muitines\s*paslaug|zollabfertigung|zollagent|customs\s*clearance|customs\s*broker|brokerage/.test(f);
	var ship = /frachtrechnung|speditionsrechnung|transportrechnung|freight\s*invoice|shipping\s*invoice|forwarding\s*invoice|transporto\s*paslaug|ekspedijavim|pervezim|krovinio\s*gabenim|freight\s*charges|frachtkosten/.test(f);
	var proforma = /pro[\s-]?forma|isankstine\s*saskaita|proformarechnung/.test(f);
	if (decl && (!hasInvoice || (f.split(/saskaita|rechnung|invoice|faktura/).length - 1) <= 2) && !broker) return "customs_declaration";
	if (broker && hasInvoice) return "cd_invoice";
	if (ship && hasInvoice) return "shipping_invoice";
	if (proforma) return "proforma_invoice";
	if (hasInvoice) return supplierIsOwn ? "sales_invoice" : "purchase_invoice";
	return null;
}

/* ------------------------------------------------------------- text quality */

/* Is there a usable text layer? Scans have none; some PDFs have one in which
   every glyph maps to the wrong character. */
function textQuality(text) {
	var s = String(text || "");
	var words = (s.match(/[A-Za-zÀ-ɏ]{3,}/g) || []).length;
	var sane = (s.match(/[A-Za-z0-9À-ɏ\s.,:;()\/%&@#+\-'"€$£–]/g) || []).length;
	var ratio = s.length ? sane / s.length : 0;
	var bad = (s.match(/�/g) || []).length;
	return { ok: words >= 12 && ratio >= 0.85 && bad < s.length * 0.02, words: words, ratio: ratio };
}

/* ------------------------------------------------------------------- parse */

function parse(text, hint) {
	var orig = String(text || "");
	var t = fold(orig);
	var out = { doc_type: null, document_no: null, document_date: null, payment_due_date: null,
		supplier_name: null, supplier_reg_number: null, supplier_tax_id: null,
		purchase_order_reference: null, currency: null, total_amount: null,
		confidence: 0, notes: "", language: detectLanguage(t) };
	if (!t.trim()) return out;

	out.document_no = findDocumentNo(t, orig);

	var due = labelledDate(t, DUE_LABELS, null);
	out.payment_due_date = due ? due.iso : null;
	var dd = labelledDate(t, DATE_LABELS, /(due|payment|delivery|ship|order|zahl|fallig|liefer|pay)\s*$/i);
	if (dd) out.document_date = dd.iso;
	else {
		var all = findDates(t).filter(function (d) { return !due || d.index !== due.at; });
		if (all.length) out.document_date = all[0].iso;
	}

	var sup = findSupplier(t, orig);
	var ownIssuer = false;
	if (sup) out.supplier_name = sup.name;
	else {
		// only our own company printed with a legal form: we issued it (a sales invoice)
		var own = companyCandidates(t, orig).filter(function (c) { return isOwnName(c.name); })[0];
		if (own && /seller|pardavejas|israse/i.test(t.slice(Math.max(0, own.at - 40), own.at))) { out.supplier_name = own.name; ownIssuer = true; }
	}
	var codes = findCodes(t);
	out.supplier_reg_number = sup ? nearest(codes.reg, sup.at) : firstForeignCode(codes.reg);
	out.supplier_tax_id = sup ? nearest(codes.vat, sup.at) : firstForeignCode(codes.vat);
	if (!out.supplier_reg_number && sup) out.supplier_reg_number = firstForeignCode(codes.reg);
	if (!out.supplier_tax_id && sup) out.supplier_tax_id = firstForeignCode(codes.vat);

	var pos = findPurchaseOrders(t);
	out.purchase_order_reference = pos.length ? pos.join(", ") : null;
	out.currency = findCurrency(t);
	out.total_amount = findTotal(t);
	out.doc_type = detectType(t, ownIssuer) || hint || null;

	var found = [out.document_no, out.document_date, out.supplier_name, out.total_amount].filter(function (v) { return v !== null; }).length;
	out.confidence = Math.round((0.2 + 0.15 * found) * 100) / 100;
	var notes = ["read by the built-in rules" + (out.language ? " (" + LANG_NAME[out.language] + ")" : "") +
		" — please check every field"];
	if (!out.supplier_name) notes.push("supplier not recognised");
	if (out.payment_due_date === null) notes.push("no payment due date found");
	out.notes = notes.join("; ");
	return out;
}

return {
	parse: parse, textQuality: textQuality, setOwn: setOwn, isOwnName: isOwnName, isOwnCode: isOwnCode,
	_internals: { fold: fold, parseAmount: parseAmount, findDates: findDates, detectType: detectType,
		detectLanguage: detectLanguage, findTotal: findTotal, findDocumentNo: findDocumentNo }
};
})();
