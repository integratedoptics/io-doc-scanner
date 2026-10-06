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
	cd_invoice: "Customs Declaration Invoice", shipping_invoice: "Shipping Invoice"
};
var SECTION_FOR = {
	purchase_invoice: "main", proforma_invoice: "main", sales_invoice: "main",
	customs_declaration: "cd", cd_invoice: "cdInvoice", shipping_invoice: "shipping"
};
/* Best guess only — the review form leaves this editable so the employee
   can fix it against whatever naming series ERPNext actually has set up. */
var NAMING_GUESS = { purchase_invoice: "PURCHASE-", proforma_invoice: "PURCHASE-", sales_invoice: "SALES-" };
var SERIES_GUESSES = ["PURCHASE-", "SALES-", "PROFORMA-"];

var state = { dataUrl: null, fileName: "", supplierLink: "", customerLink: "", kind: "pdf", run: 0 };
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
	if (t === "proforma_invoice") return salesMode() ? "PROFORMA-" : "PURCHASE-";
	return NAMING_GUESS[t] || "PURCHASE-";
}

function updateTypeUi() {
	var t = $("d-type").value, sec = SECTION_FOR[t];
	$("d-row-main-extra").style.display = sec === "main" ? "" : "none";
	var sales = salesMode();
	$("d-row-direction").style.display = t === "proforma_invoice" ? "" : "none";
	$("d-row-po").style.display = (sec === "main" && !sales) ? "" : "none";
	$("d-row-sales").style.display = (sec === "main" && sales) ? "" : "none";
	$("d-box-supplier").style.display = sales ? "none" : "";
	$("d-box-customer").style.display = sales ? "" : "none";
	$("d-row-parent").style.display = sec === "main" ? "none" : "";
	var cur = $("d-naming_series").value;
	if (sec === "main" && (!cur || SERIES_GUESSES.indexOf(cur) >= 0)) {
		$("d-naming_series").value = seriesGuess();
	}
	if (sec !== "main") loadParentCandidates();
}

function resetForm() {
	["document_no", "document_date", "payment_due_date", "naming_series",
		"purchase_order_reference", "sales_invoice_reference", "supplier_name",
		"supplier_reg_number", "supplier_tax_id", "customer_name", "customer_reg_number", "customer_tax_id",
		"currency", "total_amount"].forEach(function (k) {
		var el = $("d-" + k);
		if (el) el.value = "";
	});
	$("d-parent-manual").value = "";
	$("d-direction").value = "in";
	$("d-warn").innerHTML = "";
	$("d-dupe-box").innerHTML = "";
	$("d-cust-box").innerHTML = "";
	$("d-issuer-note").textContent = "";
	$("d-notes").textContent = "";
	$("d-stat").innerHTML = "";
	$("d-parent").innerHTML = "";
	$("d-parent-hint").textContent = "";
	$("d-file-name").textContent = "";
	state.dataUrl = null; state.fileName = ""; state.supplierLink = ""; state.customerLink = ""; state.kind = "pdf"; state.run++;
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
	return {
		documentNo: $("d-document_no").value.trim(),
		documentDate: $("d-document_date").value.trim(),
		paymentDueDate: $("d-payment_due_date").value.trim(),
		namingSeries: $("d-naming_series").value.trim(),
		purchaseOrderReference: $("d-purchase_order_reference").value.trim(),
		salesInvoiceReference: $("d-sales_invoice_reference").value.trim(),
		supplierName: sales ? "" : $("d-supplier_name").value.trim(),
		supplierCode: sales ? "" : code(),
		supplierLink: sales ? "" : state.supplierLink,
		customerName: sales ? $("d-customer_name").value.trim() : "",
		customerLink: sales ? state.customerLink : ""
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
	if (!f.supplierName && !f.documentDate) {
		$("d-parent").innerHTML = '<option value="">— fill in the supplier and date above first —</option>';
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
		$("d-parent").innerHTML = '<option value="">— pick the matching purchase —</option>' +
			cands.map(function (c) {
				return '<option value="' + esc(c.name) + '">' + esc(c.document_no || c.name) + " — " +
					esc(c.supplier || "") + " — " + esc(c.document_date || "") +
					" (" + Math.round(c.score * 100) + "%)</option>";
			}).join("");
		$("d-parent-hint").textContent = cands[0].reasons && cands[0].reasons.length
			? "Best match because: " + cands[0].reasons.join(", ") + "." : "";
	}).catch(function (e) {
		$("d-parent").innerHTML = '<option value="">— could not search —</option>';
		$("d-parent-hint").textContent = e.message || String(e);
	});
}

/* ------------------------------------------------------------- PDF + extract */

function acceptFile(dataUrl, name) {
	state.dataUrl = dataUrl;
	state.kind = kindOf(dataUrl);
	state.fileName = name || ("document-" + Date.now() + (state.kind === "image" ? ".jpg" : ".pdf"));
	$("d-file-name").textContent = state.fileName;
	if (state.kind === "image") { $("d-preview").src = dataUrl; $("d-preview").style.display = ""; }
	else { $("d-preview").style.display = "none"; $("d-preview").removeAttribute("src"); }
	$("box-doc-form").style.display = "";
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
	"purchase_order_reference", "currency", "total_amount"];

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
	/* a proforma carries its direction in who issued it; the type itself says nothing */
	$("d-direction").value = x.issuer_is_ours ? "out" : "in";
	updateTypeUi();
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
	$("d-notes").textContent = notes.join(" — ");
	$("d-issuer-note").textContent = x.issuer_is_ours
		? "Issued by Integrated Optics UAB" +
			(/integrated optics/i.test(x.customer_name || "") ? " — an intercompany sale to the GmbH." : ".")
		: "";
	checkSupplier();
	checkCustomer();
	if (section() !== "main") loadParentCandidates();
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
		var visual = !good;                        // photo, scan, or unreadable text layer

		if (!key) {
			if (rules) {
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

		warn(note(visual ? "Sending the " + (state.kind === "image" ? "picture" : "PDF") + " to the AI model to read…"
			: "Asking the AI model to read the fields…"));
		var call = visual
			? window.CS_EXTRACT.extractFromFile(state.dataUrl, { key: key }, hint)
			: window.CS_EXTRACT.extractFields(r.text, { key: key }, hint);
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

function approve() {
	var t = $("d-type").value, sec = SECTION_FOR[t];
	var f = readFields();
	var sales = salesMode();
	if (!f.documentNo || !f.documentDate || !(sales ? f.customerName : f.supplierName)) {
		$("d-stat").innerHTML = '<p class="hint" style="color:var(--err)">Document no., date and ' +
			(sales ? "customer" : "supplier") + " name are required.</p>";
		return;
	}
	if (!state.dataUrl) {
		$("d-stat").innerHTML = '<p class="hint" style="color:var(--err)">Choose, photograph or scan the document first.</p>';
		return;
	}
	var bad = window.CS_ERP.ready();
	if (bad) { $("d-stat").innerHTML = '<p class="hint" style="color:var(--err)">' + esc(bad) + "</p>"; return; }

	var parentName = "";
	if (sec !== "main") {
		parentName = $("d-parent-manual").value.trim() || $("d-parent").value;
		if (!parentName) {
			$("d-stat").innerHTML = '<p class="hint" style="color:var(--err)">Pick or enter the parent purchase document first.</p>';
			return;
		}
	}

	busy($("btn-doc-approve"), true, "Sending…");
	$("d-stat").innerHTML = "";
	var task = sec === "main"
		? window.CS_ACC.createMain(f, state.dataUrl, state.fileName)
		: window.CS_ACC.fillSection(sec, parentName, f, state.dataUrl, state.fileName);

	task.then(function (res) {
		busy($("btn-doc-approve"), false, "Approve & send to ERPNext");
		var lines = ['<p class="hint" style="color:#1f8a4c">Saved as <b>' + esc(res.name) + "</b> (" +
			esc(DOC_TYPE_LABELS[t]) + ").</p>"];
		if (res.file && res.file.state === "created") {
			lines.push('<p class="hint" style="color:#1f8a4c">File attached.</p>');
		} else if (res.file && res.file.state === "error") {
			lines.push('<p class="hint" style="color:var(--err)">The file could not be attached: ' +
				esc((res.file.errors && res.file.errors[0] && res.file.errors[0].message) || "") + "</p>");
		}
		(res.notes || []).forEach(function (n) {
			lines.push('<p class="hint">' + esc(n.message) + "</p>");
		});
		$("d-stat").innerHTML = lines.join("");
		resetForm();
	}).catch(function (e) {
		busy($("btn-doc-approve"), false, "Approve & send to ERPNext");
		var msg = (e.errors && e.errors.length && e.errors.map(function (x) { return x.message; }).join(" ")) ||
			e.message || String(e);
		$("d-stat").innerHTML = '<p class="hint" style="color:var(--err)">' + esc(msg) + "</p>";
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
	$("d-type").addEventListener("change", function () { updateTypeUi(); checkSupplier(); checkCustomer(); });
	$("d-direction").addEventListener("change", function () { updateTypeUi(); checkSupplier(); checkCustomer(); });
	$("d-customer_name").addEventListener("blur", function () { checkCustomer(); });
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
	$("btn-doc-extract").onclick = function () { if (state.dataUrl) runExtraction(); };
	$("btn-doc-cancel").onclick = resetForm;
	$("btn-doc-approve").onclick = approve;
	$("btn-dupe-scan").onclick = scanDuplicateSuppliers;

	updateTypeUi();
}

function onShow() { /* state persists across tab switches; nothing to repaint on entry */ }

return { init: init, onShow: onShow };
})();
