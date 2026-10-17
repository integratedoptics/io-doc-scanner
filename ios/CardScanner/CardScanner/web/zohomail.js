/* zohomail.js — "From email": pick a PDF or picture attached to a recent Zoho Mail message (Windows / macOS app).

   The desktop shell (preload.js) provides window.CS_ZOHO; on phones and in a browser it is absent and this file does
   nothing. All safety decisions (trusted sender, SPF/DKIM/DMARC, look-alike domains, file type, PDF contents) are taken
   in the main process; this panel only shows the verdicts and collects the confirmations the main process demands:

       trusted sender  -> Open
       unknown sender  -> a confirm click
       risky sender    -> read the reasons, tick "I have checked this sender another way", then confirm

   The chosen file is handed to the normal Documents flow through window.onDocPicked, exactly as a file picked from disk. */
window.CS_ZOHOMAIL = (function () {
"use strict";

var ctx = { settings: function () { return {}; }, save: function () {}, toast: function () {}, gotoSettings: function () {} };
var state = { open: false, days: 14, data: null, busy: false };

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s === undefined || s === null ? "" : s).replace(/[<>&"]/g, function (m) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m]; }); }
function available() { return !!(window.CS_ZOHO && typeof window.CS_ZOHO.list === "function"); }

function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B"; }
function when(ms) {
	if (!ms) return "";
	var d = new Date(ms), now = new Date();
	var sameDay = d.toDateString() === now.toDateString();
	return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " +
		d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

var LEVELS = {
	trusted: { cls: "green", text: "Trusted sender" },
	check: { cls: "orange", text: "Check the sender" },
	risky: { cls: "red", text: "Risky — possible forgery" }
};

/* ------------------------------------------------------------------------------------------- settings card */

function trustedText() { return (ctx.settings().zoho_trusted || ""); }
function trustedList() { return trustedText().split(/[\s,;]+/).filter(Boolean); }

function setState(html, cls) { var el = $("zoho-state"); if (el) { el.innerHTML = html; el.className = "hint " + (cls || ""); } }

function paintStatus(st) {
	var connected = !!(st && st.connected);
	if ($("zoho-setup")) $("zoho-setup").style.display = connected ? "none" : "";
	if ($("zoho-connected")) $("zoho-connected").style.display = connected ? "" : "none";
	setState(connected ? "Connected" + (st.email ? " as <b>" + esc(st.email) + "</b>" : "") + ". Read-only: the app can list and open attachments, never send, move or delete mail."
		: "Not connected.", connected ? "ok" : "");
}

function refreshStatus() {
	if (!available()) return Promise.resolve(null);
	return window.CS_ZOHO.status().then(function (r) {
		if (!r || !r.ok) { setState("Could not read the status: " + esc(r && r.error), "bad"); return null; }
		var sel = $("s-zoho-region");
		if (sel && !sel.options.length) {
			(r.result.regions || []).forEach(function (g) { var o = document.createElement("option"); o.value = g.id; o.textContent = g.label; sel.appendChild(o); });
			sel.value = (ctx.settings().zoho_region || "eu");
		}
		if ($("zoho-scopes")) $("zoho-scopes").textContent = r.result.scopes || "";
		paintStatus(r.result);
		return r.result;
	});
}

function wireSettings() {
	var card = $("card-zoho");
	if (!card) return;
	card.style.display = "";
	if ($("s-zoho-trusted")) {
		$("s-zoho-trusted").value = trustedText();
		$("s-zoho-trusted").addEventListener("change", function () { ctx.settings().zoho_trusted = $("s-zoho-trusted").value.trim(); ctx.save(); });
	}
	if ($("s-zoho-days")) {
		$("s-zoho-days").value = String(ctx.settings().zoho_days || 14);
		$("s-zoho-days").addEventListener("change", function () { ctx.settings().zoho_days = Number($("s-zoho-days").value) || 14; ctx.save(); });
	}
	if ($("s-zoho-region")) $("s-zoho-region").addEventListener("change", function () { ctx.settings().zoho_region = $("s-zoho-region").value; ctx.save(); });
	if ($("btn-zoho-connect")) $("btn-zoho-connect").onclick = function () {
		var b = $("btn-zoho-connect"); b.disabled = true; b.textContent = "Connecting…";
		window.CS_ZOHO.connect({ region: $("s-zoho-region").value, clientId: $("s-zoho-id").value, clientSecret: $("s-zoho-secret").value, code: $("s-zoho-code").value })
			.then(function (r) {
				b.disabled = false; b.textContent = "Connect";
				if (!r || !r.ok) { setState("Not connected: " + esc(r && r.error), "bad"); return; }
				// the credentials now live in the main process; do not keep them in the form
				$("s-zoho-secret").value = ""; $("s-zoho-code").value = ""; $("s-zoho-id").value = "";
				ctx.settings().zoho_region = $("s-zoho-region").value; ctx.save();
				paintStatus(r.result); ctx.toast("Zoho Mail connected.", "good");
			});
	};
	if ($("btn-zoho-disconnect")) $("btn-zoho-disconnect").onclick = function () {
		window.CS_ZOHO.disconnect().then(function (r) { paintStatus(r && r.ok ? r.result : { connected: false }); ctx.toast("Zoho Mail disconnected.", "good"); });
	};
	refreshStatus();
}

/* ---------------------------------------------------------------------------------------------- the panel */

function ensurePanel() {
	var p = $("zm-panel");
	if (p) return p;
	p = document.createElement("div");
	p.id = "zm-panel";
	p.innerHTML =
		'<div class="zm-box" role="dialog" aria-modal="true" aria-label="Attachments from email">' +
		'<div class="zm-head"><h2>From email</h2><span class="zm-acct" id="zm-acct"></span>' +
		'<select id="zm-days" title="How far back to look"><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>' +
		'<button type="button" class="b sec" id="zm-refresh">Refresh</button>' +
		'<button type="button" class="b sec" id="zm-close" aria-label="Close">Close</button></div>' +
		'<p class="hint zm-note">Only PDF and picture attachments are listed. Each sender is checked before anything is opened; nothing is sent to ERPNext until you press Send on the document.</p>' +
		'<div id="zm-body"></div></div>';
	document.body.appendChild(p);
	p.addEventListener("mousedown", function (e) { if (e.target === p) close(); });
	$("zm-close").onclick = close;
	$("zm-refresh").onclick = load;
	$("zm-days").onchange = function () { state.days = Number($("zm-days").value) || 14; ctx.settings().zoho_days = state.days; ctx.save(); load(); };
	document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.open) close(); });
	return p;
}

function close() { state.open = false; var p = $("zm-panel"); if (p) p.style.display = "none"; }

function open() {
	if (!available()) return;
	var p = ensurePanel();
	state.open = true; state.days = Number(ctx.settings().zoho_days) || 14;
	$("zm-days").value = String(state.days);
	p.style.display = "flex";
	load();
}

function body(html) { $("zm-body").innerHTML = html; }

function load() {
	if (state.busy) return;
	state.busy = true;
	body('<p class="hint">Reading your inbox…</p>');
	window.CS_ZOHO.status().then(function (st) {
		if (!st || !st.ok || !st.result.connected) {
			state.busy = false;
			body('<p class="hint">Zoho Mail is not connected yet.</p><button type="button" class="b" id="zm-go">Connect it in Settings</button>');
			$("zm-go").onclick = function () { close(); ctx.gotoSettings(); };
			return null;
		}
		return window.CS_ZOHO.list({ days: state.days, trusted: trustedText() }).then(function (r) {
			state.busy = false;
			if (!r || !r.ok) { body('<p class="hint bad">' + esc(r && r.error || "Could not read the mailbox.") + "</p>"); return; }
			state.data = r.result;
			$("zm-acct").textContent = r.result.account || "";
			paint();
		});
	}).catch(function (e) { state.busy = false; body('<p class="hint bad">' + esc((e && e.message) || String(e)) + "</p>"); });
}

function reasonsHtml(m) {
	var rs = (m.reasons || []).filter(function (r) { return r.level !== "good" || m.level === "trusted"; });
	if (!rs.length) return "";
	return '<ul class="zm-why">' + rs.map(function (r) { return '<li class="' + esc(r.level) + '">' + esc(r.text) + "</li>"; }).join("") + "</ul>";
}

function mailHtml(m, mi) {
	var lv = LEVELS[m.level] || LEVELS.check;
	var a = m.auth || {};
	var tech = '<details class="zm-tech"><summary>Sender checks</summary>From: ' + esc(m.fromAddress) + " · SPF " + esc(a.spf || "–") + " · DKIM " + esc(a.dkim || "–") +
		" · DMARC " + esc(a.dmarc || "–") + (a.server ? " · checked by " + esc(a.server) : "") + "</details>";
	var atts = m.attachments.map(function (x, ai) {
		return '<div class="zm-att" data-m="' + mi + '" data-a="' + ai + '"><span class="zm-ico">' + (x.kind === "pdf" ? "PDF" : "IMG") + '</span>' +
			'<span class="zm-name">' + esc(x.name) + '</span><span class="zm-size">' + esc(size(x.size)) + "</span>" +
			'<button type="button" class="b zm-open">' + (m.level === "trusted" ? "Open" : "Open…") + "</button></div>" +
			'<div class="zm-confirm" id="zm-c-' + mi + "-" + ai + '" style="display:none"></div>';
	}).join("");
	return '<div class="zm-mail ' + lv.cls + '">' +
		'<div class="zm-top"><b class="zm-from">' + esc(m.sender || m.fromAddress) + '</b><span class="zm-addr">' + esc(m.fromAddress) + '</span><span class="zm-when">' + esc(when(m.received)) + "</span>" +
		'<span class="pill ' + lv.cls + '">' + lv.text + "</span></div>" +
		'<div class="zm-subj">' + esc(m.subject) + "</div>" + reasonsHtml(m) + atts + tech + "</div>";
}

function paint() {
	var d = state.data || { mails: [] };
	var html = "";
	if (!d.mails.length) html += '<p class="hint">No mail with a PDF or picture attachment in the last ' + d.days + " days.</p>";
	html += d.mails.map(mailHtml).join("");
	var notes = [];
	if (d.blockedFiles) notes.push(d.blockedFiles + " attachment" + (d.blockedFiles === 1 ? "" : "s") + " of a dangerous type (programs, scripts, archives, macro files, disguised names) " + (d.blockedFiles === 1 ? "was" : "were") + " hidden.");
	if (d.hiddenMails && d.hiddenMails > d.blockedFiles) notes.push("Mails whose attachments are not PDFs or pictures are not listed.");
	if (d.failed) notes.push(d.failed + " mail" + (d.failed === 1 ? "" : "s") + " could not be read.");
	if (notes.length) html += '<p class="hint">' + esc(notes.join(" ")) + "</p>";
	body(html);
	Array.prototype.forEach.call(document.querySelectorAll("#zm-body .zm-open"), function (b) {
		b.onclick = function () { askConfirm(b.parentNode); };
	});
}

/* the confirmation step each sender level calls for */
function askConfirm(row) {
	var mi = Number(row.getAttribute("data-m")), ai = Number(row.getAttribute("data-a"));
	var m = state.data.mails[mi], att = m.attachments[ai];
	if (m.level === "trusted") { fetchIt(m, att, "", row); return; }
	var box = $("zm-c-" + mi + "-" + ai);
	if (box.style.display !== "none") { box.style.display = "none"; return; }
	var risky = m.level === "risky";
	var html = '<p>' + (risky
		? "<b>This mail looks suspicious.</b> Open the attachment only if you have checked that it is genuine another way (a call to a known number, or a new mail to an address you already know)."
		: "This sender is not on your trusted list. Open the attachment only if you expect it.") + "</p>";
	if (risky) html += '<label class="zm-tick"><input type="checkbox" class="zm-ok"> I have checked this sender another way</label>';
	html += '<div class="zm-btns"><button type="button" class="b zm-go"' + (risky ? " disabled" : "") + ">Open anyway</button>";
	if (!risky && m.fromAddress) html += '<button type="button" class="b sec zm-trust">Always trust ' + esc(domainOf(m.fromAddress)) + "</button>";
	html += '<button type="button" class="b sec zm-cancel">Cancel</button></div><div class="zm-err hint bad"></div>';
	box.innerHTML = html; box.style.display = "";
	var ok = box.querySelector(".zm-ok"), go = box.querySelector(".zm-go");
	if (ok) ok.onchange = function () { go.disabled = !ok.checked; };
	go.onclick = function () { fetchIt(m, att, risky ? "risky" : "check", row, box); };
	box.querySelector(".zm-cancel").onclick = function () { box.style.display = "none"; };
	var t = box.querySelector(".zm-trust");
	if (t) t.onclick = function () { trustDomain(domainOf(m.fromAddress)); };
}

function domainOf(addr) { var i = String(addr).lastIndexOf("@"); return i > 0 ? String(addr).slice(i + 1).toLowerCase() : ""; }

/* Trusting a domain only ever downgrades the questions for mail that ALSO passes the sender checks (see mailsafety.js) */
function trustDomain(d) {
	if (!d) return;
	var cur = trustedList();
	if (cur.indexOf(d) < 0) cur.push(d);
	ctx.settings().zoho_trusted = cur.join("\n");
	ctx.save();
	if ($("s-zoho-trusted")) $("s-zoho-trusted").value = ctx.settings().zoho_trusted;
	ctx.toast(d + " added to the trusted senders.", "good");
	state.busy = false; load();
}

function fetchIt(m, att, ack, row, box) {
	var btn = row.querySelector(".zm-open"), err = box && box.querySelector(".zm-err");
	var restore = btn.textContent;
	btn.disabled = true; btn.textContent = "Fetching…";
	if (err) err.textContent = "";
	window.CS_ZOHO.fetch({ folderId: m.folderId, messageId: m.messageId, attachmentId: att.attachmentId, name: att.name, ack: ack, trusted: trustedText() })
		.then(function (r) {
			btn.disabled = false; btn.textContent = restore;
			if (!r || !r.ok) {
				var msg = (r && r.error) || "Could not fetch the attachment.";
				if (err) err.textContent = msg; else { var c = row.nextSibling; if (c && c.className === "zm-confirm") { c.style.display = ""; c.innerHTML = '<div class="zm-err hint bad">' + esc(msg) + "</div>"; } }
				return;
			}
			var f = r.result;
			close();
			if (typeof window.onDocPicked === "function") window.onDocPicked({ ok: true, name: f.name, dataUrl: f.dataUrl });
			if (f.warnings && f.warnings.length) ctx.toast("Opened with warnings: " + f.warnings.slice(0, 2).join(" "), "err");
			else ctx.toast("Opened " + f.name + " from " + (f.from || "email") + ".", "good");
		}).catch(function (e) { btn.disabled = false; btn.textContent = restore; if (err) err.textContent = (e && e.message) || String(e); });
}

function init(c) {
	Object.keys(c || {}).forEach(function (k) { ctx[k] = c[k]; });
	if (!available()) return;
	var b = $("btn-doc-email");
	if (b) { b.style.display = ""; b.onclick = open; }
	wireSettings();
}

return { init: init, open: open, close: close, available: available };
})();
