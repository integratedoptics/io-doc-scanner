/* history.js — the upload history of the Documents screen.

   Every time a document is sent to ERPNext (the live server, the test server, or both) one record is kept on the device:
   when, what kind of document, its number and supplier, and for each server whether it worked — the ERPNext document it
   became, or the error ERPNext (or the app) gave. The screen shows the latest 30 in a scrollable field; "Show older
   records" opens the whole stored list (up to 500). Records are only ever added; nothing here is sent anywhere. */
window.CS_HISTORY = (function () {
"use strict";

var FILE = "upload-history.json";
var KEEP = 500;      // records kept on the device
var LATEST = 30;     // records shown before "Show older records"
var items = null;
var expanded = false;

function $(id) { return document.getElementById(id); }
function esc(s) {
	return String(s === undefined || s === null ? "" : s).replace(/[<>&"]/g, function (m) {
		return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m];
	});
}
function store() { return window.Android || null; }

function load() {
	if (items) return items;
	items = [];
	try {
		var raw = store() && store().readData ? store().readData(FILE) : "";
		var j = raw ? JSON.parse(raw) : [];
		if (Array.isArray(j)) items = j;
	} catch (e) { items = []; }
	return items;
}

function save() {
	try { if (store() && store().writeData) store().writeData(FILE, JSON.stringify(items)); } catch (e) { /* the list stays in memory */ }
}

/* "ok" | "partial" | "error" — from the results that were really attempted */
function statusOf(rec) {
	var tried = (rec.results || []).filter(function (r) { return !r.skipped; });
	if (!tried.length) return "error";
	var good = tried.filter(function (r) { return r.ok; }).length;
	return good === tried.length ? "ok" : (good ? "partial" : "error");
}

var LABEL = { ok: "Sent", partial: "Partly sent", error: "Failed" };
var LEVEL = { ok: "green", partial: "orange", error: "red" };

function two(n) { return n < 10 ? "0" + n : String(n); }
function when(iso) {
	var d = new Date(iso);
	if (isNaN(d.getTime())) return String(iso || "");
	return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
}

/* rec: { type, docNo, supplier, file, results: [{ server, ok, skipped, name, message, notes: [text] }] } */
function record(rec) {
	load();
	rec = rec || {};
	rec.ts = rec.ts || new Date().toISOString();
	rec.id = rec.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
	rec.status = statusOf(rec);
	items.unshift(rec);
	if (items.length > KEEP) items.length = KEEP;
	save();
	render();
	return rec;
}

function resultHtml(r) {
	if (r.skipped) return '<div class="hs"><b>' + esc(r.server) + "</b>: not sent" + (r.message ? " — " + esc(r.message) : "") + "</div>";
	var html = r.ok
		? '<div class="hs hok"><b>' + esc(r.server) + "</b>: saved" + (r.name ? " as <b>" + esc(r.name) + "</b>" : "") + "</div>"
		: '<div class="hs herr"><b>' + esc(r.server) + "</b>: failed — " + esc(r.message || "unknown error") + "</div>";
	(r.notes || []).forEach(function (n) { html += '<div class="hn">' + esc(n) + "</div>"; });
	return html;
}

function rowHtml(rec) {
	var st = rec.status || statusOf(rec);
	var what = [rec.type, rec.docNo, rec.supplier].filter(Boolean).map(esc).join(" · ");
	return '<div class="uhrow"><div class="hh"><span class="pill ' + LEVEL[st] + '">' + LABEL[st] + '</span> <span class="ht">' + esc(when(rec.ts)) + "</span></div>" +
		'<div class="hm">' + (what || "Document") + (rec.file ? ' <span class="ht">(' + esc(rec.file) + ")</span>" : "") + "</div>" +
		(rec.results || []).map(resultHtml).join("") + "</div>";
}

function render() {
	var box = $("d-hist");
	if (!box) return;
	load();
	var shown = expanded ? items : items.slice(0, LATEST);
	box.className = "uhist" + (expanded ? " open" : "");
	box.innerHTML = shown.length ? shown.map(rowHtml).join("") : '<p class="hint" style="margin:8px">No documents have been sent from this device yet.</p>';
	var more = $("btn-hist-more"), sum = $("d-hist-sum");
	var older = Math.max(0, items.length - LATEST);
	if (more) {
		more.style.display = older ? "" : "none";
		more.textContent = expanded ? "Show only the latest " + LATEST : "Show older records (" + older + " more)";
	}
	if (sum) {
		var failed = items.slice(0, shown.length).filter(function (r) { return (r.status || statusOf(r)) !== "ok"; }).length;
		sum.textContent = items.length
			? "Showing " + shown.length + " of " + items.length + " record" + (items.length === 1 ? "" : "s") + (failed ? " — " + failed + " with a problem" : "") + "."
			: "";
	}
}

function init() {
	var more = $("btn-hist-more");
	if (more) more.onclick = function () { expanded = !expanded; render(); if (!expanded && $("d-hist")) $("d-hist").scrollTop = 0; };
	render();
}

return { record: record, render: render, init: init, list: function () { return load().slice(); }, statusOf: statusOf,
	_reset: function () { items = null; expanded = false; }, LATEST: LATEST, KEEP: KEEP };
})();
