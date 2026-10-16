/* test_updates.js — updates.js: the "newer version available" check of the phone apps (Android installs, iOS only tells),
   with a fake native bridge and a fake update server. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var src = fs.readFileSync(path.join(__dirname, "../android/CardScanner/app/src/main/assets/updates.js"), "utf8");
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x === undefined ? "" : JSON.stringify(x)))); }

function el() { return { style: {}, innerHTML: "", textContent: "", value: "", disabled: false, onclick: null }; }

/* a fresh page: opts.platform "android" | "ios" | "" ; opts.installed ; server: { status, body } or a function */
function page(opts) {
	var els = { "upd-banner": el(), "upd-card": el(), "btn-upd-check": el(), "d-upd-status": el(), "s-upd-url": el() };
	var requests = [], installs = [], toasts = [], timers = [];
	var settings = { update_url: opts.url || "", update_dismissed: "" }, saves = 0;
	var A = { appVersion: function () { return opts.installed || "1.4"; } };
	if (opts.platform) A.platform = function () { return opts.platform; };
	if (opts.platform === "android") A.installUpdate = function (u, h, id) { installs.push({ url: u, sha: h, id: id }); };
	var win = { Android: A, CS_NET: { request: function (m, u) {
		requests.push({ m: m, u: u });
		var s = typeof opts.server === "function" ? opts.server(u) : opts.server;
		return s.reject ? Promise.reject(new Error(s.reject)) : Promise.resolve(s);
	} } };
	var sb = { window: win, document: { getElementById: function (id) { return els[id] || null; }, addEventListener: function () {}, visibilityState: "visible" },
		setTimeout: function (f) { timers.push(f); return 1; }, setInterval: function () { return 2; }, clearTimeout: function () {}, Date: Date, Promise: Promise, console: console };
	vm.createContext(sb);
	vm.runInContext(src, sb);
	var U = win.CS_UPDATES;
	return { U: U, els: els, requests: requests, installs: installs, toasts: toasts, timers: timers, settings: settings, win: win,
		saves: function () { return saves; },
		init: function () { U.init({ settings: function () { return settings; }, save: function () { saves++; }, toast: function (m, k) { toasts.push(m + "|" + (k || "")); } }); },
		click: function (act) { els["upd-banner"].onclick({ target: { getAttribute: function () { return act; } } }); } };
}
var json = function (o) { return { status: 200, body: JSON.stringify(o) }; };

(async function () {
	var P = page({ platform: "android", server: json({}) }), U = P.U;

	/* versions */
	check("parse: 1.4 / 1.4-desktop / v1.10.2", JSON.stringify(U.parseVersion("1.4")) === "[1,4]" && JSON.stringify(U.parseVersion("1.4-desktop")) === "[1,4]" && JSON.stringify(U.parseVersion("v1.10.2")) === "[1,10,2]");
	check("1.10 is newer than 1.9 (numbers, not text)", U.isNewer("1.10", "1.9") && !U.isNewer("1.9", "1.10"));
	check("1.4.0 equals 1.4; same version is not newer", U.compare("1.4.0", "1.4") === 0 && !U.isNewer("1.4", "1.4"));
	check("garbage never counts as newer", !U.isNewer("abc", "1.4") && !U.isNewer("1.5", "") && !U.isNewer("", "1.4"));

	/* addresses */
	check("https anywhere, http only on local addresses", U.addressOk("https://example.com/a") && U.addressOk("http://192.168.1.79:3005/updates/") &&
		U.addressOk("http://10.1.2.3/x") && U.addressOk("http://172.16.0.1/x") && U.addressOk("http://localhost:3005/x") &&
		!U.addressOk("http://example.com/a") && !U.addressOk("http://172.32.0.1/x") && !U.addressOk("ftp://192.168.1.1/x") && !U.addressOk("192.168.1.1"));
	check("default manifest address", U.manifestUrl() === "http://192.168.1.79:3005/updates/io-doc-scanner/mobile.json", U.manifestUrl());
	check("files are resolved against the server folder and spaces encoded", U.resolve("IO Scanner 1.5.apk") === "http://192.168.1.79:3005/updates/io-doc-scanner/IO%20Scanner%201.5.apk" && U.resolve("https://x.org/a.apk") === "https://x.org/a.apk", U.resolve("IO Scanner 1.5.apk"));

	/* Android: newer version found */
	P = page({ platform: "android", server: json({ android: { version: "1.5", url: "io-doc-scanner-1.5.apk", sha256: "ABCDEF" }, ios: { version: "1.6" } }) });
	P.init();
	check("the update card is shown on Android", P.els["upd-card"].style.display === "");
	var r = await P.U.check(false);
	check("1.5 > installed 1.4: available, file and lower-cased checksum from the manifest", r.state === "available" && r.info.url === "http://192.168.1.79:3005/updates/io-doc-scanner/io-doc-scanner-1.5.apk" && r.info.sha256 === "abcdef", r);
	check("the manifest was fetched with GET from the default address", P.requests[0].m === "GET" && /\/mobile\.json\?t=\d+$/.test(P.requests[0].u), P.requests);
	check("banner shows Update 1.5 with Install and Later", P.els["upd-banner"].style.display === "" && /Update 1\.5 is available/.test(P.els["upd-banner"].innerHTML) && /data-act="install"/.test(P.els["upd-banner"].innerHTML) && /data-act="later"/.test(P.els["upd-banner"].innerHTML));
	check("settings status line says so", /1\.5 is available/.test(P.els["d-upd-status"].textContent));

	/* install flow */
	P.click("install");
	check("Install calls the native installer with the file and checksum", P.installs.length === 1 && P.installs[0].url.indexOf("io-doc-scanner-1.5.apk") > 0 && P.installs[0].sha === "abcdef", P.installs);
	check("banner shows the download", /Downloading version 1\.5/.test(P.els["upd-banner"].innerHTML));
	P.win.onUpdateState({ stage: "downloading", percent: 42 });
	check("progress is shown", /42 %/.test(P.els["upd-banner"].innerHTML));
	P.win.onUpdateState(JSON.stringify({ stage: "permission" }));
	check("permission stage tells the user what to do and offers Install again", /install apps/.test(P.els["upd-banner"].innerHTML) && /data-act="install"/.test(P.els["upd-banner"].innerHTML));
	P.win.onUpdateState({ stage: "installing" });
	check("installing stage asks for the confirmation in the Android window", /confirm the installation/.test(P.els["upd-banner"].innerHTML));
	P.win.onUpdateState({ stage: "error", message: "The downloaded file does not match the checksum" });
	check("a native error is shown with the Install button kept", /does not match the checksum/.test(P.els["upd-banner"].innerHTML) && /data-act="install"/.test(P.els["upd-banner"].innerHTML));

	/* Later hides it for this version, a newer version brings it back, a manual check shows it again */
	P.win.onUpdateState(null);
	P.click("later");
	check("Later hides the banner and remembers the version", P.els["upd-banner"].style.display === "none" && P.settings.update_dismissed === "1.5" && P.saves() === 1);
	await P.U.check(false);
	check("an automatic check does not bring the dismissed version back", P.els["upd-banner"].style.display === "none");
	await P.U.check(true);
	check("a manual check shows it again", P.els["upd-banner"].style.display === "" && P.settings.update_dismissed === "");
	P.settings.update_dismissed = "1.5"; P.U._reset();

	/* nothing newer */
	P = page({ platform: "android", installed: "1.5", server: json({ android: { version: "1.5", url: "a.apk" } }) });
	P.init(); r = await P.U.check(false);
	check("same version: up to date, no banner", r.state === "current" && P.els["upd-banner"].style.display === "none" && /up to date/.test(P.els["d-upd-status"].textContent), r);
	P = page({ platform: "android", server: json({ ios: { version: "9.9" } }) });
	P.init(); r = await P.U.check(false);
	check("no Android entry: current, with a note", r.state === "current" && /no Android version/.test(P.els["d-upd-status"].textContent));

	/* failures are quiet and never throw */
	for (var bad of [{ reject: "ECONNREFUSED" }, { status: 404, body: "" }, { status: 200, body: "<html>" }, json({ android: { version: "1.5" } })]) {
		P = page({ platform: "android", server: bad }); P.init();
		r = await P.U.check(false);
		check("failing server (" + (bad.reject || bad.status + " " + bad.body.slice(0, 8)) + "): error state, status line, no banner", r.state === "error" && /Could not check/.test(P.els["d-upd-status"].textContent) && P.els["upd-banner"].style.display === "none", r);
	}
	P = page({ platform: "android", url: "http://updates.example.com/x/", server: json({}) }); P.init();
	r = await P.U.check(false);
	check("a public http address is refused before any request is made", r.state === "error" && P.requests.length === 0 && /https/.test(r.message), r);
	P = page({ platform: "android", url: "http://192.168.1.10:8080/mobile.json", server: json({ android: { version: "1.5", url: "a.apk" } }) }); P.init();
	r = await P.U.check(false);
	check("a settings address that names the json file is used as it is; the apk is next to it", /^http:\/\/192\.168\.1\.10:8080\/mobile\.json\?t=/.test(P.requests[0].u) && r.info.url === "http://192.168.1.10:8080/a.apk", [P.requests, r]);
	P = page({ platform: "android", server: json({ android: { version: "1.5", url: "http://evil.example.com/a.apk" } }) }); P.init();
	r = await P.U.check(false);
	check("the manifest cannot point the app at a public http file", r.state === "error", r);

	/* iOS: notification only */
	P = page({ platform: "ios", installed: "1.4", server: json({ android: { version: "1.9", url: "a.apk" }, ios: { version: "1.5", message: "Install build 1.5 from Xcode." } }) });
	P.init(); r = await P.U.check(false);
	check("iOS reads its own entry, not Android's", r.state === "available" && r.info.version === "1.5" && r.info.url === "", r);
	check("iOS banner shows the message and has no Install button", /Install build 1\.5 from Xcode/.test(P.els["upd-banner"].innerHTML) && !/data-act="install"/.test(P.els["upd-banner"].innerHTML));
	P.U.install();
	check("iOS never calls the installer", P.installs.length === 0);

	/* desktop / plain browser: nothing at all */
	P = page({ platform: "", server: json({ android: { version: "9", url: "a.apk" } }) });
	P.init(); r = await P.U.check(false);
	check("no phone bridge: off, no request, update card hidden", r.state === "off" && P.requests.length === 0 && P.els["upd-card"].style.display === "none" && P.timers.length === 0);

	/* the first automatic check is scheduled after start-up */
	P = page({ platform: "android", server: json({ android: { version: "1.5", url: "a.apk" } }) }); P.init();
	check("a check is scheduled shortly after start", P.timers.length === 1);
	P.timers[0](); await new Promise(function (res) { setTimeout(res, 20); });
	check("…and it finds the update", P.els["upd-banner"].style.display === "", P.U.state());

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})().catch(function (e) { console.log("CRASH", e && e.stack || e); process.exit(1); });
