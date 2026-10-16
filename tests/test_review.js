/* test_review.js — the Review box and the document viewer on the Documents screen: the list of checks follows the
   document type, ticks and status, the text sent to ERPNext, the entry in the upload history, the desktop / phone
   behaviour of the viewer, and that the desktop layout class is only set by the desktop shell.
       JSDOM_PATH=/tmp/jsd/node_modules/jsdom node tests/test_review.js */
"use strict";
var fs = require("fs"), path = require("path");
var JSDOM;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; }
catch (e) { console.log("skipped: jsdom is not installed (set JSDOM_PATH)"); process.exit(0); }
var A = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var raw = fs.readFileSync(A + "index.html", "utf8");
var html = raw.replace(/<script src[\s\S]*?<\/script>/g, "");   // keep the inline desktop-class script
var src = {};
["docrules", "docview", "review", "history", "newui", "docscan"].forEach(function (n) { src[n] = fs.readFileSync(A + n + ".js", "utf8"); });
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x === undefined ? "" : (typeof x === "string" ? x : JSON.stringify(x))))); }
function tick() { return new Promise(function (r) { setTimeout(r, 12); }); }
async function settle() { for (var i = 0; i < 8; i++) await tick(); }
var PDF = "data:application/pdf;base64,QUJD";

function page(platform) {
	var dom = new JSDOM(html, { runScripts: "dangerously", beforeParse: function (w) {
		w.Android = { platform: function () { return platform; }, appVersion: function () { return "1.5.0"; }, readData: function () { return ""; }, writeData: function () { return true; } };
	} });
	var w = dom.window, drawn = [], saved = 0, S = { reviewer: "Evaldas" };
	w.CS = { settings: function () { return S; } };
	w.CS_PDF = { extractText: function () { return Promise.resolve({ text: "", pages: 1 }); }, openDoc: function () { drawn.push("open"); return Promise.reject(new Error("no canvas in the test")); } };
	w.CS_EXTRACT = { ready: function () { return "no key"; }, extractFields: function () { return Promise.reject(new Error("no ai")); }, extractFromFile: function () { return Promise.reject(new Error("no ai")); } };
	w.CS_ACC = { findExactSupplier: function () { return Promise.resolve(null); }, findSupplierMatches: function () { return Promise.resolve([]); }, suggestParents: function () { return Promise.resolve([]); },
		checkReferences: function () { return Promise.resolve({ po: {}, si: {} }); }, _internals: { normPo: function (v) { return String(v || ""); } } };
	w.CS_ERP = { ready: function () { return ""; } };
	w.CS_ERP_TEST_ENABLED = function (s) { return !!(s && s.erp_test_url); };
	["docrules", "docview", "review", "history", "newui", "docscan"].forEach(function (n) { w.eval(src[n]); });
	w.CS_DOCSCAN.init();
	w.CS_REVIEW.init({ settings: function () { return S; }, save: function () { saved++; } });
	return { w: w, d: w.document, S: S, saved: function () { return saved; }, drawn: drawn,
		$: function (id) { return w.document.getElementById(id); },
		tick: function (key, on) { var el = w.document.querySelector('#rv-checks input[data-k="' + key + '"]'); el.checked = on !== false; el.dispatchEvent(new w.Event("change", { bubbles: true })); },
		labels: function () { return Array.prototype.map.call(w.document.querySelectorAll("#rv-checks span"), function (s) { return s.textContent; }); } };
}

(async function () {
	/* desktop class only from the desktop shell */
	check("desktop shell: html gets the desktop class", page("desktop").d.documentElement.className.indexOf("desktop") >= 0);
	check("Android / iOS / plain browser: no desktop class", ["android", "ios", ""].every(function (p) { return page(p).d.documentElement.className.indexOf("desktop") < 0; }));

	var p = page("android");
	p.w.onDocPicked({ ok: true, name: "inv.pdf", dataUrl: PDF });
	await settle();
	check("a loaded document opens the viewer card (closed on a phone) and the form", p.$("d-viewcard").style.display === "" && p.$("d-viewcard").open === false && p.$("box-doc-form").style.display === "");
	check("phone: nothing is drawn until the viewer is opened", p.drawn.length === 0);
	p.$("d-viewcard").open = true; p.$("d-viewcard").dispatchEvent(new p.w.Event("toggle"));
	await settle();
	check("phone: opening it draws the document", p.drawn.length === 1);
	check("a drawing problem is shown instead of failing silently", /could not be shown/.test(p.$("dv-pages").textContent), p.$("dv-pages").textContent);

	/* the checks follow the document type */
	var L = p.labels();
	check("purchase invoice: ten possible checks reduce to what is on screen (no lines/charges/AWB without the test server panel)", L.join("|") === "The right document: type and file|Document number|Document date|Supplier|Purchase order / sales invoice reference|Currency and total", L.join("|"));
	p.$("d-type").value = "sales_invoice"; p.$("d-type").dispatchEvent(new p.w.Event("change"));
	check("sales invoice: the party is the Customer, the reference is the sales invoice", p.labels().indexOf("Customer") > 0 && p.labels().indexOf("Supplier") < 0);
	p.$("d-type").value = "customs_declaration"; p.$("d-type").dispatchEvent(new p.w.Event("change"));
	await settle();
	check("customs declaration: the parent record is checked too, no PO reference", p.labels().indexOf("Record it is filed under") > 0 && p.labels().indexOf("Purchase order / sales invoice reference") < 0, p.labels());
	p.$("d-type").value = "purchase_invoice"; p.$("d-type").dispatchEvent(new p.w.Event("change"));

	/* untouched: nothing recorded */
	check("nothing touched: no review text and no record", p.w.CS_REVIEW.text() === "" && p.w.CS_REVIEW.value() === null);

	/* ticking */
	p.tick("no"); p.tick("date");
	check("two ticks: summary", p.$("rv-sum").textContent === "2 of 6 checked", p.$("rv-sum").textContent);
	check("two ticks: the status stays 'not reviewed'", p.$("rv-status").value === "pending");
	var t = p.w.CS_REVIEW.text();
	check("the remark names the status, the count, what is missing, the reviewer and the time", /^Manual review: Not reviewed — 2 of 6 values checked \(not checked: .*Supplier.*\)\. Reviewed by Evaldas, \d{4}-\d\d-\d\d \d\d:\d\d\.$/.test(t), t);
	p.$("rv-all").click();
	check("'Mark everything' ticks all and the status becomes OK on its own", p.$("rv-sum").textContent === "6 of 6 checked" && p.$("rv-status").value === "ok" && p.$("rv-all").textContent === "Clear all ticks");
	p.tick("amount", false);
	check("removing a tick takes the automatic OK back", p.$("rv-status").value === "pending");
	p.tick("amount");
	p.$("rv-status").value = "fixed"; p.$("rv-status").dispatchEvent(new p.w.Event("change"));
	p.tick("party", false); p.tick("party");
	check("a status chosen by the employee is not overridden", p.$("rv-status").value === "fixed");
	p.$("rv-note").value = "Date was 15.09, fixed"; p.$("rv-note").dispatchEvent(new p.w.Event("input"));
	t = p.w.CS_REVIEW.text();
	check("note goes into the remark on its own line", /\nNote: Date was 15\.09, fixed$/.test(t) && /Checked — corrected by me — 6 of 6/.test(t), t);
	p.$("rv-status").value = "problem"; p.$("rv-status").dispatchEvent(new p.w.Event("change"));
	check("a problem is called out in the summary", /marked as a problem/.test(p.$("rv-sum").textContent));

	/* reviewer's name is remembered */
	check("the reviewer's name comes from the settings", p.$("rv-by").value === "Evaldas");
	p.$("rv-by").value = "Jonas"; p.$("rv-by").dispatchEvent(new p.w.Event("change"));
	check("a changed name is saved to the settings", p.S.reviewer === "Jonas" && p.saved() === 1);

	/* the history shows it */
	var v = p.w.CS_REVIEW.value();
	p.w.CS_HISTORY.record({ type: "Purchase Invoice", docNo: "INV-1", results: [{ server: "Live", ok: true, name: "ACC-1" }], review: v });
	var hist = p.$("d-hist").textContent;
	check("upload history lists the review with its status, count, name and note", /Review: Problem — needs attention — 6 of 6 checked by Jonas/.test(hist) && /Date was 15\.09, fixed/.test(hist), hist);

	/* a new document starts with a clean review */
	p.$("btn-doc-cancel").click();
	check("Discard clears the ticks, the status and the note", p.w.CS_REVIEW.value() === null && p.$("rv-note").value === "");
	check("Discard hides the viewer card", p.$("d-viewcard").style.display === "none");

	/* desktop: the viewer is open at once and drawn without being opened */
	var q = page("desktop");
	q.w.onDocPicked({ ok: true, name: "inv.pdf", dataUrl: PDF });
	await settle();
	check("desktop: the viewer is open and drawing at once", q.$("d-viewcard").open === true && q.drawn.length === 1);
	q.w.onDocPicked({ ok: true, name: "scan.jpg", dataUrl: "data:image/jpeg;base64,QUJD" });
	await settle();
	check("a picture is shown as an image, zoomable", !!q.$("dv-pages").querySelector("img") && q.$("dv-info").textContent === "picture");
	q.$("dv-in").click();
	check("zoom in widens it", q.$("dv-zoom").textContent === "125 %" && /px/.test(q.$("dv-pages").querySelector("img").style.width));
	q.$("dv-fit").click();
	check("fit width returns to 100 %", q.$("dv-zoom").textContent === "100 %");

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log("CRASH", e && e.stack || e); process.exit(1); });
