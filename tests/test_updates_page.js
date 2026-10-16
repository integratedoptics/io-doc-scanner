/* test_updates_page.js — the whole page (index.html + all scripts) with a fake Android shell and a fake update server:
   the update banner appears, the Settings card works, the address setting is saved.
       JSDOM_PATH=/tmp/jsd/node_modules/jsdom node tests/test_updates_page.js */
"use strict";
var fs = require("fs"), path = require("path");
var JSDOM;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; }
catch (e) { console.log("skipped: jsdom is not installed (set JSDOM_PATH)"); process.exit(0); }
var A = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
var raw = fs.readFileSync(A + "index.html", "utf8");
var scripts = (raw.match(/<script src="[^"]+"><\/script>/g) || []).map(function (t) { return /src="([^"]+)"/.exec(t)[1]; })
	.filter(function (n) { return !/xlsx|pdf\.min|pdfview/.test(n); });
var html = raw.replace(/<script[\s\S]*?<\/script>/g, "");
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function run(platform, manifest) {
	var dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
	var w = dom.window, store = {}, asked = [], installs = [];
	w.Android = {
		appVersion: function () { return "1.4"; }, platform: function () { return platform; },
		readData: function (n) { return store[n] || ""; }, writeData: function (n, c) { store[n] = c; return true; },
		toast: function () {}, readAsset: function () { return ""; },
		httpRequest: function (m, u, h, b, t, id) { asked.push(u); setTimeout(function () { w.onHttp(id, JSON.stringify({ status: 200, body: JSON.stringify(manifest) })); }, 1); },
		installUpdate: platform === "android" ? function (u, s, id) { installs.push([u, s]); } : undefined
	};
	w.setTimeout = function (f, ms) { return setTimeout(f, ms > 1000 ? 5 : ms); };   // the 4 s start-up delay
	scripts.forEach(function (n) { try { w.eval(fs.readFileSync(A + n, "utf8")); } catch (e) { console.log("script " + n + ": " + e.message); } });
	await wait(150);
	return { w: w, store: store, asked: asked, installs: installs, d: w.document };
}

(async function () {
	var man = { android: { version: "1.5", url: "io-doc-scanner-1.5.apk", sha256: "ab12" }, ios: { version: "1.5", message: "New build 1.5." } };
	var p = await run("android", man);
	var bar = p.d.getElementById("upd-banner");
	check("Android: the manifest was requested at start-up from the built-in address", p.asked[0] && p.asked[0].indexOf("http://192.168.1.79:3005/updates/io-doc-scanner/mobile.json") === 0, p.asked);
	check("Android: the banner is visible with Install", bar.style.display !== "none" && /Update 1\.5 is available/.test(bar.textContent) && !!bar.querySelector('[data-act="install"]'), bar.innerHTML);
	check("Android: the Settings card is visible", p.d.getElementById("upd-card").style.display === "");
	bar.querySelector('[data-act="install"]').click();
	check("Android: Install reaches the native bridge", p.installs.length === 1 && /io-doc-scanner-1\.5\.apk$/.test(p.installs[0][0]) && p.installs[0][1] === "ab12", p.installs);
	p.w.onUpdateState({ stage: "downloading", percent: 10 });
	check("Android: progress is shown in the banner", /10 %/.test(bar.textContent));
	p.w.onUpdateState(null);
	bar.querySelector('[data-act="later"]').click();
	check("Android: Later hides it and it is saved in the settings file", bar.style.display === "none" && JSON.parse(p.store["settings.json"]).update_dismissed === "1.5", p.store["settings.json"]);
	p.d.getElementById("s-upd-url").value = "http://10.0.0.5:3005/u/";
	p.d.getElementById("btn-upd-check").click();
	await wait(60);
	check("Android: Check for updates saves the address, asks that server and shows the banner again", p.asked[p.asked.length - 1].indexOf("http://10.0.0.5:3005/u/mobile.json") === 0 && bar.style.display !== "none" &&
		JSON.parse(p.store["settings.json"]).update_url === "http://10.0.0.5:3005/u/", p.asked);

	var q = await run("ios", man);
	var b2 = q.d.getElementById("upd-banner");
	check("iOS: banner with the message, no Install button", b2.style.display !== "none" && /New build 1\.5/.test(b2.textContent) && !b2.querySelector('[data-act="install"]'), b2.innerHTML);

	var r = await run("", man);
	check("Desktop: no request, no banner, no card", r.asked.length === 0 && r.d.getElementById("upd-banner").style.display === "none" && r.d.getElementById("upd-card").style.display === "none");

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log("CRASH", e && e.stack || e); process.exit(1); });
