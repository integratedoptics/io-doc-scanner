/* test_zohomail_ui.js — 1.7.0: "From email (Zoho Mail)" panel and its Settings card, with a fake window.CS_ZOHO bridge.
       JSDOM_PATH=/tmp/jsd/node_modules/jsdom node tests/test_zohomail_ui.js */
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

var MAILS = [
	{ messageId: "1", folderId: "10", subject: "Invoice IO-114", sender: "Acme Billing", fromAddress: "billing@acme.com", received: Date.now() - 3600e3, level: "trusted",
		reasons: [{ level: "good", text: "On your trusted list (acme.com)." }], auth: { spf: "pass", dkim: "pass", dmarc: "pass", server: "mx.zohomail.eu" },
		attachments: [{ attachmentId: "a1", name: "IO-114.pdf", size: 52000, kind: "pdf" }], hiddenAttachments: 1 },
	{ messageId: "2", folderId: "10", subject: "Quote", sender: "New Vendor", fromAddress: "sales@newvendor.eu", received: Date.now() - 86400e3, level: "check",
		reasons: [{ level: "warn", text: "Not on your trusted list." }], auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
		attachments: [{ attachmentId: "b1", name: "quote.pdf", size: 4000, kind: "pdf" }], hiddenAttachments: 0 },
	{ messageId: "3", folderId: "10", subject: "Payment <urgent>", sender: "Acme Billing", fromAddress: "billing@acme.com", received: Date.now() - 2 * 86400e3, level: "risky",
		reasons: [{ level: "bad", text: "The receiving server could not confirm that this mail really comes from acme.com." }], auth: { spf: "fail", dkim: "none", dmarc: "fail" },
		attachments: [{ attachmentId: "c1", name: "invoice.pdf", size: 4000, kind: "pdf" }], hiddenAttachments: 0 }
];

async function load(platform, settings, bridge) {
	var store = { "settings.json": JSON.stringify(settings || {}) };
	var dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, beforeParse: function (w) {
		w.Android = { platform: function () { return platform; }, appVersion: function () { return "1.7.0"; },
			readData: function (n) { return store[n] || ""; }, writeData: function (n, c) { store[n] = c; return true; }, toast: function () {}, readAsset: function () { return ""; } };
		if (bridge) w.CS_ZOHO = bridge;
		w.setTimeout = function (f, ms) { return setTimeout(f, ms > 1000 ? 5 : ms); };
	} });
	var w = dom.window;
	scripts.forEach(function (n) { try { w.eval(fs.readFileSync(A + n, "utf8")); } catch (e) { console.log("script " + n + ": " + e.message); } });
	await wait(150);
	return { w: w, d: w.document, store: store, $: function (id) { return w.document.getElementById(id); } };
}
function saved(p) { return JSON.parse(p.store["settings.json"] || "{}"); }

function bridge(o) {
	o = o || {};
	var b = { calls: [], connected: o.connected !== false };
	b.status = function () { b.calls.push(["status"]); return Promise.resolve({ ok: true, result: { connected: b.connected, region: "eu", email: b.connected ? "evaldas@integratedoptics.com" : "",
		regions: [{ id: "eu", label: "Europe (zoho.eu)" }, { id: "com", label: "United States (zoho.com)" }], scopes: "ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.folders.READ" } }); };
	b.connect = function (p) { b.calls.push(["connect", p]); if (p.code === "BAD") return Promise.resolve({ ok: false, error: "Zoho refused the sign-in (invalid_code). The code is wrong." });
		b.connected = true; return Promise.resolve({ ok: true, result: { connected: true, region: p.region, email: "evaldas@integratedoptics.com" } }); };
	b.disconnect = function () { b.calls.push(["disconnect"]); b.connected = false; return Promise.resolve({ ok: true, result: { connected: false } }); };
	b.list = function (p) { b.calls.push(["list", p]); return Promise.resolve({ ok: true, result: { mails: MAILS, hiddenMails: 2, blockedFiles: 3, failed: 0, account: "evaldas@integratedoptics.com", days: p.days } }); };
	b.fetch = function (p) { b.calls.push(["fetch", p]);
		if (o.failFetch) return Promise.resolve({ ok: false, error: "Refused: Named like a PDF, but the content is a windows program (.exe/.dll). It was not opened." });
		return Promise.resolve({ ok: true, result: { name: p.name, mime: "application/pdf", size: 4, dataUrl: "data:application/pdf;base64,JVBERg==", level: "check", warnings: [], from: "x@y" } }); };
	return b;
}

(async function () {
	/* ---- not the desktop app: nothing appears */
	var ph = await load("android", {}, null);
	check("phone/browser: no 'From email' button and no Zoho settings card", ph.$("btn-doc-email").style.display === "none" && ph.$("card-zoho").style.display === "none");

	/* ---- desktop, connected */
	var b = bridge();
	var p = await load("desktop", { zoho_trusted: "acme.com" }, b);
	check("desktop: the button and the settings card appear", p.$("btn-doc-email").style.display === "" && p.$("card-zoho").style.display === "");
	check("settings: connected state shown, setup form hidden", /Connected as/.test(p.$("zoho-state").textContent) && p.$("zoho-setup").style.display === "none" && p.$("zoho-connected").style.display === "");
	check("settings: region list comes from the app", p.$("s-zoho-region").options.length === 2 && p.$("s-zoho-region").value === "eu");
	check("settings: trusted senders are shown", p.$("s-zoho-trusted").value === "acme.com");
	p.$("s-zoho-trusted").value = "acme.com\nnewvendor.eu"; p.$("s-zoho-trusted").dispatchEvent(new p.w.Event("change"));
	check("settings: editing the trusted list is saved", saved(p).zoho_trusted === "acme.com\nnewvendor.eu", saved(p));

	p.$("btn-doc-email").click(); await wait(60);
	var panel = p.$("zm-panel");
	check("panel: opens", panel && panel.style.display === "flex");
	check("panel: asked for the last 14 days and sent the trusted list to the main process", b.calls.some(function (c) { return c[0] === "list" && c[1].days === 14 && /acme\.com/.test(c[1].trusted); }), b.calls);
	var mails = panel.querySelectorAll(".zm-mail");
	check("panel: one card per mail with the right colour", mails.length === 3 && mails[0].classList.contains("green") && mails[1].classList.contains("orange") && mails[2].classList.contains("red"));
	check("panel: verdict words", /Trusted sender/.test(mails[0].textContent) && /Check the sender/.test(mails[1].textContent) && /Risky/.test(mails[2].textContent));
	check("panel: risky reasons are listed", /could not confirm/.test(mails[2].textContent));
	check("panel: mail text is escaped (no injected markup)", mails[2].querySelector(".zm-subj").textContent === "Payment <urgent>" && !mails[2].querySelector(".zm-subj b, .zm-subj u, .zm-subj urgent"));
	check("panel: the hidden dangerous files are reported", /3 attachments of a dangerous type/.test(panel.textContent));
	check("panel: sender checks are available as details", /SPF fail/.test(mails[2].querySelector(".zm-tech").textContent));

	/* trusted: one click opens */
	var picked = null;
	p.w.onDocPicked = function (r) { picked = r; };
	mails[0].querySelector(".zm-open").click(); await wait(60);
	var f = b.calls.filter(function (c) { return c[0] === "fetch"; });
	check("trusted: one click fetches with no acknowledgement", f.length === 1 && f[0][1].ack === "" && f[0][1].messageId === "1" && f[0][1].attachmentId === "a1", f);
	check("trusted: the file goes to the Documents flow and the panel closes", picked && picked.ok && picked.name === "IO-114.pdf" && /^data:application\/pdf/.test(picked.dataUrl) && panel.style.display === "none", picked);

	/* unknown sender: a confirm click */
	p.$("btn-doc-email").click(); await wait(60);
	mails = p.$("zm-panel").querySelectorAll(".zm-mail");
	var calls0 = b.calls.filter(function (c) { return c[0] === "fetch"; }).length;
	mails[1].querySelector(".zm-open").click(); await wait(30);
	check("check: the first click only asks, nothing is fetched", b.calls.filter(function (c) { return c[0] === "fetch"; }).length === calls0 && mails[1].querySelector(".zm-confirm").style.display === "");
	check("check: offers to trust the domain and no tick box", !!mails[1].querySelector(".zm-trust") && !mails[1].querySelector(".zm-ok") && !mails[1].querySelector(".zm-go").disabled);
	mails[1].querySelector(".zm-go").click(); await wait(60);
	var f2 = b.calls.filter(function (c) { return c[0] === "fetch"; }).pop();
	check("check: confirming sends ack=check", f2[1].ack === "check" && f2[1].messageId === "2");

	/* risky: tick box required, no trust button */
	p.$("btn-doc-email").click(); await wait(60);
	mails = p.$("zm-panel").querySelectorAll(".zm-mail");
	var n1 = b.calls.filter(function (c) { return c[0] === "fetch"; }).length;
	mails[2].querySelector(".zm-open").click(); await wait(30);
	var go = mails[2].querySelector(".zm-go"), tick = mails[2].querySelector(".zm-ok");
	check("risky: the confirm button is disabled until the tick box is ticked; no 'always trust' offer", go.disabled === true && !!tick && !mails[2].querySelector(".zm-trust"));
	go.click(); await wait(30);
	check("risky: a disabled button fetches nothing", b.calls.filter(function (c) { return c[0] === "fetch"; }).length === n1);
	tick.checked = true; tick.dispatchEvent(new p.w.Event("change"));
	check("risky: ticking enables it", go.disabled === false);
	go.click(); await wait(60);
	var f3 = b.calls.filter(function (c) { return c[0] === "fetch"; }).pop();
	check("risky: confirming sends ack=risky", f3[1].ack === "risky" && f3[1].messageId === "3");

	/* trust a domain from the panel */
	p.$("btn-doc-email").click(); await wait(60);
	mails = p.$("zm-panel").querySelectorAll(".zm-mail");
	mails[1].querySelector(".zm-open").click(); await wait(30);
	mails[1].querySelector(".zm-trust").click(); await wait(80);
	check("trust: the domain is added to the saved list and the list reloaded", /newvendor\.eu/.test(saved(p).zoho_trusted) && /acme\.com/.test(saved(p).zoho_trusted), saved(p).zoho_trusted);

	/* refused by the main process: the reason is shown, nothing opened */
	var b2 = bridge({ failFetch: true });
	var q = await load("desktop", { zoho_trusted: "acme.com" }, b2);
	var pickedQ = null; q.w.onDocPicked = function (r) { pickedQ = r; };
	q.$("btn-doc-email").click(); await wait(60);
	q.$("zm-panel").querySelectorAll(".zm-mail")[1].querySelector(".zm-open").click(); await wait(30);
	q.$("zm-panel").querySelectorAll(".zm-mail")[1].querySelector(".zm-go").click(); await wait(60);
	check("refused: the reason is shown in the panel, the panel stays open, nothing reaches the Documents form",
		/windows program/.test(q.$("zm-panel").textContent) && q.$("zm-panel").style.display === "flex" && pickedQ === null);

	/* not connected */
	var b3 = bridge({ connected: false });
	var n = await load("desktop", {}, b3);
	check("not connected: settings show the form", n.$("zoho-setup").style.display === "" && n.$("zoho-connected").style.display === "none" && /Not connected/.test(n.$("zoho-state").textContent));
	n.$("btn-doc-email").click(); await wait(60);
	check("not connected: the panel points to Settings and lists nothing", /not connected yet/.test(n.$("zm-panel").textContent) && !b3.calls.some(function (c) { return c[0] === "list"; }));
	n.$("zm-go").click(); await wait(20);
	check("not connected: the button goes to the Settings screen", n.$("v-set").classList.contains("on"));
	n.$("s-zoho-id").value = "ID"; n.$("s-zoho-secret").value = "SECRET"; n.$("s-zoho-code").value = "BAD";
	n.$("btn-zoho-connect").click(); await wait(60);
	check("connect: a refused code shows the reason and keeps the form", /invalid_code/.test(n.$("zoho-state").textContent) && n.$("zoho-setup").style.display === "");
	n.$("s-zoho-code").value = "GOOD"; n.$("btn-zoho-connect").click(); await wait(60);
	check("connect: success hides the form, clears the secret fields, and never writes them to the saved settings",
		n.$("zoho-setup").style.display === "none" && n.$("s-zoho-secret").value === "" && n.$("s-zoho-code").value === "" && !/SECRET|GOOD|"ID"/.test(n.store["settings.json"]), n.store["settings.json"]);
	n.$("btn-zoho-disconnect").click(); await wait(60);
	check("disconnect: back to the form", n.$("zoho-setup").style.display === "" && /Not connected/.test(n.$("zoho-state").textContent));

	console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
	process.exit(fails ? 1 : 0);
})();
