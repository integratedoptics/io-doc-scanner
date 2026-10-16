/* docscan.js — the "Documents" screen: scan/pick a PDF (purchase invoice,
   proforma, sales invoice, customs declaration, its own invoice, or a
   shipping invoice), read it with pdfview.js + extract.js, let the employee
   check/correct the fields, warn about a likely-duplicate supplier before
   one gets created, auto-suggest the parent Accounts Document for the three
   later sections, and on approval hand off to accdoc.js to actually create
   or update the ERPNext record and attach the file.

   Self-contained, like erp.js / accdoc.js / extract.js: owns the v-docs
   section's DOM and wiring itself rather than growing app.js, and reuses
   window.CS (exposed at the end of app.js) only for settings() — nothing
   here reaches into app.js's private state. */
window.CS_DOCSCAN = (function () {
"use strict";

function $(id) { return document.getElementById(id); }
function esc(s) {
	return String(s === undefined ? "" : s).replace(/[<>&]/g, function (m) {
		return { "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m];
	});
}
function busy(btn, on, label) {
	btn.disabled = on;
	if (label) btn.textContent = label;
}

var DOC_TYPE_LABELS = {
	purchase_invoice: "Purchase Invoice", proforma_invoice: "Proforma Invoice",
	sales_invoice: "Sales Invoice", customs_declaration: "Customs Declaration",
	cd_invoice: "Customs Declaration Invoice", shipping_invoice: "Shipping / courier Invoice",
	supplier_quotation: "Supplier Quotation", waybill: "Waybill", attachment: "Attachment"
};
var SECTION_FOR = {
	purchase_invoice: "main", proforma_invoice: "main", sales_invoice: "main",
	customs_declaration: "cd", cd_invoice: "cdInvoice", shipping_invoice: "shipping", attachment: "attachment",
	waybill: "attachment", supplier_quotation: "quotation"
};
/* The supplier on a customs declaration is the customs authority, whoever the exporter or declarant is
   (it is matched to the closest Supplier in ERPNext). */
var CUSTOMS_AUTHORITY = "Muitinės departamentas prie Lietuvos Respublikos finansų ministerijos";
/* Best guess only — the review form leaves this editable so the employee
   can fix it against whatever naming series ERPNext actually has set up. */
var NAMING_GUESS = { purchase_invoice: "PURCHASE-", proforma_invoice: "PURCHASE-", sales_invoice: "SALES-" };
var SERIES_GUESSES = ["PURCHASE-", "SALES-", "PROFORMA-"];

var state = { dataUrl: null, fileName: "", supplierLink: "", customerLink: "", kind: "pdf", run: 0,
	refs: [], poMatched: null, poUnmatched: null, attachmentKind: "", liveDone: false };
/* similar customers matched at or above this score (or sharing a registration / tax ID)
   are picked automatically; anything lower is offered for the employee to choose */
var AUTO_PICK = 0.80;
var PICK_LABEL = "Choose a PDF or picture", PHOTO_LABEL = "Take a photo";

function kindOf(dataUrl) { return /^data:image\//i.test(dataUrl || "") ? "image" : "pdf"; }

function settings() { return (window.CS && window.CS.settings()) || {}; }
function section() { return SECTION_FOR[$("d-type").value] || "main"; }

/* A document WE issue (a sales invoice, or a proforma the employee says is ours) names a
   customer, not a supplier. */
function salesMode() {
	var t = $("d-type").value;
	return t === "sales_invoice" || (t === "proforma_invoice" && $("d-direction").value === "out");
}
function seriesGuess() {
	var t = $("d-type").value;
	if (t === "sales_invoice") return "SALES-";
	if (t === "proforma_invoice") return "PROFORMA-";
	return NAMING_GUESS[t] || "PURCHASE-";
}

var filling = false;   /* true while fillFromExtraction runs: the new-flow panel is refreshed once, at its end */

function updateTypeUi() {
	var t = $("d-type").value, sec = SECTION_FOR[t];
	var att = sec === "attachment", quo = sec === "quotation";
	if (t === "waybill") state.attachmentKind = "waybill";
	else if (t !== "attachment" && !att) state.attachmentKind = state.attachmentKind === "waybill" ? "" : state.attachmentKind;
	$("d-row-main-extra").style.display = sec === "main" ? "" : "none";
	var sales = salesMode();
	$("d-row-direction").style.display = t === "proforma_invoice" ? "" : "none";
	$("d-row-po").style.display = (sec === "main" && !sales) ? "" : "none";
	$("d-row-sales").style.display = (sec === "main" && sales) ? "" : "none";
	$("d-box-supplier").style.display = (sales || att) ? "none" : "";
	$("d-box-customer").style.display = (sales && !att) ? "" : "none";
	$("d-row-parent").style.display = (sec === "main" || quo) ? "none" : "";
	$("d-parent-title").textContent = att ? "File it under this record" : "Parent record";
	var cur = $("d-naming_series").value;
	if (sec === "main" && (!cur || SERIES_GUESSES.indexOf(cur) >= 0)) {
		$("d-naming_series").value = seriesGuess();
	}
	if (sec === "cd" && !$("d-supplier_name").value) {
		$("d-supplier_name").value = CUSTOMS_AUTHORITY;
		checkSupplier();
	}
	if (sec !== "main" && !quo) loadParentCandidates();
	if (window.CS_NEWUI) window.CS_NEWUI.update(t, state.attachmentKind, filling);
	if (window.CS_REVIEW) window.CS_REVIEW.refresh();
}

function resetForm(keepStatus) {
	["document_no", "document_date", "payment_due_date", "naming_series",
		"purchase_order_reference", "sales_invoice_reference", "supplier_name",
		"supplier_reg_number", "supplier_tax_id", "customer_name", "customer_reg_number", "customer_tax_id",
		"currency", "total_amount"].forEach(function (k) {
		var el = $("d-" + k);
		if (el) el.value = "";
	});
	$("d-parent-manual").value = "";
	$("d-direction").value = "in";
	$("d-po-status").textContent = ""; $("d-sales-status").textContent = "";
	$("d-purchase_order_reference").classList.remove("warn"); $("d-sales_invoice_reference").classList.remove("warn");
	$("d-warn").innerHTML = "";
	$("d-dupe-box").innerHTML = "";
	$("d-cust-box").innerHTML = "";
	$("d-issuer-note").textContent = "";
	$("d-notes").textContent = "";
	if (!keepStatus) $("d-stat").innerHTML = "";
	$("d-parent").innerHTML = "";
	$("d-parent-hint").textContent = "";
	$("d-file-name").textContent = "";
	state.dataUrl = null; state.fileName = ""; state.supplierLink = ""; state.customerLink = ""; state.kind = "pdf"; state.run++;
	state.refs = []; state.poMatched = null; state.poUnmatched = null; state.attachmentKind = ""; state.liveDone = false;
	if (window.CS_NEWUI) window.CS_NEWUI.reset();
	if (window.CS_REVIEW) window.CS_REVIEW.reset();
	if (window.CS_DOCVIEW) window.CS_DOCVIEW.clear();
	$("d-viewcard").style.display = "none";
	$("d-preview").style.display = "none"; $("d-preview").removeAttribute("src");
	$("box-doc-form").style.display = "none";
}

function code() {
	var tax = $("d-supplier_tax_id").value.trim(), reg = $("d-supplier_reg_number").value.trim();
	/* prefer the tax/VAT ID when both are read off the document — it tends
	   to be quoted more consistently across a supplier's own documents than
	   a registration number is */
	return tax || reg;
}

function customerCode() {
	return $("d-customer_tax_id").value.trim() || $("d-customer_reg_number").value.trim();
}

function readFields() {
	var sales = salesMode();
	var poList = poValues();
	var salesRef = $("d-sales_invoice_reference").value.trim() || (sales ? $("d-document_no").value.trim() : "");
	return {
		documentNo: $("d-document_no").value.trim(),
		documentDate: $("d-document_date").value.trim(),
		paymentDueDate: $("d-payment_due_date").value.trim(),
		namingSeries: $("d-naming_series").value.trim(),
		purchaseOrderReference: sales ? "" : poList.join(", "),
		poMatched: sales ? null : state.poMatched,
		poUnmatched: sales ? null : state.poUnmatched,
		salesInvoiceReference: sales ? salesRef : "",
		references: state.refs.slice(),
		supplierName: sales ? "" : $("d-supplier_name").value.trim(),
		supplierCode: sales ? "" : code(),
		supplierLink: sales ? "" : state.supplierLink,
		customerName: sales ? $("d-customer_name").value.trim() : "",
		customerLink: sales ? state.customerLink : "",
		reviewNote: window.CS_REVIEW ? window.CS_REVIEW.text() : ""
	};
}

/* ------------------------------------------------------- duplicate supplier */

function checkSupplier() {
	var name = $("d-supplier_name").value.trim();
	state.supplierLink = "";
	$("d-dupe-box").innerHTML = "";
	if (!name || !window.CS_ACC || salesMode()) return;
	var c = code();
	window.CS_ACC.findExactSupplier(name).then(function (exact) {
		if (exact) { state.supplierLink = exact; return; }
		return window.CS_ACC.findSupplierMatches(name, c, 0.55).then(function (matches) {
			if (!matches.length) return;
			var sure = window.CS_ACC.confidentSupplier(matches);
			if (sure) {
				state.supplierLink = sure;
				$("d-dupe-box").innerHTML = '<p class="hint" style="color:#1f8a4c">Linked to existing supplier ' +
					esc(sure) + " (same company apart from spelling or legal form).</p>";
				return;
			}
			var html = '<p class="hint" style="color:var(--violet)">Possible existing supplier' +
				(matches.length > 1 ? "s" : "") +
				" — pick one to avoid creating a duplicate, or leave it if this is genuinely new:</p>";
			matches.forEach(function (m) {
				html += '<div class="row" style="align-items:center;margin-bottom:6px">' +
					'<span class="hint" style="margin:0">' + esc(m.supplier.supplier_name) +
					(m.codeMatch ? " (same registration/tax ID)" : " — " + Math.round(m.score * 100) + "% match") +
					"</span>" +
					'<button class="b sec" style="margin:0" data-use="' + esc(m.supplier.name) + '">Use this</button>' +
					"</div>";
			});
			$("d-dupe-box").innerHTML = html;
			Array.prototype.forEach.call($("d-dupe-box").querySelectorAll("[data-use]"), function (btn) {
				btn.onclick = function () {
					state.supplierLink = btn.dataset.use;
					$("d-dupe-box").innerHTML = '<p class="hint" style="color:#1f8a4c">Linked to existing supplier ' +
						esc(btn.dataset.use) + ".</p>";
				};
			});
		});
	}).catch(function () { /* a failed duplicate-check shouldn't block manual entry */ });
}

/* ------------------------------------------------- PO and invoice checks */

function normPo(v) {
	return window.CS_ACC && window.CS_ACC._internals && window.CS_ACC._internals.normPo
		? window.CS_ACC._internals.normPo(v) : String(v || "").trim();
}
function poValues() {
	return $("d-purchase_order_reference").value.split(/[,;]/).map(function (v) { return normPo(v); }).filter(Boolean);
}

/* Is the PO printed on the document a Purchase Order in ERPNext? ("PO:08353" is read as PO-08353.)
   A PO that cannot be matched is highlighted for the logistics specialist, left out of the record's PO
   link and noted in its comment — never silently dropped. Same for a sales invoice number on a sale. */
function checkRefs() {
	var token = state.run, sales = salesMode();
	var po = sales ? [] : poValues(), si = sales ? ($("d-sales_invoice_reference").value.trim() || $("d-document_no").value.trim()) : "";
	var poBox = $("d-purchase_order_reference"), poNote = $("d-po-status"), siBox = $("d-sales_invoice_reference"), siNote = $("d-sales-status");
	state.poMatched = null; state.poUnmatched = null;
	poBox.classList.remove("warn"); poNote.textContent = ""; poNote.classList.remove("warntext");
	siBox.classList.remove("warn"); siNote.textContent = ""; siNote.classList.remove("warntext");
	if (section() !== "main") return;
	if (!sales && !po.length) {
		if (document.getElementById("d-row-po").style.display !== "none") {
			poBox.classList.add("warn"); poNote.classList.add("warntext");
			poNote.textContent = "No PO number found on the document — search for the purchase order and enter it.";
		}
		return;
	}
	if (!window.CS_ACC || !window.CS_ACC.checkReferences || !window.CS_ERP || (window.CS_ERP.ready && window.CS_ERP.ready())) return;
	window.CS_ACC.checkReferences(po, si).then(function (r) {
		if (token !== state.run) return;
		if (po.length) {
			var ok = po.filter(function (p) { return r.po[p] === true; });
			var bad = po.filter(function (p) { return r.po[p] === false; });
			if (bad.length) {
				state.poMatched = ok; state.poUnmatched = bad;
				poBox.classList.add("warn"); poNote.classList.add("warntext");
				poNote.textContent = bad.join(", ") + " is not a Purchase Order in ERPNext — it will not be linked. " +
					"Search for the right PO and type it here; a note is also left in the record's comment.";
			} else if (ok.length) {
				state.poMatched = ok; state.poUnmatched = [];
				poNote.textContent = ok.join(", ") + " found in ERPNext.";
			}
		}
		if (si && r.salesInvoice === false) {
			siBox.classList.add("warn"); siNote.classList.add("warntext");
			siNote.textContent = si + " is not a Sales Invoice in ERPNext — check the number.";
		} else if (si && r.salesInvoice === true) {
			siNote.textContent = si + " found in ERPNext.";
		}
	}).catch(function () { /* checking is a courtesy; never block the form */ });
}

/* ------------------------------------------------------- similar customer */

function customerCodes() {
	return [$("d-customer_tax_id").value.trim(), $("d-customer_reg_number").value.trim()].filter(Boolean);
}

function showCustomerLinked(name, how) {
	state.customerLink = name;
	var box = $("d-cust-box");
	box.innerHTML = '<p class="hint" style="color:#1f8a4c">Customer in ERPNext: <b>' + esc(name) + "</b>" +
		(how ? " — " + esc(how) : "") + ' <a href="#" id="d-cust-change">change</a></p>';
	$("d-cust-change").onclick = function (ev) { ev.preventDefault(); checkCustomer(true); };
}

/* Reads the customer off the document and picks the most similar customer in ERPNext:
   automatically when the registration / tax ID matches or the name is a near-certain
   match, otherwise by showing the closest few for the employee to choose. */
function checkCustomer(forceList) {
	var name = $("d-customer_name").value.trim();
	state.customerLink = "";
	$("d-cust-box").innerHTML = "";
	if (!name || !window.CS_ACC || !salesMode()) return;
	var token = state.run;
	window.CS_ACC.findCustomerMatches(name, customerCodes(), 0.45).then(function (matches) {
		if (token !== state.run || !salesMode()) return;
		if (!matches.length) {
			$("d-cust-box").innerHTML = note("No similar customer found in ERPNext — the Customer field will be left empty " +
				"unless a customer with exactly this name exists. Add the customer in ERPNext first if it is new.", "var(--violet)");
			return;
		}
		var top = matches[0], second = matches[1];
		var sure = top.codeMatch || (top.score >= AUTO_PICK && (!second || top.score - second.score >= 0.05));
		if (sure && !forceList) {
			showCustomerLinked(top.customer.name, top.codeMatch ? "same registration/tax ID"
				: Math.round(top.score * 100) + "% name match");
			return;
		}
		var html = '<p class="hint" style="color:var(--violet)">Most similar customers in ERPNext — pick the right one:</p>';
		matches.forEach(function (m) {
			html += '<div class="row" style="align-items:center;margin-bottom:6px">' +
				'<span class="hint" style="margin:0">' + esc(m.customer.customer_name || m.customer.name) +
				(m.codeMatch ? " (same registration/tax ID)" : " — " + Math.round(m.score * 100) + "% match") + "</span>" +
				'<button class="b sec" style="margin:0" data-cust="' + esc(m.customer.name) + '">Use this</button></div>';
		});
		$("d-cust-box").innerHTML = html;
		Array.prototype.forEach.call($("d-cust-box").querySelectorAll("[data-cust]"), function (btn) {
			btn.onclick = function () { showCustomerLinked(btn.dataset.cust, "chosen by you"); };
		});
	}).catch(function () { /* a failed lookup shouldn't block manual entry */ });
}

/* ---------------------------------------------------------- parent document */

function loadParentCandidates() {
	if (!$("d-parent")) return;
	if (!window.CS_ACC) return;
	var f = readFields();
	if (!f.supplierName && !f.documentDate && !f.references.length && !f.documentNo) {
		$("d-parent").innerHTML = '<option value="">— fill in a reference number, the supplier or the date first —</option>';
		return;
	}
	$("d-parent").innerHTML = '<option value="">— searching… —</option>';
	$("d-parent-hint").textContent = "";
	window.CS_ACC.suggestParents(f).then(function (cands) {
		if (!cands.length) {
			$("d-parent").innerHTML = '<option value="">— no likely match found —</option>';
			$("d-parent-hint").textContent = "Enter the exact Accounts Document ID below if you know it.";
			return;
		}
		$("d-parent").innerHTML = '<option value="">— pick the matching record —</option>' +
			cands.map(function (c) {
				return '<option value="' + esc(c.name) + '">' + esc(c.document_no || c.name) + " — " +
					esc(c.supplier || "") + " — " + esc(c.document_date || "") + (c.series ? " — " + esc(c.series) : "") +
					(c.exact ? " (shared number)" : " (" + Math.round(c.score * 100) + "%)") + "</option>";
			}).join("");
		if (cands[0].exact) $("d-parent").value = cands[0].name;
		$("d-parent-hint").textContent = cands[0].reasons && cands[0].reasons.length
			? "Best match because: " + cands[0].reasons.join(", ") + "." : "";
	}).catch(function (e) {
		$("d-parent").innerHTML = '<option value="">— could not search —</option>';
		$("d-parent-hint").textContent = e.message || String(e);
	});
}

/* ------------------------------------------------------------- PDF + extract */

/* The attached document is shown for the manual review: always open beside the form on the desktop apps,
   behind "Show the document" on the phones (drawn when it is opened). */
function desktop() { return document.documentElement.className.indexOf("desktop") >= 0; }
function showViewer() {
	var card = $("d-viewcard");
	card.style.display = "";
	if (window.CS_DOCVIEW) window.CS_DOCVIEW.show(state.dataUrl, state.kind);
	if (desktop()) card.open = true;
	if (window.CS_DOCVIEW) window.CS_DOCVIEW.setVisible(card.open);
}

function acceptFile(dataUrl, name) {
	state.dataUrl = dataUrl;
	state.kind = kindOf(dataUrl);
	state.fileName = name || ("document-" + Date.now() + (state.kind === "image" ? ".jpg" : ".pdf"));
	$("d-file-name").textContent = state.fileName;
	if (state.kind === "image") { $("d-preview").src = dataUrl; $("d-preview").style.display = ""; }
	else { $("d-preview").style.display = "none"; $("d-preview").removeAttribute("src"); }
	$("box-doc-form").style.display = "";
	showViewer();
	updateTypeUi();
	runExtraction();
}

/* The shells answer window.onDocPicked({ok, name, dataUrl?, error}). Android keeps
   a multi-megabyte file out of that call and hands it over through
   readPickedDocument() instead. */
function handleDocPicked(r) {
	busy($("btn-doc-pick"), false, PICK_LABEL);
	busy($("btn-doc-photo"), false, PHOTO_LABEL);
	if (!r || !r.ok) {
		$("d-file-name").textContent = (r && r.error) || "No file chosen.";
		return;
	}
	var data = r.dataUrl || "";
	if (!data && window.Android && typeof window.Android.readPickedDocument === "function") {
		data = window.Android.readPickedDocument() || "";
	}
	if (!data) { $("d-file-name").textContent = "The file could not be read."; return; }
	acceptFile(data, r.name);
}
window.onDocPicked = handleDocPicked;

var FIELD_KEYS = ["doc_type", "document_no", "document_date", "payment_due_date", "supplier_name",
	"supplier_reg_number", "supplier_tax_id", "customer_name", "customer_reg_number", "customer_tax_id",
	"purchase_order_reference", "currency", "total_amount", "attachment_kind", "tracking_number", "valid_until"];

function has(v) { return v !== undefined && v !== null && v !== ""; }

/* AI answer first, built-in reader as the fallback for whatever the AI left empty —
   plus guards for the AI's known mistakes: naming the buyer (us) as supplier, and mixing
   up which side issued the document. Documents issued by Integrated Optics UAB or
   IO Integrated Optics GmbH (intercompany included) are sales documents whose customer
   is the other party; there is then no supplier. */
function mergeFields(rules, ai) {
	var out = {};
	FIELD_KEYS.forEach(function (k) {
		out[k] = has(ai && ai[k]) ? ai[k] : (has(rules && rules[k]) ? rules[k] : null);
	});
	var R = window.CS_RULES, notes = [];
	if (ai && has(ai.notes)) notes.push(ai.notes);
	var rulesOurs = !!(rules && rules.issuer_is_ours);
	var ours = ai && typeof ai.issuer_is_ours === "boolean" ? ai.issuer_is_ours : rulesOurs;
	if (!ours && has(out.supplier_name) && R.isUabName(out.supplier_name) && rulesOurs) ours = true;

	if (ours) {
		/* we are the issuer: the customer is the other party */
		var issuerEntity = "UAB";
		var cust = {
			name: has(ai && ai.customer_name) ? ai.customer_name : null,
			reg: ai && ai.customer_reg_number, tax: ai && ai.customer_tax_id
		};
		var sameAsIssuer = has(cust.name) && issuerEntity && R.ownEntity(cust.name) === issuerEntity;
		if (!has(cust.name) || sameAsIssuer) {
			if (rules && has(rules.customer_name)) {
				out.customer_name = rules.customer_name;
				out.customer_reg_number = rules.customer_reg_number;
				out.customer_tax_id = rules.customer_tax_id;
			} else if (!has(cust.name) && has(ai && ai.supplier_name) && !R.isUabName(ai.supplier_name)) {
				/* the AI put the other party in the supplier slot */
				out.customer_name = ai.supplier_name;
				out.customer_reg_number = ai.supplier_reg_number || null;
				out.customer_tax_id = ai.supplier_tax_id || null;
			} else if (sameAsIssuer) {
				out.customer_name = null; out.customer_reg_number = null; out.customer_tax_id = null;
				notes.push("the customer could not be told apart from the issuer — enter it by hand");
			}
		}
		out.supplier_name = null; out.supplier_reg_number = null; out.supplier_tax_id = null;
		if (!out.doc_type || out.doc_type === "purchase_invoice") out.doc_type = "sales_invoice";
		/* codes printed for the issuer must not be mistaken for the customer's */
		if (has(out.customer_reg_number) && R.isOwnCode(out.customer_reg_number) && !R.ownEntity(out.customer_name || "")) {
			out.customer_reg_number = null;
		}
		if (has(out.customer_tax_id) && R.isOwnCode(out.customer_tax_id) && !R.ownEntity(out.customer_name || "")) {
			out.customer_tax_id = null;
		}
		out.issuer_is_ours = true;
	} else {
		out.customer_name = null; out.customer_reg_number = null; out.customer_tax_id = null;
		if (out.doc_type === "sales_invoice") out.doc_type = "purchase_invoice";
		if (has(out.supplier_name) && R.isUabName(out.supplier_name)) {
			if (rules && has(rules.supplier_name) && !R.isUabName(rules.supplier_name)) {
				out.supplier_name = rules.supplier_name;
				out.supplier_reg_number = rules.supplier_reg_number;
				out.supplier_tax_id = rules.supplier_tax_id;
				notes.push("the AI named our own company (UAB) as supplier — replaced by the seller found by the built-in reader");
			} else {
				out.supplier_name = null; out.supplier_reg_number = null; out.supplier_tax_id = null;
				notes.push("the document names only our own company — enter the supplier by hand");
			}
		}
		if (has(out.supplier_reg_number) && R.isOwnCode(out.supplier_reg_number)) {
			out.supplier_reg_number = rules && has(rules.supplier_reg_number) && !R.isOwnCode(rules.supplier_reg_number)
				? rules.supplier_reg_number : null;
		}
		if (has(out.supplier_tax_id) && R.isOwnCode(out.supplier_tax_id)) {
			out.supplier_tax_id = rules && has(rules.supplier_tax_id) && !R.isOwnCode(rules.supplier_tax_id)
				? rules.supplier_tax_id : null;
		}
		out.issuer_is_ours = false;
	}
	out.issuer_entity = ours ? ((rules && rules.issuer_entity) || "") : "";
	/* numbers that tie the document to others: the union of what both readers found */
	var refs = [];
	[(rules && rules.related_references) || [], (ai && ai.related_references) || []].forEach(function (list) {
		(Array.isArray(list) ? list : []).forEach(function (r) {
			r = String(r || "").trim();
			if (r && refs.map(function (x) { return x.toUpperCase(); }).indexOf(r.toUpperCase()) < 0) refs.push(r);
		});
	});
	out.related_references = refs;
	out.lines = Array.isArray(ai && ai.lines) ? ai.lines : [];
	out.charges = Array.isArray(ai && ai.charges) ? ai.charges : [];
	if (out.doc_type === "attachment") {
		out.supplier_name = null; out.supplier_reg_number = null; out.supplier_tax_id = null;
		out.customer_name = null; out.customer_reg_number = null; out.customer_tax_id = null;
	}
	out.confidence = ai && typeof ai.confidence === "number" ? ai.confidence : (rules ? rules.confidence : 0);
	out.language = (ai && ai.language) || (rules && rules.language) || "";
	out.notes = notes.join("; ");
	return out;
}

/* `soft`: the reading came from the built-in rules, so it must not override a type
   the employee picked on purpose (e.g. Customs Declaration Invoice) with a generic
   "invoice" guess. */
function fillFromExtraction(x, soft) {
	if (!x) return;
	var main = { purchase_invoice: 1, proforma_invoice: 1, sales_invoice: 1 };
	if (x.doc_type && DOC_TYPE_LABELS[x.doc_type] && x.doc_type !== $("d-type").value &&
		!(soft && main[x.doc_type] && !main[$("d-type").value])) {
		$("d-type").value = x.doc_type;
	}
	if ($("d-type").value === "attachment" && x.attachment_kind === "waybill") $("d-type").value = "waybill";
	/* a proforma carries its direction in who issued it; the type itself says nothing */
	$("d-direction").value = x.issuer_is_ours ? "out" : "in";
	state.refs = Array.isArray(x.related_references) ? x.related_references.slice() : [];
	state.attachmentKind = x.attachment_kind || "";
	$("d-supplier_name").value = "";
	if (window.CS_NEWUI) window.CS_NEWUI.setExtraction(x);
	filling = true;
	try { updateTypeUi(); } finally { filling = false; }
	$("d-document_no").value = x.document_no || "";
	$("d-document_date").value = x.document_date || "";
	$("d-payment_due_date").value = x.payment_due_date || "";
	$("d-purchase_order_reference").value = x.purchase_order_reference || "";
	$("d-supplier_name").value = x.supplier_name || "";
	$("d-supplier_reg_number").value = x.supplier_reg_number || "";
	$("d-supplier_tax_id").value = x.supplier_tax_id || "";
	$("d-customer_name").value = x.customer_name || "";
	$("d-customer_reg_number").value = x.customer_reg_number || "";
	$("d-customer_tax_id").value = x.customer_tax_id || "";
	$("d-currency").value = x.currency || "";
	$("d-total_amount").value = (x.total_amount === undefined || x.total_amount === null) ? "" : x.total_amount;
	var notes = [];
	if (x.language) notes.push("language: " + ({ lt: "Lithuanian", de: "German", en: "English" }[x.language] || x.language));
	if (typeof x.confidence === "number") notes.push("confidence: " + Math.round(x.confidence * 100) + "%");
	if (x.notes) notes.push(x.notes);
	if (section() === "cd") {                                  // the customs authority, whoever declared the goods
		$("d-supplier_name").value = CUSTOMS_AUTHORITY;
		$("d-supplier_reg_number").value = ""; $("d-supplier_tax_id").value = "";
	}
	if (salesMode() && !$("d-sales_invoice_reference").value) $("d-sales_invoice_reference").value = x.document_no || "";
	if (section() === "attachment" && state.attachmentKind) {
		notes.push({ waybill: "waybill / label", payment_order: "payment order", other: "supporting paper" }[state.attachmentKind] || "attachment");
	}
	$("d-notes").textContent = notes.join(" — ");
	$("d-issuer-note").textContent = x.issuer_is_ours
		? "Issued by Integrated Optics UAB" +
			(/integrated optics/i.test(x.customer_name || "") ? " — an intercompany sale to the GmbH." : ".")
		: "";
	checkSupplier();
	checkCustomer();
	checkRefs();
	if (section() !== "main" && section() !== "quotation") loadParentCandidates();
	if (window.CS_NEWUI) window.CS_NEWUI.update($("d-type").value, state.attachmentKind);
}

function note(text, color) {
	return '<p class="hint"' + (color ? ' style="color:' + color + '"' : "") + ">" + esc(text) + "</p>";
}

/* 1. PDF text (pdf.js)  2. built-in EN/LT/DE reader fills the form at once
   3. with an Anthropic key: the AI reads the text — or, for a scan, a photo or a
   PDF without a usable text layer, the file itself — and its answer is merged in. */
function runExtraction() {
	if (!state.dataUrl) return;
	var key = settings().extract_key || "";
	var workspace = settings().extract_workspace || "";
	var hint = $("d-type").value;
	var token = ++state.run;
	function live() { return token === state.run; }
	function warn(html) { if (live()) $("d-warn").innerHTML = html; }

	var step;
	if (state.kind === "pdf") {
		warn(note("Reading the PDF…"));
		step = window.CS_PDF.extractText(state.dataUrl).then(
			function (res) { return { text: res.text, err: "" }; },
			function (e) { return { text: "", err: e.message || String(e) }; });
	} else {
		step = Promise.resolve({ text: "", err: "" });
	}

	return step.then(function (r) {
		if (!live()) return;
		var good = window.CS_RULES.textQuality(r.text).ok;
		var rules = good ? window.CS_RULES.parse(r.text, hint) : null;
		if (rules) fillFromExtraction(rules, true);
		/* photo, scan, unreadable text layer — or a FORM (customs declaration, courier label, payment order),
		   whose text comes out with all the captions first and the values apart: the AI reads those as a picture */
		var visual = !good || !!(rules && rules.needs_file);

		if (!key) {
			if (rules && rules.needs_file) {
				warn(note("This is a form (customs declaration, label or payment order): only its numbers could be read here. " +
					"Add an Anthropic key under Settings to have the AI read the whole form, or fill in the fields by hand.", "var(--violet)"));
			} else if (rules) {
				warn(note("Filled in by the built-in reader (English, Lithuanian, German) — check every field. " +
					"Add an Anthropic key under Settings for the AI model to read it as well.", "var(--violet)"));
			} else if (state.kind === "image") {
				warn(note("A picture can only be read with an Anthropic key (Settings). Fill in the fields by hand below."));
			} else {
				warn(note((r.err ? r.err + " " : "This PDF has no readable text (it may be a scan). ") +
					"Add an Anthropic key under Settings to have it read as a picture, or fill in the fields by hand below."));
			}
			return;
		}

		/* a PDF always goes as the file itself (with its text layer beside it): the AI sees the page, so it can
		   tell side-by-side seller / buyer columns apart, which flat text cannot show */
		var withFile = visual || state.kind === "pdf";
		var aiSettings = { key: key, workspace: workspace };
		warn(note(withFile ? "Sending the " + (state.kind === "image" ? "picture" : "PDF") + " to the AI model to read…"
			: "Asking the AI model to read the fields…"));
		var call = withFile
			? window.CS_EXTRACT.extractFromFile(state.dataUrl, aiSettings, hint, good ? r.text : "")
			: window.CS_EXTRACT.extractFields(r.text, aiSettings, hint);
		if (withFile && !visual && good) {
			/* the file could not be sent (too big, rejected): fall back to the text */
			call = call.catch(function () { return window.CS_EXTRACT.extractFields(r.text, aiSettings, hint); });
		}
		return call.then(function (x) {
			if (!live()) return;
			fillFromExtraction(mergeFields(rules, x.fields), false);
			warn("");
		}, function (e) {
			warn(note((e.message || String(e)) + (rules
				? " — showing what the built-in reader found; check every field."
				: " — fill in the fields by hand below."), "var(--err)"));
		});
	});
}

/* ------------------------------------------------------------------ approve */

function stat(html) { $("d-stat").innerHTML = html; }
function errP(msg) { return '<p class="hint" style="color:var(--err)">' + esc(msg) + "</p>"; }

/* why the live (Accounts Document) send cannot start, or "" */
function liveProblem(sec, f, sales) {
	var bad = window.CS_ERP.ready();
	if (sec === "attachment") {
		if (bad) return bad;
		var parent0 = $("d-parent-manual").value.trim() || $("d-parent").value;
		return parent0 ? "" : "Pick or enter the record to file this under first.";
	}
	if (!f.documentNo || !f.documentDate || !(sales ? f.customerName : f.supplierName)) {
		return "Document no., date and " + (sales ? "customer" : "supplier") + " name are required.";
	}
	if (bad) return bad;
	if (sec !== "main" && !($("d-parent-manual").value.trim() || $("d-parent").value)) {
		return "Pick or enter the parent purchase document first.";
	}
	return "";
}

/* The live send: an Accounts Document on the live server, exactly as before. Resolves { ok, name, lines }; never rejects. */
function sendLive(t, sec, f) {
	var lines = [];
	function fail(e) {
		var msg = (e && e.errors && e.errors.length && e.errors.map(function (x) { return x.message; }).join(" ")) ||
			(e && e.message) || String(e);
		return { ok: false, lines: [errP(msg)], error: msg };
		}
	if (sec === "attachment") {
		var parent0 = $("d-parent-manual").value.trim() || $("d-parent").value;
		var kindLabel = { waybill: "Waybill / courier label", payment_order: "Payment order", other: "Supporting paper" }[state.attachmentKind] || "Supporting paper";
		return window.CS_ACC.attachToParent(parent0, state.dataUrl, state.fileName, kindLabel + (state.fileName ? " \u2014 " + state.fileName : "")).then(function (res) {
			var ok = res.file && res.file.state === "created";
			return ok
				? { ok: true, name: res.name, lines: ['<p class="hint" style="color:#1f8a4c">Saved as <b>' + esc(res.name) + "</b>, a child of <b>" + esc(res.parent || parent0) + ".</b></p>"] }
				: (function () {
					var why = "The file could not be attached: " + ((res.file && res.file.errors && res.file.errors[0] && res.file.errors[0].message) || "unknown error");
					return { ok: false, lines: [errP(why)], error: why, name: res.name };
				})();
		}).catch(fail);
	}
	var parentName = "";
	if (sec !== "main") parentName = $("d-parent-manual").value.trim() || $("d-parent").value;
	var task = sec === "main"
		? window.CS_ACC.createMain(f, state.dataUrl, state.fileName)
		: window.CS_ACC.createChild(sec, parentName, f, state.dataUrl, state.fileName);
	return task.then(function (res) {
		lines.push('<p class="hint" style="color:#1f8a4c">Saved as <b>' + esc(res.name) + "</b> (" +
			esc(DOC_TYPE_LABELS[t]) + (res.parent ? ", a child of <b>" + esc(res.parent) + "</b>" : ", parent document") + ").</p>");
		if (res.file && res.file.state === "created") {
			lines.push('<p class="hint" style="color:#1f8a4c">File attached.</p>');
		} else if (res.file && res.file.state === "error") {
			lines.push('<p class="hint" style="color:var(--err)">The file could not be attached: ' +
				esc((res.file.errors && res.file.errors[0] && res.file.errors[0].message) || "") + "</p>");
		}
		(res.notes || []).forEach(function (n) { lines.push('<p class="hint">' + esc(n.message) + "</p>"); });
		var fileErr = res.file && res.file.state === "error" ? "The file could not be attached: " + ((res.file.errors && res.file.errors[0] && res.file.errors[0].message) || "") : "";
		return { ok: true, name: res.name, lines: lines, notes: (res.notes || []).map(function (n) { return n.message; }), error: fileErr };
	}).catch(fail);
}

/* Approve: the live server (Accounts Document, the old way) and/or the test server (the new doctypes), as the two
   switches say. The live part runs first and is never repeated: if the test server then fails, the form stays so the
   test send can be retried on its own. */
function approve() {
	var t = $("d-type").value, sec = SECTION_FOR[t];
	var f = readFields();
	var sales = salesMode();
	var NU = window.CS_NEWUI;
	var tg = NU ? NU.targets(t, state.attachmentKind) : { live: sec !== "quotation", test: false, why: "" };
	if (!tg.live && !tg.test) { stat(errP(tg.why || "Nothing to send.")); return; }
	if (!state.dataUrl) { stat(errP("Choose, photograph or scan the document first.")); return; }
	var live = tg.live && !state.liveDone;
	var bad = live ? liveProblem(sec, f, sales) : "";
	if (!bad && tg.test) bad = NU.problem(t, state.attachmentKind, f);
	if (bad) { stat(errP(bad)); return; }

	busy($("btn-doc-approve"), true, "Sending\u2026");
	stat("");
	var both = tg.live && tg.test;
	var out = [];
	function head(label) { return both ? '<p class="hint"><b>' + label + "</b></p>" : ""; }
	var rec = { type: DOC_TYPE_LABELS[t] || t, docNo: f.documentNo || "", supplier: f.supplierName || f.customerName || "", file: state.fileName || "", results: [] };
	var rv = window.CS_REVIEW ? window.CS_REVIEW.value() : null;
	if (rv) rec.review = rv;
	var stage = "Live";
	function logResult(server, r) {
		if (!r) return;
		rec.results.push({ server: server, ok: !!r.ok && !r.error, name: r.name || "", message: r.error || "", notes: r.notes || [] });
	}
	function logged() { if (window.CS_HISTORY && rec.results.length) window.CS_HISTORY.record(rec); }
	var step = live ? sendLive(t, sec, f) : Promise.resolve(null);
	step.then(function (lr) {
	logResult("Live", lr);
	if (lr) {
			out.push(head("Live server"));
			out = out.concat(lr.lines);
			if (lr.ok) { state.liveDone = true; if (both) $("d-send-live").checked = false; }
		} else if (tg.live && state.liveDone) {
			out.push('<p class="hint">The live server already has this document \u2014 not sent again.</p>');
		}
		if (!tg.test) return { ok: !lr || lr.ok };
		if (lr && !lr.ok) {
			out.push('<p class="hint warntext">Not sent to the test server because the live send failed.</p>');
			rec.results.push({ server: "Test", skipped: true, message: "the live send failed" });
			return { ok: false };
			}
			out.push(head("Test server"));
			stage = "Test";
			return NU.send(t, state.attachmentKind, f, { dataUrl: state.dataUrl, name: state.fileName }).then(function (r) {
			out = out.concat(r.lines);
			logResult("Test", r);
			return { ok: r.ok };
			});
	}).then(function (res) {
	logged();
	busy($("btn-doc-approve"), false, "Approve & send to ERPNext");
	stat(out.join(""));
	if (res.ok) resetForm(true);
	}).catch(function (e) {
	rec.results.push({ server: stage, ok: false, message: (e && e.message) || String(e) });
	logged();
	busy($("btn-doc-approve"), false, "Approve & send to ERPNext");
	stat(out.join("") + errP((e && e.message) || String(e)));
	});
}

/* ------------------------------------------------------ duplicate suppliers */

function scanDuplicateSuppliers() {
	var box = $("d-dupe-scan"), btn = $("btn-dupe-scan");
	if (!window.CS_ACC) return;
	box.innerHTML = '<p class="hint">Scanning…</p>';
	busy(btn, true, "Scanning…");
	window.CS_ERP.shared.getList("Supplier", null, ["name", "supplier_name", "reg_number", "tax_id"], 0)
		.then(function (rows) {
			var nameScore = window.CS_ACC._internals.nameScore;
			var pairs = [];
			for (var i = 0; i < rows.length; i++) {
				for (var j = i + 1; j < rows.length; j++) {
					var s = nameScore(rows[i].supplier_name, rows[i].reg_number || rows[i].tax_id, rows[j]);
					if (s.codeMatch || s.score >= 0.82) {
						pairs.push({ a: rows[i], b: rows[j], score: s.score, codeMatch: s.codeMatch });
					}
				}
			}
			pairs.sort(function (x, y) { return y.score - x.score; });
			busy(btn, false, "Scan supplier list");
			if (!pairs.length) { box.innerHTML = '<p class="hint">No likely duplicates found.</p>'; return; }
			box.innerHTML = pairs.slice(0, 25).map(function (p, idx) {
				return '<div class="row" style="align-items:center;margin-bottom:6px" data-row="' + idx + '">' +
					'<span class="hint" style="margin:0">' + esc(p.a.supplier_name) + " (" + esc(p.a.name) + ") ↔ " +
					esc(p.b.supplier_name) + " (" + esc(p.b.name) + ")" +
					(p.codeMatch ? " — same registration/tax ID" : " — " + Math.round(p.score * 100) + "% name match") +
					"</span>" +
					'<button class="b sec" style="margin:0" data-a="' + esc(p.a.name) + '" data-b="' + esc(p.b.name) +
					'">Merge “' + esc(p.b.name) + '” into “' + esc(p.a.name) + '”</button>' +
					"</div>";
			}).join("");
			Array.prototype.forEach.call(box.querySelectorAll("[data-a]"), function (mbtn) {
				mbtn.onclick = function () {
					var a = mbtn.dataset.a, b = mbtn.dataset.b;
					if (!window.confirm('Merge "' + b + '" into "' + a + '"? This renames the record and moves its ' +
							"linked documents. It cannot be undone.")) return;
					busy(mbtn, true, "Merging…");
					window.CS_ACC.mergeSupplier(b, a).then(function (r) {
						if (r.ok) {
							mbtn.parentNode.outerHTML = '<p class="hint" style="color:#1f8a4c">Merged ' +
								esc(b) + " into " + esc(a) + ".</p>";
						} else {
							busy(mbtn, false, "Merge “" + esc(b) + "” into “" + esc(a) + "”");
							var m = (r.errors && r.errors[0] && r.errors[0].message) || "Merge failed.";
							var note = document.createElement("p");
							note.className = "hint"; note.style.color = "var(--err)"; note.textContent = m;
							mbtn.parentNode.appendChild(note);
						}
					});
				};
			});
		}).catch(function (e) {
			busy(btn, false, "Scan supplier list");
			box.innerHTML = '<p class="hint" style="color:var(--err)">' + esc(e.message || String(e)) + "</p>";
		});
}

/* ------------------------------------------------------------------- wiring */

function init() {
	$("d-type").addEventListener("change", function () { updateTypeUi(); checkSupplier(); checkCustomer(); checkRefs(); });
	$("d-direction").addEventListener("change", function () { updateTypeUi(); checkSupplier(); checkCustomer(); checkRefs(); });
	$("d-customer_name").addEventListener("blur", function () { checkCustomer(); });
	$("d-purchase_order_reference").addEventListener("blur", function () { checkRefs(); });
	$("d-sales_invoice_reference").addEventListener("blur", function () { checkRefs(); });
	$("d-document_no").addEventListener("blur", function () { if (salesMode()) checkRefs(); });
	$("d-customer_reg_number").addEventListener("blur", function () { checkCustomer(); });
	$("d-customer_tax_id").addEventListener("blur", function () { checkCustomer(); });
	$("d-supplier_name").addEventListener("blur", checkSupplier);
	$("d-supplier_reg_number").addEventListener("blur", checkSupplier);
	$("d-supplier_tax_id").addEventListener("blur", checkSupplier);
	["d-document_date", "d-purchase_order_reference"].forEach(function (id) {
		$(id).addEventListener("blur", function () { if (section() !== "main") loadParentCandidates(); });
	});

	$("btn-doc-pick").onclick = function () {
		if (window.Android && typeof window.Android.pickDocument === "function") {
			busy($("btn-doc-pick"), true, "Opening\u2026");
			window.Android.pickDocument();
		} else {
			$("d-file-name").textContent = "Choosing a file is not available in this build.";
		}
	};
	$("btn-doc-photo").onclick = function () {
		if (window.Android && typeof window.Android.captureDocument === "function") {
			busy($("btn-doc-photo"), true, "Opening the camera\u2026");
			window.Android.captureDocument();
		} else if (window.CS_CAMERA && window.CS_CAMERA.available()) {
			window.CS_CAMERA.open({ title: "Photograph the document",
				hint: "Lay the page flat, fill the frame, avoid glare and shadows." })
				.then(function (d) { if (d) acceptFile(d, "document-" + Date.now() + ".jpg"); })
				.catch(function (e) { $("d-file-name").textContent = e.message || String(e); });
		} else {
			$("d-file-name").textContent = "No camera is available here.";
		}
	};
	$("btn-doc-photo").style.display =
		((window.Android && typeof window.Android.captureDocument === "function") ||
			(window.CS_CAMERA && window.CS_CAMERA.available())) ? "" : "none";
	$("d-viewcard").addEventListener("toggle", function () {
		if (window.CS_DOCVIEW) window.CS_DOCVIEW.setVisible($("d-viewcard").open);
	});
	if (window.CS_DOCVIEW) window.CS_DOCVIEW.init();
	$("btn-doc-extract").onclick = function () { if (state.dataUrl) runExtraction(); };
	$("btn-doc-cancel").onclick = function () { resetForm(); };
	$("btn-doc-approve").onclick = approve;
	$("btn-dupe-scan").onclick = scanDuplicateSuppliers;
	if (window.CS_NEWUI) window.CS_NEWUI.init();
	if (window.CS_HISTORY) window.CS_HISTORY.init();

	updateTypeUi();
}

function onShow() { /* state persists across tab switches; nothing to repaint on entry */ }

return { init: init, onShow: onShow };
})();
