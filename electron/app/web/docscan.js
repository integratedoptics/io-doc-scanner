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

var state = { dataUrl: null, fileName: "", supplierLink: "" };

function settings() { return (window.CS && window.CS.settings()) || {}; }
function section() { return SECTION_FOR[$("d-type").value] || "main"; }

function updateTypeUi() {
	var t = $("d-type").value, sec = SECTION_FOR[t];
	$("d-row-main-extra").style.display = sec === "main" ? "" : "none";
	$("d-row-po").style.display = (sec === "main" && t !== "sales_invoice") ? "" : "none";
	$("d-row-sales").style.display = (t === "sales_invoice") ? "" : "none";
	$("d-row-parent").style.display = sec === "main" ? "none" : "";
	if (sec === "main" && !$("d-naming_series").value) {
		$("d-naming_series").value = NAMING_GUESS[t] || "PURCHASE-";
	}
	if (sec !== "main") loadParentCandidates();
}

function resetForm() {
	["document_no", "document_date", "payment_due_date", "naming_series",
		"purchase_order_reference", "sales_invoice_reference", "supplier_name",
		"supplier_reg_number", "supplier_tax_id", "currency", "total_amount"].forEach(function (k) {
		var el = $("d-" + k);
		if (el) el.value = "";
	});
	$("d-parent-manual").value = "";
	$("d-warn").innerHTML = "";
	$("d-dupe-box").innerHTML = "";
	$("d-notes").textContent = "";
	$("d-stat").innerHTML = "";
	$("d-parent").innerHTML = "";
	$("d-parent-hint").textContent = "";
	$("d-file-name").textContent = "";
	state.dataUrl = null; state.fileName = ""; state.supplierLink = "";
	$("box-doc-form").style.display = "none";
}

function code() {
	var tax = $("d-supplier_tax_id").value.trim(), reg = $("d-supplier_reg_number").value.trim();
	/* prefer the tax/VAT ID when both are read off the document — it tends
	   to be quoted more consistently across a supplier's own documents than
	   a registration number is */
	return tax || reg;
}

function readFields() {
	return {
		documentNo: $("d-document_no").value.trim(),
		documentDate: $("d-document_date").value.trim(),
		paymentDueDate: $("d-payment_due_date").value.trim(),
		namingSeries: $("d-naming_series").value.trim(),
		purchaseOrderReference: $("d-purchase_order_reference").value.trim(),
		salesInvoiceReference: $("d-sales_invoice_reference").value.trim(),
		supplierName: $("d-supplier_name").value.trim(),
		supplierCode: code(),
		supplierLink: state.supplierLink
	};
}

/* ------------------------------------------------------- duplicate supplier */

function checkSupplier() {
	var name = $("d-supplier_name").value.trim();
	state.supplierLink = "";
	$("d-dupe-box").innerHTML = "";
	if (!name || !window.CS_ACC) return;
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

function handleDocPicked(r) {
	busy($("btn-doc-pick"), false, "Scan or choose a PDF");
	if (!r || !r.ok) {
		$("d-file-name").textContent = (r && r.error) || "No file chosen.";
		return;
	}
	state.dataUrl = r.dataUrl;
	state.fileName = r.name || ("document-" + Date.now() + ".pdf");
	$("d-file-name").textContent = state.fileName;
	$("box-doc-form").style.display = "";
	updateTypeUi();
	runExtraction();
}
window.onDocPicked = handleDocPicked;

function fillFromExtraction(x) {
	if (!x) return;
	if (x.doc_type && DOC_TYPE_LABELS[x.doc_type] && x.doc_type !== $("d-type").value) {
		$("d-type").value = x.doc_type;
		updateTypeUi();
	}
	$("d-document_no").value = x.document_no || "";
	$("d-document_date").value = x.document_date || "";
	$("d-payment_due_date").value = x.payment_due_date || "";
	$("d-purchase_order_reference").value = x.purchase_order_reference || "";
	$("d-supplier_name").value = x.supplier_name || "";
	$("d-supplier_reg_number").value = x.supplier_reg_number || "";
	$("d-supplier_tax_id").value = x.supplier_tax_id || "";
	$("d-currency").value = x.currency || "";
	$("d-total_amount").value = (x.total_amount === undefined || x.total_amount === null) ? "" : x.total_amount;
	var notes = [];
	if (typeof x.confidence === "number") notes.push("model confidence: " + Math.round(x.confidence * 100) + "%");
	if (x.notes) notes.push(x.notes);
	$("d-notes").textContent = notes.join(" — ");
	checkSupplier();
	if (section() !== "main") loadParentCandidates();
}

function runExtraction() {
	if (!state.dataUrl) return;
	var s = settings();
	var bad = window.CS_EXTRACT.ready({ key: s.extract_key });
	if (bad) {
		$("d-warn").innerHTML = '<p class="hint">' + esc(bad) + " Fill in the fields by hand below.</p>";
		return;
	}
	$("d-warn").innerHTML = '<p class="hint">Reading the PDF…</p>';
	window.CS_PDF.extractText(state.dataUrl).then(function (res) {
		$("d-warn").innerHTML = '<p class="hint">Asking the model to pull out the fields…</p>';
		return window.CS_EXTRACT.extractFields(res.text, { key: s.extract_key }, $("d-type").value);
	}).then(function (x) {
		fillFromExtraction(x.fields);
		$("d-warn").innerHTML = "";
	}).catch(function (e) {
		$("d-warn").innerHTML = '<p class="hint" style="color:var(--err)">' + esc(e.message || String(e)) +
			" — fill in the fields by hand below.</p>";
	});
}

/* ------------------------------------------------------------------ approve */

function approve() {
	var t = $("d-type").value, sec = SECTION_FOR[t];
	var f = readFields();
	if (!f.documentNo || !f.documentDate || !f.supplierName) {
		$("d-stat").innerHTML = '<p class="hint" style="color:var(--err)">Document no., date and supplier name are required.</p>';
		return;
	}
	if (!state.dataUrl) {
		$("d-stat").innerHTML = '<p class="hint" style="color:var(--err)">Scan or choose the PDF first.</p>';
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
			lines.push('<p class="hint" style="color:#1f8a4c">PDF attached.</p>');
		} else if (res.file && res.file.state === "error") {
			lines.push('<p class="hint" style="color:var(--err)">The PDF could not be attached: ' +
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
	$("d-type").addEventListener("change", function () { updateTypeUi(); checkSupplier(); });
	$("d-supplier_name").addEventListener("blur", checkSupplier);
	$("d-supplier_reg_number").addEventListener("blur", checkSupplier);
	$("d-supplier_tax_id").addEventListener("blur", checkSupplier);
	["d-document_date", "d-purchase_order_reference"].forEach(function (id) {
		$(id).addEventListener("blur", function () { if (section() !== "main") loadParentCandidates(); });
	});

	$("btn-doc-pick").onclick = function () {
		if (window.Android && typeof window.Android.pickDocument === "function") {
			busy($("btn-doc-pick"), true, "Opening…");
			window.Android.pickDocument();
		} else {
			$("d-file-name").textContent = "Document scanning isn't wired up in this build yet.";
		}
	};
	$("btn-doc-extract").onclick = function () { if (state.dataUrl) runExtraction(); };
	$("btn-doc-cancel").onclick = resetForm;
	$("btn-doc-approve").onclick = approve;
	$("btn-dupe-scan").onclick = scanDuplicateSuppliers;

	updateTypeUi();
}

function onShow() { /* state persists across tab switches; nothing to repaint on entry */ }

return { init: init, onShow: onShow };
})();
