/* review.js — the manual check ("proof-reading") of a scanned document against the fields the app filled in.

   The Review box lists the values that matter for the kind of document on screen (number, date, supplier, totals, item
   lines, charges, …). The employee compares each with the attached document, ticks it, sets a status and may add a
   note and their name. Nothing is enforced — a document can be sent without a review — but whatever was recorded
   travels with it: as a remark on the ERPNext record (text()) and into the upload history (record()). */
window.CS_REVIEW = (function () {
"use strict";

var STATUS = {
	pending: "Not reviewed",
	ok: "Checked — OK",
	fixed: "Checked — corrected by me",
	problem: "Problem — needs attention"
};

/* [key, label, the element that shows when the check applies (a function may give the label)] */
var CHECKS = [
	["type", "The right document: type and file", null],
	["no", "Document number", null],
	["date", "Document date", null],
	["party", function () { return shown("d-box-customer") ? "Customer" : "Supplier"; }, function () { return shown("d-box-supplier") || shown("d-box-customer"); }],
	["ref", "Purchase order / sales invoice reference", function () { return shown("d-row-po") || shown("d-row-sales"); }],
	["amount", "Currency and total", null],
	["lines", "Item lines: codes, quantities, prices", function () { return shown("d-box-lines"); }],
	["charges", "VAT, shipping and other charges", function () { return shown("d-box-charges"); }],
	["track", "Tracking / AWB number", function () { return shown("d-box-track"); }],
	["parent", "Record it is filed under", function () { return shown("d-row-parent"); }]
];

var ctx = { settings: function () { return {}; }, save: function () {} };
var st = { ticks: {}, status: "pending", auto: false, note: "", by: "" };

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s === undefined || s === null ? "" : s).replace(/[<>&"]/g, function (m) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m]; }); }

/* an element counts as shown when it and the parents up to the form are not display:none */
function shown(id) {
	var el = $(id);
	while (el && el.id !== "box-doc-form") {
		if (el.style && el.style.display === "none") return false;
		el = el.parentNode;
	}
	return !!el;
}

function applicable() {
	return CHECKS.filter(function (c) { return !c[2] || c[2](); }).map(function (c) {
		return { key: c[0], label: typeof c[1] === "function" ? c[1]() : c[1] };
	});
}

function counts() {
	var list = applicable();
	var done = list.filter(function (c) { return st.ticks[c.key]; });
	return { list: list, done: done, missing: list.filter(function (c) { return !st.ticks[c.key]; }) };
}

function paint() {
	var box = $("rv-checks");
	if (!box) return;
	var c = counts();
	box.innerHTML = c.list.map(function (x) {
		return '<label class="rvrow' + (st.ticks[x.key] ? " on" : "") + '"><input type="checkbox" data-k="' + x.key + '"' + (st.ticks[x.key] ? " checked" : "") + "><span>" + esc(x.label) + "</span></label>";
	}).join("");
	var sum = $("rv-sum");
	if (sum) sum.textContent = c.done.length + " of " + c.list.length + " checked" + (st.status === "problem" ? " — marked as a problem" : "");
	var sel = $("rv-status");
	if (sel) sel.value = st.status;
	var all = $("rv-all");
	if (all) all.textContent = c.missing.length ? "Mark everything as checked" : "Clear all ticks";
	var box2 = $("d-review");
	if (box2) box2.className = box2.className.replace(/\s*\brv-(pending|ok|fixed|problem)\b/g, "") + " rv-" + st.status;
}

/* status follows the ticks until the employee chooses one: all ticked -> OK, a tick removed again -> not reviewed */
function afterTick() {
	var c = counts();
	if (c.list.length && !c.missing.length && st.status === "pending") { st.status = "ok"; st.auto = true; }
	else if (c.missing.length && st.auto && st.status === "ok") { st.status = "pending"; st.auto = false; }
	paint();
}

/* the list depends on what is on screen: call after the document type or the new-flow panel changed */
function refresh() { paint(); }

function reset() {
	st.ticks = {}; st.status = "pending"; st.auto = false; st.note = "";
	if ($("rv-note")) $("rv-note").value = "";
	paint();
}

function pad(n) { return n < 10 ? "0" + n : String(n); }
function stamp(d) { d = d || new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); }

/* what has been recorded, or null when the box was left alone */
function value() {
	var c = counts();
	var note = (($("rv-note") && $("rv-note").value) || st.note || "").trim();
	var by = (($("rv-by") && $("rv-by").value) || st.by || "").trim();
	if (st.status === "pending" && !c.done.length && !note) return null;
	return {
		status: st.status, label: STATUS[st.status], by: by, note: note, at: stamp(),
		checked: c.done.map(function (x) { return x.label; }),
		unchecked: c.missing.map(function (x) { return x.label; }),
		total: c.list.length
	};
}

/* the remark written into ERPNext ("" when nothing was recorded) */
function text() {
	var v = value();
	if (!v) return "";
	var s = "Manual review: " + v.label + " — " + v.checked.length + " of " + v.total + " values checked";
	if (v.checked.length && v.unchecked.length) s += " (not checked: " + v.unchecked.join(", ") + ")";
	s += ". " + (v.by ? "Reviewed by " + v.by + ", " : "") + v.at + ".";
	if (v.note) s += "\nNote: " + v.note;
	return s;
}

function init(o) {
	ctx = o || ctx;
	var by = $("rv-by");
	if (by) {
		by.value = (ctx.settings() || {}).reviewer || "";
		by.addEventListener("change", function () {
			var S = ctx.settings();
			if (S) { S.reviewer = by.value.trim(); ctx.save(); }
		});
	}
	var box = $("rv-checks");
	if (box) box.addEventListener("change", function (ev) {
		var k = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-k");
		if (!k) return;
		st.ticks[k] = !!ev.target.checked;
		afterTick();
	});
	var sel = $("rv-status");
	if (sel) sel.addEventListener("change", function () { st.status = sel.value; st.auto = false; paint(); });
	var all = $("rv-all");
	if (all) all.onclick = function () {
		var c = counts();
		var on = c.missing.length > 0;
		c.list.forEach(function (x) { st.ticks[x.key] = on; });
		if (!on && st.auto) { st.status = "pending"; st.auto = false; }
		afterTick();
	};
	var note = $("rv-note");
	if (note) note.addEventListener("input", function () { st.note = note.value; });
	paint();
}

return { init: init, refresh: refresh, reset: reset, value: value, text: text, STATUS: STATUS, applicable: applicable,
	_state: st };
})();
