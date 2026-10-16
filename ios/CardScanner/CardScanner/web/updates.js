/* updates.js — "a newer version of the app is available" for the phone apps.

   The internal update server (a plain static file server) holds a small file, mobile.json, next to the files of the
   desktop updater:

     { "android": { "version": "1.5", "url": "io-doc-scanner-1.5.apk", "sha256": "<hex of the apk>" },
       "ios":     { "version": "1.5", "message": "Install the new build from Xcode." } }

   The app reads it on start, when it comes back to the front and every 30 minutes while it is open.

   Android  The banner offers "Install". The native side downloads the apk, checks its SHA-256 and that it is this very
            app, and hands it to the system installer — the user taps Install there (Android never updates an app
            silently). The first time, Android sends the user to the "install unknown apps" switch for this app.
   iOS      An iPhone app can only be replaced through Xcode / TestFlight / the App Store, so the app only tells the
            user that a newer version exists (and shows the manifest's message).
   Desktop / browser  Nothing here: the Windows/macOS app updates itself (electron-updater, app/updater.js).

   The address of the server is a setting ("update_url"); plain http is accepted only for local addresses. */
window.CS_UPDATES = (function () {
"use strict";

var DEFAULT_URL = "http://192.168.1.79:3005/updates/io-doc-scanner/";
var EVERY_MS = 30 * 60 * 1000;

var ctx = { settings: function () { return {}; }, save: function () {} };
var found = null;        // { kind, version, url, sha256, message } — the newer version, when there is one
var progress = null;     // { stage, percent, message } while the apk is being fetched
var statusText = "";
var lastCheck = 0;
var checking = false;
var timer = null;

function $(id) { return document.getElementById(id); }
function bridge() { return window.Android || {}; }
function esc(s) {
	return String(s === undefined || s === null ? "" : s).replace(/[<>&"]/g, function (m) {
		return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m];
	});
}

/* "android" | "ios" | "" (desktop, browser: no phone update) */
function kind() {
	var A = bridge();
	var p = "";
	try { p = A.platform ? String(A.platform()) : ""; } catch (e) { p = ""; }
	if (p === "android" || p === "ios") return p;
	return A.installUpdate ? "android" : "";
}

/* "1.4", "1.4-desktop", "v1.10.2" -> [1,4] ... ; null when no number leads the text */
function parseVersion(v) {
	var m = /^\s*v?(\d+(?:\.\d+)*)/i.exec(String(v === undefined || v === null ? "" : v));
	return m ? m[1].split(".").map(function (n) { return parseInt(n, 10); }) : null;
}

/* -1 / 0 / 1; a version that cannot be read counts as "not newer" for the caller (see isNewer) */
function compare(a, b) {
	var x = parseVersion(a) || [], y = parseVersion(b) || [];
	for (var i = 0; i < Math.max(x.length, y.length); i++) {
		var p = x[i] || 0, q = y[i] || 0;
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

function isNewer(candidate, installed) {
	return !!parseVersion(candidate) && !!parseVersion(installed) && compare(candidate, installed) > 0;
}

function privateHost(h) {
	h = String(h || "").toLowerCase();
	if (h === "localhost" || h === "[::1]" || /\.(local|lan|localhost|test)$/.test(h)) return true;
	var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
	if (!m) return false;
	var a = +m[1], b = +m[2];
	return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/* https anywhere, http only for local addresses */
function addressOk(url) {
	var m = /^(https?):\/\/([^\/:?#]+|\[[^\]]+\])(?::\d+)?(?:[\/?#]|$)/i.exec(String(url || ""));
	if (!m) return false;
	return m[1].toLowerCase() === "https" || privateHost(m[2]);
}

function baseUrl() {
	var u = String((ctx.settings() || {}).update_url || "").trim() || DEFAULT_URL;
	return /\.json(\?.*)?$/i.test(u) ? u.replace(/[^\/]*$/, "") : u.replace(/\/*$/, "/");
}

function manifestUrl() {
	var u = String((ctx.settings() || {}).update_url || "").trim() || DEFAULT_URL;
	return /\.json(\?.*)?$/i.test(u) ? u : baseUrl() + "mobile.json";
}

/* the file the manifest names, resolved against the server's folder */
function resolve(file) {
	file = String(file || "");
	if (/^https?:\/\//i.test(file)) return file;
	return baseUrl() + file.split("/").map(encodeURIComponent).join("/");
}

function installedVersion() {
	try { return String(bridge().appVersion ? bridge().appVersion() : ""); } catch (e) { return ""; }
}

/* Reads the manifest. Resolves { state: "off" | "current" | "available" | "error", ... } — never rejects. */
function check(manual) {
	var k = kind();
	if (!k) return Promise.resolve({ state: "off" });
	if (checking) return Promise.resolve({ state: "busy" });
	if (!window.CS_NET) return Promise.resolve({ state: "off" });
	var murl = manifestUrl();
	if (!addressOk(murl)) {
		return done({ state: "error", message: "The update server address must start with https:// (http:// is only allowed for local addresses)." }, manual);
	}
	checking = true;
	statusText = "Checking…";
	paint();
	var url = murl + (murl.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
	return window.CS_NET.request("GET", url, {}, "", 15).then(function (r) {
		if (r.status !== 200) throw new Error("the update server answered " + r.status);
		var m;
		try { m = JSON.parse(r.body); } catch (e) { throw new Error("mobile.json on the update server is not valid JSON"); }
		var e = m && m[k];
		if (!e || !e.version) return { state: "current", note: "the server has no " + (k === "ios" ? "iPhone" : "Android") + " version listed" };
		var mine = installedVersion();
		if (!isNewer(e.version, mine)) return { state: "current", version: mine };
		if (k === "android" && !e.url) throw new Error("mobile.json lists version " + e.version + " without a file");
		var apk = k === "android" ? resolve(e.url) : "";
		if (apk && !addressOk(apk)) throw new Error("the update file address must be https (or a local address)");
		return { state: "available", info: { kind: k, version: String(e.version), url: apk, sha256: String(e.sha256 || "").trim().toLowerCase(), message: String(e.message || ""), page: e.page ? String(e.page) : "" } };
	}).then(function (res) { checking = false; return done(res, manual); },
		function (err) { checking = false; return done({ state: "error", message: (err && err.message) || String(err) }, manual); });
}

function done(res, manual) {
	lastCheck = Date.now();
	if (res.state === "available") {
		var changed = !found || found.version !== res.info.version;
		found = res.info;
		if (changed) progress = null;
		statusText = "Version " + found.version + " is available (this app is " + installedVersion() + ").";
		if (manual) { var S = ctx.settings(); if (S && S.update_dismissed === found.version) { S.update_dismissed = ""; ctx.save(); } }
	} else if (res.state === "current") {
		found = null;
		statusText = "This app (" + installedVersion() + ") is up to date." + (res.note ? " (" + res.note + ")" : "");
	} else if (res.state === "error") {
		statusText = "Could not check for updates: " + res.message;
	}
	paint();
	return res;
}

function dismissed() {
	var S = ctx.settings() || {};
	return !!found && S.update_dismissed === found.version;
}

/* ---------------------------------------------------------------- Android installer */

/* The native side reports { stage: "permission" | "downloading" | "verifying" | "installing" | "error", percent, message } */
window.onUpdateState = function (s) {
	if (typeof s === "string") { try { s = JSON.parse(s); } catch (e) { s = { stage: "error", message: s }; } }
	progress = s || null;
	paint();
};

function install() {
	if (!found || found.kind !== "android") return;
	var A = bridge();
	if (!A.installUpdate) { progress = { stage: "error", message: "This build of the app cannot install updates itself — update it from the apk." }; paint(); return; }
	progress = { stage: "downloading", percent: 0 };
	paint();
	A.installUpdate(found.url, found.sha256 || "", "upd");
}

function later() {
	if (!found) return;
	var S = ctx.settings();
	S.update_dismissed = found.version;
	ctx.save();
	paint();
}

/* ---------------------------------------------------------------- screen */

function bannerHtml() {
	if (!found) return "";
	var v = esc(found.version);
	var p = progress;
	if (found.kind === "android") {
		if (p && p.stage === "downloading") return "<span>Downloading version " + v + "… " + (p.percent > 0 ? p.percent + " %" : "") + "</span>";
		if (p && p.stage === "verifying") return "<span>Checking the download…</span>";
		if (p && p.stage === "installing") return "<span>Version " + v + " is ready — confirm the installation in the Android window.</span> <button class=\"ub\" data-act=\"install\">Install again</button>";
		if (p && p.stage === "permission") return "<span>Allow “Card Scanner” to install apps in the Android settings that just opened, come back here and tap Install again.</span> <button class=\"ub\" data-act=\"install\">Install</button>";
		var err = p && p.stage === "error" ? "<span class=\"ue\">" + esc(p.message || "The update failed.") + "</span><br>" : "";
		return err + "<span>Update " + v + " is available.</span> <button class=\"ub\" data-act=\"install\">Install</button> <button class=\"ub sec\" data-act=\"later\">Later</button>";
	}
	return "<span>Update " + v + " is available. " + esc(found.message || "Install the new version on this iPhone (Xcode, TestFlight or the App Store).") + "</span> <button class=\"ub sec\" data-act=\"later\">OK</button>";
}

function paint() {
	var bar = $("upd-banner");
	if (bar) {
		var show = !!found && (!dismissed() || (progress && progress.stage));
		bar.style.display = show ? "" : "none";
		if (show) bar.innerHTML = bannerHtml();
	}
	var st = $("d-upd-status");
	if (st) st.textContent = statusText;
	var btn = $("btn-upd-check");
	if (btn) btn.disabled = checking;
}

function onBannerClick(ev) {
	var t = ev.target;
	var act = t && t.getAttribute ? t.getAttribute("data-act") : "";
	if (act === "install") install();
	else if (act === "later") later();
}

/* o: { settings: fn -> the settings object, save: fn } — called once by app.js; does nothing on desktop / in a browser */
function init(o) {
	ctx = o || ctx;
	var inp = $("s-upd-url");
	if (inp && !inp.value) inp.value = (ctx.settings() || {}).update_url || "";
	var on = !!kind();
	var card = $("upd-card");
	if (card) card.style.display = on ? "" : "none";
	if (!on) return;
	var bar = $("upd-banner");
	if (bar) bar.onclick = onBannerClick;
	var btn = $("btn-upd-check");
	if (btn) btn.onclick = function () {
		if (ctx.grab) ctx.grab();
		check(true).then(function (r) {
			if (r.state === "available" && ctx.toast) ctx.toast("Update " + r.info.version + " is available");
			else if (r.state === "current" && ctx.toast) ctx.toast("The app is up to date", "good");
			else if (r.state === "error" && ctx.toast) ctx.toast("Update check failed", "err");
		});
	};
	setTimeout(function () { check(false); }, 4000);
	if (!timer) {
		timer = setInterval(function () { check(false); }, EVERY_MS);
		document.addEventListener("visibilitychange", function () {
			if (document.visibilityState === "visible" && Date.now() - lastCheck > EVERY_MS) check(false);
		});
	}
}

return { init: init, check: check, install: install, later: later, kind: kind, parseVersion: parseVersion, compare: compare,
	isNewer: isNewer, addressOk: addressOk, manifestUrl: manifestUrl, resolve: resolve, DEFAULT_URL: DEFAULT_URL,
	state: function () { return { found: found, progress: progress, status: statusText }; },
	_reset: function () { found = null; progress = null; statusText = ""; lastCheck = 0; checking = false; } };
})();
