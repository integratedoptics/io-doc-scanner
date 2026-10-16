/* test_desktop_v16.js — 1.6.0: the collapsible left menu, the Shipment tracking box (desktop), drag-to-pan in the viewer.
       JSDOM_PATH=/tmp/jsd/node_modules/jsdom node tests/test_desktop_v16.js */
"use strict";
var fs = require("fs"), path = require("path");
var JSDOM;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; }
catch (e) { console.log("skipped: jsdom is not installed (set JSDOM_PATH)"); process.exit(0); }
var A = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var raw = fs.readFileSync(A + "index.html", "utf8");
var scripts = (raw.match(/<script src="[^"]+"><\/script>/g) || []).map(function (t) { return /src="([^"]+)"/.exec(t)[1]; })
	.filter(function (n) { return !/xlsx|pdf\.min|pdfview/.test(n); });
var html = raw.replace(/<script src[\s\S]*?<\/script>/g, "");   // keeps the inline script that sets the desktop class
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x === undefined ? "" : (typeof x === "string" ? x : JSON.stringify(x))))); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function load(platform, settings) {
	var store = { "settings.json": JSON.stringify(settings || {}) };
	var dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, beforeParse: function (w) {
		w.Android = { platform: function () { return platform; }, appVersion: function () { return "1.6.0"; },
			readData: function (n) { return store[n] || ""; }, writeData: function (n, c) { store[n] = c; return true; }, toast: function () {}, readAsset: function () { return ""; } };
		w.setTimeout = function (f, ms) { return setTimeout(f, ms > 1000 ? 5 : ms); };
	} });
	var w = dom.window;
	scripts.forEach(function (n) { try { w.eval(fs.readFileSync(A + n, "utf8")); } catch (e) { console.log("script " + n + ": " + e.message); } });
	await wait(120);
	return { w: w, d: w.document, store: store, $: function (id) { return w.document.getElementById(id); } };
}
function saved(p) { return JSON.parse(p.store["settings.json"] || "{}"); }

(async function () {
	/* ---- 1. the left menu */
	var p = await load("desktop", {});
	var html$ = p.d.documentElement;
	check("menu: starts open, the arrow says Collapse", !html$.classList.contains("navcol") && /Collapse/.test(p.$("nav-toggle").title) && p.$("nav-toggle").getAttribute("aria-expanded") === "true");
	p.$("nav-toggle").click();
	check("menu: the arrow folds it (class navcol) and says Expand", html$.classList.contains("navcol") && /Expand/.test(p.$("nav-toggle").title) && p.$("nav-toggle").getAttribute("aria-expanded") === "false");
	check("menu: the choice is saved in the settings", saved(p).nav_collapsed === true, p.store["settings.json"]);
	p.d.querySelector('nav button[data-v="docs"]').click();
	check("menu: the buttons still switch screens while folded", p.$("v-docs").classList.contains("on") && p.d.querySelector('nav button[data-v="docs"]').classList.contains("on") && p.$("ttl").textContent === "Documents");
	check("menu: the arrow itself is not a screen button", !p.$("nav-toggle").classList.contains("on") && p.$("nav-toggle").dataset.v === undefined);
	check("menu: every button has a tooltip for the folded state", Array.prototype.every.call(p.d.querySelectorAll("nav button[data-v]"), function (b) { return !!b.title; }));
	p.$("nav-toggle").click();
	check("menu: a second click opens it again and saves that", !html$.classList.contains("navcol") && saved(p).nav_collapsed === false);
	var p2 = await load("desktop", { nav_collapsed: true });
	check("menu: a folded menu comes back folded on the next start", p2.d.documentElement.classList.contains("navcol") && /Expand/.test(p2.$("nav-toggle").title));
	var ph = await load("android", {});
	ph.d.querySelector('nav button[data-v="cards"]').click();
	check("phone: the bottom bar works as before and the arrow is not active (no desktop class)", ph.$("v-cards").classList.contains("on") && !ph.d.documentElement.classList.contains("desktop"));

	/* ---- 2. the Shipment tracking box */
	var d = await load("desktop", { erp_test_url: "https://test.example.com" });
	check("tracking box (desktop): the tracking field and the Purchase Order finder moved into it", d.$("d-box-track").parentNode.id === "d-awb-zone" && d.$("d-box-awb").parentNode.id === "d-awb-zone");
	check("tracking box: hidden until a document needs it", d.$("d-awb-zone").style.display === "none");
	d.w.CS_NEWUI.update("purchase_invoice", "", true);
	check("tracking box: an invoice shows it with the tracking field, without the finder", d.$("d-awb-zone").style.display === "" && d.$("d-box-track").style.display === "" && d.$("d-box-awb").style.display === "none" && /tracking \/ AWB field/.test(d.$("d-awb-hint").textContent), d.$("d-awb-hint").textContent);
	check("tracking box: the test-server box keeps its own text", /draft Purchase Invoice/.test(d.$("d-new-hint").textContent));
	d.w.CS_NEWUI.update("attachment", "waybill", true);
	check("tracking box: a waybill shows the field and the Purchase Order finder", d.$("d-awb-zone").style.display === "" && d.$("d-box-track").style.display === "" && d.$("d-box-awb").style.display === "");
	check("tracking box: the waybill text moved out of the test-server box into the tracking box", /Purchase Receipt is made from the Purchase Order/.test(d.$("d-awb-hint").textContent) && d.$("d-new-hint").textContent === "", [d.$("d-awb-hint").textContent, d.$("d-new-hint").textContent]);
	d.w.CS_NEWUI.update("supplier_quotation", "", true);
	check("tracking box: a quotation has no tracking number, so the box is hidden", d.$("d-awb-zone").style.display === "none");
	d.w.CS_NEWUI.update("purchase_invoice", "", true);
	d.$("d-tracking_number").value = "1Z 9353";
	check("tracking box: the field is still the one the sender reads", d.w.CS_NEWUI && d.$("d-tracking_number").value === "1Z 9353");

	var m = await load("android", { erp_test_url: "https://test.example.com" });
	check("phone: the tracking field stays inside the test-server box, the extra box stays empty and hidden",
		m.$("d-box-track").parentNode.id === "d-new" && m.$("d-awb-zone").children.length === 2 && m.$("d-awb-zone").style.display === "none");
	m.w.CS_NEWUI.update("purchase_invoice", "", true);
	check("phone: after an invoice the extra box is still hidden and the field shows in the old place", m.$("d-awb-zone").style.display === "none" && m.$("d-box-track").style.display === "" && m.$("d-box-track").parentNode.id === "d-new");

	/* ---- 3. drag to pan */
	var v = await load("desktop", {});
	var pg = v.$("dv-pages");
	function dim(o) { Object.keys(o).forEach(function (k) { Object.defineProperty(pg, k, { value: o[k], configurable: true, writable: true }); }); }
	function mouse(type, x, y, target, btn) { (target || pg).dispatchEvent(new v.w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: btn || 0 })); }
	dim({ scrollWidth: 900, clientWidth: 400, scrollHeight: 1200, clientHeight: 500, scrollLeft: 100, scrollTop: 50 });
	mouse("mouseenter", 0, 0);
	check("pan: the pointer becomes a hand when the document is larger than the viewer", pg.classList.contains("dv-pan"));
	mouse("mousedown", 200, 200);
	check("pan: pressing the left button starts a drag (grabbing hand)", pg.classList.contains("dv-grab"));
	mouse("mousemove", 150, 170, v.w.document.body);
	check("pan: moving the mouse scrolls the document the other way", pg.scrollLeft === 150 && pg.scrollTop === 80, [pg.scrollLeft, pg.scrollTop]);
	mouse("mouseup", 150, 170, v.w.document.body);
	mouse("mousemove", 0, 0, v.w.document.body);
	check("pan: releasing ends it, later movement does nothing", !pg.classList.contains("dv-grab") && pg.scrollLeft === 150 && pg.scrollTop === 80);
	mouse("mousedown", 200, 200, pg, 2);
	check("pan: another mouse button does not start a drag", !pg.classList.contains("dv-grab"));
	dim({ scrollWidth: 400, clientWidth: 400, scrollHeight: 500, clientHeight: 500 });
	mouse("mouseenter", 0, 0);
	mouse("mousedown", 10, 10);
	check("pan: nothing to drag when the document fits", !pg.classList.contains("dv-pan") && !pg.classList.contains("dv-grab"));
	var ev = new v.w.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
	dim({ scrollWidth: 900 });
	pg.dispatchEvent(ev);
	check("pan: the press is cancelled so no text is selected or picture dragged", ev.defaultPrevented);

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log("CRASH", e && e.stack || e); process.exit(1); });
