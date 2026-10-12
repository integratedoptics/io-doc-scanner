/* newui.js — the screen part of the new document flow (newdocs.js): the item-line review list with its green / orange /
   red match marks and the "use" / "create new" switch, the Purchase Order comparison, the waybill → Purchase Order
   search, and the "send to live / send to test" switches.

   docscan.js owns the Documents screen and calls into this module at five points: update() when the document type
   or kind changes, setExtraction() with what the AI read, reset(), targets() / problem() before sending and send()
   for the test server. Nothing here touches the live (Accounts Document) flow. */
window.CS_NEWUI = (function () {
"use strict";

function $(id) { return document.getElementById(id); }
function esc(s) {
	return String(s === undefined || s === null ? "" : s).replace(/[<>&"]/g, function (m) {
		return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m];
	});
}
function N() { return window.CS_NEW; }
function settings() { return (window.CS && window.CS.settings && window.CS.settings()) || {}; }
function enabled() { return window.CS_ERP_TEST_ENABLED(settings()); }

var INVOICE_TYPES = { purchase_invoice: 1, shipping_invoice: 1, cd_invoice: 1 };
var state = { lines: [], pos: { docs: {}, missing: [] }, token: 0, orders: [], picked: {}, receipts: [], awbFor: "", itemsFor: "" };

/* which new-flow kind a document goes to: "invoice" | "quotation" | "waybill" | "" (live flow only) */
function kind(type, attachmentKind) {
	if (INVOICE_TYPES[type]) return "invoice";
	if (type === "supplier_quotation") return "quotation";
	if (type === "waybill" || (type === "attachment" && attachmentKind === "waybill")) return "waybill";
	return "";
}

/* ----------------------------------------------------------- panel */

var TITLES = { invoice: "Purchase Invoice on the test server", quotation: "Supplier Quotation on the test server",
	waybill: "Purchase Receipt on the test server" };

function update(type, attachmentKind, quiet) {
	var k = kind(type, attachmentKind), on = enabled();
	var box = $("d-new");
	var quotationOnly = type === "supplier_quotation";
	box.style.display = (k && on) || quotationOnly ? "" : "none";
	if (!(k && on) && !quotationOnly) return;
	$("d-new-title").textContent = k ? TITLES[k] : "Supplier Quotation";
	$("d-new-target").textContent = String(settings().erp_test_url || "").replace(/^https?:\/\//, "");
	$("d-send-live-row").style.display = quotationOnly ? "none" : "";
	$("d-send-test-row").style.display = on ? "" : "none";
	$("d-new-hint").textContent = !on
		? "Supplier quotations are filed on the test server only — set its address in Settings first."
		: ({ invoice: "The invoice is filed as a draft Purchase Invoice with its item lines; new items are created first.",
			quotation: "The quotation is filed as a draft Supplier Quotation; several lines of one item mean quantity price breaks.",
			waybill: "A draft Purchase Receipt is made from the Purchase Order that carries this AWB number, and the waybill is attached to it." }[k] || "");
	$("d-box-lines").style.display = (k === "invoice" || k === "quotation") && on ? "" : "none";
	$("d-box-track").style.display = (k === "invoice" || k === "waybill") && on ? "" : "none";
	$("d-box-valid").style.display = k === "quotation" && on ? "" : "none";
	$("d-box-awb").style.display = k === "waybill" && on ? "" : "none";
	if (quiet) return;
	if ((k === "invoice" || k === "quotation") && on) refreshLines(false);
	if (k === "waybill" && on) findOrders();
}

function reset() {
	state.token++;
	state.lines = []; state.pos = { docs: {}, missing: [] }; state.orders = []; state.picked = {}; state.receipts = []; state.awbFor = "";
	["d-tracking_number", "d-valid_until", "d-awb-po"].forEach(function (id) { if ($(id)) $(id).value = ""; });
	$("d-lines").innerHTML = ""; $("d-po-sum").innerHTML = ""; $("d-awb-list").innerHTML = ""; $("d-lines-hint").textContent = "";
	$("d-send-live").checked = true; $("d-send-test").checked = true;
	$("d-new").style.display = "none";
}

/* the AI's reading: lines, tracking number, validity */
function setExtraction(x) {
	if (!x) return;
	if ($("d-tracking_number")) $("d-tracking_number").value = x.tracking_number ? String(x.tracking_number).replace(/\s+/g, "") : "";
	if ($("d-valid_until")) $("d-valid_until").value = x.valid_until || "";
	state.lines = (Array.isArray(x.lines) ? x.lines : []).map(N().normalizeLine);
	state.itemsFor = "";
}

/* ----------------------------------------------------------- lines */

function fmt(n) { return n === null || n === undefined || n !== n ? "" : String(n); }

function pill(l) {
	var m = l.match || { level: "red", score: 0 };
	var label;
	if (m.kind === "default") label = "service line — uses the default item " + esc(l.decision.itemCode);
	else if (m.kind === "nocode") label = "no item code on the line";
	else if (m.score >= 100) label = "100 % — item exists";
	else label = m.score + " % — " + (m.candidates[0] ? "closest: " + esc(m.candidates[0].code) : "no similar item");
	return '<span class="pill ' + m.level + '">' + label + "</span>";
}

function lineHtml(l, i) {
	var m = l.match || { level: "red", score: 0, candidates: [], kind: "code" };
	var d = l.decision || { mode: "create" };
	var html = '<div class="li" data-i="' + i + '">' +
		'<div class="row3"><div><label>Item code</label><input data-f="code" value="' + esc(l.code) + '" autocapitalize="off" spellcheck="false"></div>' +
		'<div><label>Qty</label><input data-f="qty" inputmode="decimal" value="' + esc(fmt(l.qty)) + '"></div>' +
		'<div><label>Unit price</label><input data-f="rate" inputmode="decimal" value="' + esc(fmt(l.rate)) + '"></div></div>' +
		'<input data-f="description" class="desc" placeholder="Description" value="' + esc(l.description) + '">' +
		'<div class="matchrow">' + pill(l);
	if (m.score < 100 && m.kind !== "default") {
		html += '<span class="seg"><button type="button" data-mode="use"' + (d.mode === "use" ? ' class="on"' : "") + ">Use</button>" +
			'<button type="button" data-mode="create"' + (d.mode === "create" ? ' class="on"' : "") + ">Create new</button></span>";
	}
	html += "</div>";
	if (m.score < 100 && m.kind !== "default") {
		if (d.mode === "use") {
			if (m.candidates.length) {
				html += '<select data-f="itemCode">' + m.candidates.map(function (c) {
					return '<option value="' + esc(c.code) + '"' + (c.code === d.itemCode ? " selected" : "") + ">" + esc(c.code) +
						(c.name ? " — " + esc(c.name) : "") + " (" + c.score + " %)</option>";
				}).join("") + "</select>";
			} else {
				html += '<p class="hint warntext">No similar item to use — choose “Create new”, or change the code above to an existing one.</p>';
			}
		} else {
			html += '<div class="row"><div><label>New item code</label><input data-f="newCode" value="' + esc(d.newCode) + '" autocapitalize="off" spellcheck="false"></div>' +
				'<div><label>New item name</label><input data-f="newName" value="' + esc(d.newName) + '"></div></div>';
		}
	}
	if (l.poNote) html += '<p class="hint' + (l.poWarn ? " warntext" : "") + '">' + esc(l.poNote) + "</p>";
	html += '<button type="button" class="lnk" data-del="1">Remove this line</button></div>';
	return html;
}

function renderLines() {
	var box = $("d-lines");
	box.innerHTML = state.lines.map(lineHtml).join("");
	var open = state.lines.filter(function (l) { return l.poWarn; }).length;
	var poN = Object.keys(state.pos.docs);
	var sum = "";
	if (poN.length) sum += "Compared with " + poN.join(", ") + ".";
	if (state.pos.missing.length) sum += " Not found on the test server: " + state.pos.missing.join(", ") + ".";
	if (open) sum += " " + open + " line" + (open > 1 ? "s" : "") + " differ from the order.";
	$("d-po-sum").innerHTML = sum ? '<p class="hint' + (open || state.pos.missing.length ? " warntext" : "") + '">' + esc(sum) + "</p>" : "";
	var nocode = state.lines.some(function (l) { return l.match && l.match.kind === "nocode"; });
	$("d-lines-hint").textContent = !state.lines.length
		? "No item lines were read from this document. Add them with “Add a line” (the Anthropic key in Settings reads them automatically)."
		: (nocode ? "Lines without an item code would become new items. To book such lines (courier charges, freight) on one service item instead, set “Item for lines without a code” in Settings." : "");
}

function poNames() {
	var el = $("d-purchase_order_reference");
	var list = el ? el.value.split(/[,;]/) : [];
	state.lines.forEach(function (l) { if (l.poReference) list.push(l.poReference); });
	return list.map(function (v) { return String(v || "").trim(); }).filter(Boolean);
}

/* match all lines (once per extraction) and compare with the Purchase Orders */
function refreshLines(force) {
	var token = ++state.token;
	if (!enabled()) return Promise.resolve();
	var sig = state.lines.map(function (l) { return l.code + "|" + l.description; }).join("\n");
	var pending = force || state.itemsFor !== sig;
	var p = pending
		? N().matchLines(state.lines).then(function () { state.itemsFor = sig; })
		: Promise.resolve();
	return p.then(function () {
		return N().loadPurchaseOrders(poNames());
	}).then(function (pos) {
		if (token !== state.token) return;
		state.pos = pos;
		N().annotatePo(state.lines, pos);
		renderLines();
	}).catch(function (e) {
		if (token !== state.token) return;
		renderLines();
		$("d-lines-hint").textContent = "Could not check the items on the test server: " + N().errText(e);
	});
}

function lineEdit(i, f, v) {
	var l = state.lines[i];
	if (!l) return;
	if (f === "code") { l.code = v.trim(); return refreshLines(true); }
	if (f === "qty") { l.qty = N()._internals.num(v); }
	else if (f === "rate") { l.rate = N()._internals.num(v); }
	else if (f === "description") { l.description = v.trim(); if (l.decision && l.decision.mode === "create" && !l.decision.newName) l.decision.newName = l.description; }
	else if (f === "itemCode" || f === "newCode" || f === "newName") { l.decision[f] = v.trim(); }
	return refreshLines(false);
}

function wire() {
	var box = $("d-lines");
	box.addEventListener("change", function (ev) {
		var el = ev.target, row = el.closest ? el.closest(".li") : null;
		if (!row || !el.dataset || !el.dataset.f) return;
		lineEdit(Number(row.dataset.i), el.dataset.f, el.value);
	});
	box.addEventListener("click", function (ev) {
		var el = ev.target, row = el.closest ? el.closest(".li") : null;
		if (!row) return;
		var i = Number(row.dataset.i), l = state.lines[i];
		if (el.dataset && el.dataset.mode && l) {
			l.decision.mode = el.dataset.mode;
			if (el.dataset.mode === "use" && !l.decision.itemCode && l.match.candidates[0]) l.decision.itemCode = l.match.candidates[0].code;
			if (el.dataset.mode === "create" && !l.decision.newCode) l.decision.newCode = l.code;
			N().annotatePo(state.lines, state.pos);
			renderLines();
		} else if (el.dataset && el.dataset.del) {
			state.lines.splice(i, 1);
			state.itemsFor = "";
			refreshLines(false);
		}
	});
	$("btn-line-add").onclick = function () {
		state.lines.push(N().normalizeLine({ quantity: 1 }));
		state.itemsFor = "";
		refreshLines(true);
	};
	$("btn-awb-find").onclick = function () { findOrders(true); };
	$("d-tracking_number").addEventListener("change", function () { findOrders(true); });
	$("d-purchase_order_reference").addEventListener("change", function () { if (state.lines.length) refreshLines(false); });
}

/* ----------------------------------------------------------- waybill */

function ordersHtml() {
	var html = "";
	if (state.receipts.length) {
		html += '<p class="hint warntext">A Purchase Receipt with this AWB already exists: ' + esc(state.receipts.join(", ")) +
			". The waybill will be attached to it and no new receipt is made.</p>";
	}
	if (!state.orders.length && !state.receipts.length) {
		html += '<p class="hint warntext">No Purchase Order carries this AWB number on the test server. Enter the Purchase Order below.</p>';
	}
	state.orders.forEach(function (o) {
		html += '<label class="pick"><input type="checkbox" data-po="' + esc(o.name) + '"' + (state.picked[o.name] ? " checked" : "") + "> " +
			"<b>" + esc(o.name) + "</b> — " + esc(o.supplier || "") + (o.date ? " — " + esc(o.date) : "") +
			(o.status ? " — " + esc(o.status) : "") + (o.perReceived ? " — " + Math.round(o.perReceived) + " % received" : "") +
			(o.submitted ? "" : ' <span class="warntext">(not submitted — ERPNext may refuse a receipt)</span>') + "</label>";
	});
	return html;
}

function renderOrders() {
	var box = $("d-awb-list");
	box.innerHTML = ordersHtml();
	Array.prototype.forEach.call(box.querySelectorAll("[data-po]"), function (cb) {
		cb.onchange = function () { state.picked[cb.dataset.po] = cb.checked; };
	});
}

function findOrders(force) {
	var awb = $("d-tracking_number").value.trim();
	var manual = $("d-awb-po").value.trim();
	if (!force && state.awbFor === awb + "|" + manual) return;
	state.awbFor = awb + "|" + manual;
	var token = ++state.token;
	$("d-awb-list").innerHTML = '<p class="hint">Searching the test server…</p>';
	var jobs = [awb ? N().findByAwb(awb) : Promise.resolve({ orders: [], receipts: [] }),
		manual ? N().describeOrder(manual).catch(function () { return null; }) : Promise.resolve(null)];
	Promise.all(jobs).then(function (r) {
		if (token !== state.token) return;
		state.orders = r[0].orders.slice();
		state.receipts = r[0].receipts;
		if (manual) {
			if (r[1]) { if (!state.orders.some(function (o) { return o.name === r[1].name; })) state.orders.unshift(r[1]); state.picked[r[1].name] = true; }
			else $("d-awb-list").innerHTML = '<p class="hint warntext">' + esc(manual) + " is not a Purchase Order on the test server.</p>";
		}
		state.orders.forEach(function (o) { if (state.picked[o.name] === undefined) state.picked[o.name] = true; });
		if (!(manual && !r[1])) renderOrders();
	}).catch(function (e) {
		if (token !== state.token) return;
		$("d-awb-list").innerHTML = '<p class="hint" style="color:var(--err)">' + esc(N().errText(e)) + "</p>";
	});
}

/* ----------------------------------------------------------- sending */

/* what the switches say: { live, test, why } */
function targets(type, attachmentKind) {
	var k = kind(type, attachmentKind), on = enabled();
	var testAvail = on && !!k;
	var liveAvail = type !== "supplier_quotation";
	if (!testAvail && !liveAvail) {
		return { live: false, test: false, why: "Supplier quotations are filed on the test server only — set its address under Settings first." };
	}
	return {
		live: liveAvail && (!testAvail || $("d-send-live").checked),
		test: testAvail && $("d-send-test").checked,
		why: "Switch on the live or the test server first."
	};
}

function fieldsOf(f) {
	var tot = $("d-total_amount").value.trim();
	return {
		documentNo: f.documentNo, documentDate: f.documentDate, paymentDueDate: f.paymentDueDate,
		supplierName: f.supplierName, supplierCode: f.supplierCode,
		currency: $("d-currency").value.trim().toUpperCase(),
		totalAmount: tot === "" ? null : N()._internals.num(tot),
		trackingNumber: $("d-tracking_number").value.trim(),
		validUntil: $("d-valid_until").value.trim()
	};
}

/* a reason the test-server send cannot start, or "" */
function problem(type, attachmentKind, f) {
	var k = kind(type, attachmentKind);
	var bad = window.CS_ERP_TEST.ready();
	if (bad) return "Test server: " + bad;
	if (k === "waybill") {
		var picked = Object.keys(state.picked).filter(function (n) { return state.picked[n]; });
		if (!picked.length && !state.receipts.length) return "Test server: choose the Purchase Order this waybill belongs to (search by AWB number or enter it).";
		return "";
	}
	if (!f.supplierName) return "Test server: the supplier name is required.";
	if (!f.documentDate) return "Test server: the document date is required.";
	if (k === "invoice" && !f.documentNo) return "Test server: the document number is required (it becomes the Supplier Invoice No).";
	return N().checkLines(state.lines) ? "Test server: " + N().checkLines(state.lines) : "";
}

function ok(html) { return '<p class="hint" style="color:#1f8a4c">' + html + "</p>"; }
function bad(html) { return '<p class="hint" style="color:var(--err)">' + html + "</p>"; }
function plain(html, warn) { return '<p class="hint' + (warn ? " warntext" : "") + '">' + html + "</p>"; }

function fileLines(fr, label) {
	if (fr && fr.state === "created") return [ok("File attached" + (label ? " " + label : "") + ".")];
	if (fr && fr.state === "error") return [bad("The file could not be attached: " + esc((fr.errors && fr.errors[0] && fr.errors[0].message) || ""))];
	return [];
}

function noteLines(notes) { return (notes || []).map(function (n) { return plain(esc(n.message)); }); }

/* Sends one document to the test server. Resolves { ok, lines } and never rejects. */
function send(type, attachmentKind, f, file) {
	var k = kind(type, attachmentKind), fields = fieldsOf(f);
	var lines = [];
	if (k === "invoice" || k === "quotation") {
		var make = k === "invoice" ? N().createPurchaseInvoice : N().createSupplierQuotation;
		var what = k === "invoice" ? "Purchase Invoice" : "Supplier Quotation";
		return make(fields, state.lines, file).then(function (r) {
			lines.push(ok("Test server: saved as <b>" + esc(r.name) + "</b> (" + what + ", draft)."));
			if (r.created && r.created.length) lines.push(ok("New items created first: " + esc(r.created.join(", ")) + "."));
			fileLines(r.file).forEach(function (h) { lines.push(h); });
			if (r.note) lines.push(plain(esc(r.note), true));
			noteLines(r.notes).forEach(function (h) { lines.push(h); });
			N().forgetItems();
			return { ok: true, lines: lines };
		}, function (e) {
			lines.push(bad("Test server: " + esc(N().errText(e))));
			return { ok: false, lines: lines };
		});
	}
	if (k === "waybill") {
		var picked = Object.keys(state.picked).filter(function (n) { return state.picked[n]; });
		var job = state.receipts.length && !picked.length
			? N().attachToReceipts(state.receipts, file).then(function (r) {
				return r.map(function (x) { return { name: x.name, file: x.file, existing: true, notes: [] }; });
			})
			: N().createReceipts(picked, fields.trackingNumber, file);
		return job.then(function (rs) {
			var all = true;
			rs.forEach(function (r) {
				if (r.error) { all = false; lines.push(bad("Test server: " + esc(r.order || "") + " — " + esc(r.error))); return; }
				lines.push(ok("Test server: " + (r.existing ? "waybill attached to the existing receipt <b>" : "Purchase Receipt <b>") + esc(r.name) +
					"</b>" + (r.existing ? "." : " saved as a draft" + (r.order ? " from " + esc(r.order) : "") + ".")));
				fileLines(r.file).forEach(function (h) { lines.push(h); });
				noteLines(r.notes).forEach(function (h) { lines.push(h); });
			});
			return { ok: all, lines: lines };
		}, function (e) {
			return { ok: false, lines: [bad("Test server: " + esc(N().errText(e)))] };
		});
	}
	return Promise.resolve({ ok: true, lines: [] });
}

/* "Test the connection" in Settings */
function testConnection(button, out) {
	var bad0 = window.CS_ERP_TEST.ready();
	if (bad0) { out.innerHTML = bad(esc(bad0)); return; }
	button.disabled = true; button.textContent = "Checking…";
	N().testServer().then(function () {
		out.innerHTML = ok("Connected to the test server — Items, Purchase Invoices and Supplier Quotations can be read.");
	}, function (e) {
		out.innerHTML = bad(esc(N().errText(e)));
	}).then(function () { button.disabled = false; button.textContent = "Test the test server"; });
}

function init() {
	if (!$("d-lines")) return;
	wire();
}

return { kind: kind, update: update, reset: reset, setExtraction: setExtraction, refresh: refreshLines, targets: targets,
	problem: problem, send: send, init: init, testConnection: testConnection, _state: state };
})();
