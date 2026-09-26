/* accdoc.js — Accounts Document sync: purchase invoices, customs declarations,
   customs invoices and shipping invoices, filed against ERPNext's single
   "Accounts Document" doctype. One record covers a whole purchase bundle:
   the main document (Purchase/Proforma/Sales invoice) plus, as they arrive,
   its Customs Declaration, that declaration's own invoice, and a shipping
   invoice — each section only appears in ERPNext once its own "received"
   checkbox is set, which is why filling a later section means finding and
   updating the SAME record rather than creating a new one.

   NOT YET CONFIRMED: this doctype also carries is_parent_document /
   is_single_document / parent_document fields for a second, coarser
   hierarchy (grouping several whole bundles under one umbrella record —
   see child_documents_html). This module deliberately leaves those three
   fields untouched rather than guess at that structure; do not set them
   from here until that's confirmed against how the doctype is actually
   used in ERPNext.

   Built on top of window.CS_ERP.shared, which already owns auth, doctype-
   metadata checks and error handling — this module only knows the shape of
   Accounts Document and the matching/merge rules layered on top of it. */
window.CS_ACC = (function () {
"use strict";

var DOCTYPE = "Accounts Document";

function erp() {
	if (!window.CS_ERP || !window.CS_ERP.shared) {
		throw new Error("erp.js must be loaded before accdoc.js");
	}
	return window.CS_ERP.shared;
}

/* ---------------------------------------------------------------- sections */

/* One entry per section of the Accounts Document doctype. Only "main"
   creates a new document; the other three always fill in an existing
   parent found by suggestParents() (or picked manually). */
var SECTIONS = {
	main: {
		file: "file", document_no: "document_no", date: "document_date",
		party: "supplier", partyCode: "supplier_code",
		receivedFlag: "purchase_invoice_received",
		label: "Purchase / Proforma / Sales Invoice"
	},
	cd: {
		file: "cd_file", document_no: "cd_document_no", date: "cd_date",
		party: "cd_supplier", partyCode: "cd_supplier_code",
		receivedFlag: "customs_declaration_cd_received",
		label: "Customs Declaration"
	},
	cdInvoice: {
		file: "cd_invoice_file", document_no: "cd_invoice_document_no",
		date: "cd_invoice_date", party: "cd_provider",
		partyCode: "cd_provider_code",
		receivedFlag: "invoice_for_cd_received",
		label: "Customs Declaration Invoice"
	},
	shipping: {
		file: "shipping_invoice_file",
		document_no: "shipping_invoice_document_no",
		date: "shipping_invoice_date", party: "shipping_service_provider",
		partyCode: "shipping_service_provider_code",
		receivedFlag: "invoice_for_shipping_received",
		label: "Shipping Invoice"
	}
};

var SECTION_NAMES = Object.keys(SECTIONS);

/* -------------------------------------------------------------- fuzzy match */

/* Legal-form and punctuation noise that should not count against a name
   match — "UAB Foo" and "Foo, UAB" and "Foo" are the same company. Not
   exhaustive; extend as real supplier names turn up false negatives. */
var LEGAL_FORMS = [
	"uab", "ab", "mb", "vsi", "ik", "ltd", "llc", "inc", "gmbh", "kg", "ag",
	"oy", "as", "bv", "spol", "sro", "sp", "zoo", "sa", "plc", "co", "corp",
	"company", "limited", "incorporated"
];

function normalizeName(s) {
	var t = String(s || "").toLowerCase();
	t = t.replace(/[.,'"()]/g, " ");
	t = t.replace(/[^a-z0-9À-ɏ&\s-]/g, " ");
	var words = t.split(/\s+/).filter(function (w) { return w.length; });
	words = words.filter(function (w) { return LEGAL_FORMS.indexOf(w) < 0; });
	return words.join(" ").trim();
}

/* Sørensen–Dice coefficient over character bigrams: robust to small edits
   (typos, word order, a missing legal-form suffix) without needing a full
   edit-distance implementation. 1.0 = identical, 0 = nothing in common. */
function bigrams(s) {
	var out = {};
	for (var i = 0; i < s.length - 1; i++) {
		var bg = s.substr(i, 2);
		out[bg] = (out[bg] || 0) + 1;
	}
	return out;
}

function diceCoefficient(a, b) {
	if (!a && !b) return 1;
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
	var ba = bigrams(a), bb = bigrams(b);
	var overlap = 0, totalA = 0, totalB = 0, k;
	for (k in ba) { totalA += ba[k]; }
	for (k in bb) { totalB += bb[k]; }
	for (k in ba) { if (bb[k]) overlap += Math.min(ba[k], bb[k]); }
	return (2 * overlap) / (totalA + totalB);
}

/* How closely `name`/`code` matches an existing Supplier. A shared,
   non-empty code is decisive (typos in a name are common; a shared internal
   code is not a coincidence), so it floors the score at 0.97 even if the
   names otherwise look unrelated — still just a high-ranked suggestion for
   a human, never an auto-merge trigger by itself.

   `code` is compared against the real Supplier identity fields — Supplier
   has no `supplier_code` field at all (confirmed against the doctype's own
   field export): the fields that actually identify a company there are
   `reg_number` (registration number) and `tax_id` (VAT/Tax ID). A match on
   either counts. */
function nameScore(name, code, supplier) {
	var n1 = normalizeName(name), n2 = normalizeName(supplier.supplier_name);
	var score = diceCoefficient(n1, n2);
	var codeMatch = false;
	var c = code ? String(code).trim().toLowerCase() : "";
	if (c) {
		var reg = supplier.reg_number ? String(supplier.reg_number).trim().toLowerCase() : "";
		var tax = supplier.tax_id ? String(supplier.tax_id).trim().toLowerCase() : "";
		if ((reg && c === reg) || (tax && c === tax)) {
			codeMatch = true;
			score = Math.max(score, 0.97);
		}
	}
	return { score: score, codeMatch: codeMatch, supplier: supplier };
}

/* Looks for existing Suppliers that might be the same company as `name`
   (optionally with a `code` — a registration number or tax ID read off the
   document — to match on). Returns candidates scoring above `threshold`,
   best first — never more than a handful, since this is for a human to
   glance at, not to page through. */
function findSupplierMatches(name, code, threshold) {
	threshold = threshold == null ? 0.55 : threshold;
	return erp().getList("Supplier", null,
			["name", "supplier_name", "reg_number", "tax_id"], 0)
		.then(function (rows) {
			return rows.map(function (s) { return nameScore(name, code, s); })
				.filter(function (r) { return r.score >= threshold; })
				.sort(function (a, b) { return b.score - a.score; })
				.slice(0, 5);
		});
}

/* Exact match only — used before creating a new Supplier, so a typo'd resend
   of the same invoice doesn't create a second record with the fuzzy version
   left for a human to notice later. */
function findExactSupplier(name) {
	if (!name) return Promise.resolve(null);
	return erp().getList("Supplier", [["supplier_name", "=", name]], ["name"], 1)
		.then(function (rows) { return rows.length ? rows[0].name : null; });
}

/* Calls ERPNext's own document-merge endpoint (frappe.client.rename_doc with
   merge=1): renames dupName into intoName, merging their linked records.
   Only ever called after the employee confirms which two records they mean
   in the review UI — a wrong merge is much harder to undo than a wrong
   flag, so this module never decides to merge on its own. */
function mergeSupplier(dupName, intoName) {
	var e = erp();
	return e.login().then(function () {
		return e.request("POST", e.methodUrl("frappe.client.rename_doc"),
			e.authHeaders(false),
			"doctype=" + encodeURIComponent("Supplier") +
			"&old_name=" + encodeURIComponent(dupName) +
			"&new_name=" + encodeURIComponent(intoName) +
			"&merge=1", 60);
	}).then(function (r) {
		if (r.status >= 200 && r.status < 300) return { ok: true };
		return { ok: false, errors: e.toErrors(r.status, r.body, "Supplier") };
	});
}

/* ------------------------------------------------------------ parent search */

function daysBetween(a, b) {
	var da = new Date(a), db = new Date(b);
	if (isNaN(da) || isNaN(db)) return 9999;
	return Math.abs(da - db) / 86400000;
}

/* Ranks existing Accounts Documents as candidate parents for a newly-scanned
   Customs Declaration / CD Invoice / Shipping Invoice. Scored rather than
   filtered to an exact match, because the whole point is to survive a
   slightly different date or a supplier name typo'd differently on each
   document. Only PURCHASE- records are considered: these three sections
   only make sense against a purchase, never a sale or a standalone
   proforma. */
function suggestParents(fields, opts) {
	opts = opts || {};
	var windowDays = opts.windowDays == null ? 30 : opts.windowDays;
	var supplierName = fields.supplierName || "";
	var supplierCode = fields.supplierCode || "";
	var poRef = fields.purchaseOrderReference || "";
	var docDate = fields.documentDate || "";

	return erp().getList(DOCTYPE, [["naming_series", "=", "PURCHASE-"]],
			["name", "supplier", "supplier_code", "document_date",
				"purchase_order_reference", "document_no"], 200)
		.then(function (rows) {
			var scored = rows.map(function (r) {
				var s = nameScore(supplierName, supplierCode,
					{ supplier_name: r.supplier || "", supplier_code: r.supplier_code || "" });
				var reasons = [];
				var score = 0.5 * s.score;
				if (s.codeMatch) reasons.push("supplier code matches");
				else if (s.score > 0.8) reasons.push("supplier name matches closely");

				if (docDate && r.document_date) {
					var dd = daysBetween(docDate, r.document_date);
					if (dd <= windowDays) {
						score += 0.35 * (1 - dd / windowDays);
						reasons.push(dd < 1 ? "same date" : Math.round(dd) + " day(s) apart");
					}
				}
				if (poRef && r.purchase_order_reference && String(poRef).trim()
						.toLowerCase() === String(r.purchase_order_reference).trim().toLowerCase()) {
					score += 0.15;
					reasons.push("same PO reference");
				}
				return { name: r.name, document_no: r.document_no,
					supplier: r.supplier, document_date: r.document_date,
					score: score, reasons: reasons };
			});
			return scored.filter(function (c) { return c.score >= 0.3; })
				.sort(function (a, b) { return b.score - a.score; })
				.slice(0, 5);
		});
}

/* ------------------------------------------------------------- section fill */

/* Builds the field patch for one section from extracted/edited fields. Does
   NOT include the file itself — attachFile() handles that separately, and
   needs the document to already exist. */
function sectionPatch(section, fields) {
	var s = SECTIONS[section];
	var patch = {};
	if (fields.documentNo) patch[s.document_no] = fields.documentNo;
	if (fields.documentDate) patch[s.date] = fields.documentDate;
	/* supplierLink is the exact existing ERPNext Supplier name the employee
	   confirmed (from findSupplierMatches); falling back to the raw
	   extracted name lets clean()/ensureLink still try an exact-name match,
	   and drop the field with a note if ERPNext has no such Supplier. */
	if (fields.supplierName) patch[s.party] = fields.supplierLink || fields.supplierName;
	if (fields.supplierCode) patch[s.partyCode] = fields.supplierCode;
	if (s.receivedFlag) patch[s.receivedFlag] = 1;
	if (section === "main") {
		if (fields.paymentDueDate) patch.payment_due_date = fields.paymentDueDate;
		if (fields.namingSeries) patch.naming_series = fields.namingSeries;
		if (fields.purchaseOrderReference) {
			patch.purchase_order_reference = fields.purchaseOrderReference;
		}
		if (fields.salesInvoiceReference) {
			patch.sales_invoice_reference = fields.salesInvoiceReference;
		}
		if (fields.customerLink) patch.customer = fields.customerLink;
	}
	return patch;
}

/* Creates a brand-new main Accounts Document (a freshly scanned purchase
   invoice/proforma/sales invoice with no existing parent) and attaches the
   file to its `file` field. Defaults to naming_series "PURCHASE-" — by far
   the common case for this app — but the review UI should let the employee
   override it before this is called. */
function createMain(fields, fileDataUrl, fileName) {
	var e = erp();
	var patch = sectionPatch("main", fields);
	patch.naming_series = fields.namingSeries || "PURCHASE-";
	return e.clean(DOCTYPE, patch, []).then(function (c) {
		return e.createDoc(DOCTYPE, c.doc, c.notes).then(function (name) {
			return e.attachFile(DOCTYPE, name, fileDataUrl, fileName, SECTIONS.main.file)
				.then(function (fileResult) {
					return { name: name, section: "main", file: fileResult, notes: c.notes };
				});
		});
	});
}

/* Fills in one of the three later sections on an existing parent document
   (found via suggestParents(), or picked manually in the review UI). */
function fillSection(section, parentName, fields, fileDataUrl, fileName) {
	if (section === "main") {
		throw new Error("fillSection is for cd / cdInvoice / shipping — " +
			"use createMain for a fresh main document.");
	}
	var e = erp();
	var patch = sectionPatch(section, fields);
	return e.clean(DOCTYPE, patch, []).then(function (c) {
		return e.updateDoc(DOCTYPE, parentName, c.doc).then(function () {
			return e.attachFile(DOCTYPE, parentName, fileDataUrl, fileName,
					SECTIONS[section].file)
				.then(function (fileResult) {
					return { name: parentName, section: section,
						file: fileResult, notes: c.notes };
				});
		});
	});
}

return {
	DOCTYPE: DOCTYPE, SECTIONS: SECTIONS, SECTION_NAMES: SECTION_NAMES,
	normalizeName: normalizeName, diceCoefficient: diceCoefficient,
	findSupplierMatches: findSupplierMatches, findExactSupplier: findExactSupplier,
	mergeSupplier: mergeSupplier,
	suggestParents: suggestParents,
	sectionPatch: sectionPatch,
	createMain: createMain, fillSection: fillSection,
	_internals: { nameScore: nameScore, daysBetween: daysBetween, bigrams: bigrams,
		LEGAL_FORMS: LEGAL_FORMS }
};
})();
