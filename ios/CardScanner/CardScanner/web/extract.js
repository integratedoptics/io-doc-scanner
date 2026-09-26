/* extract.js — AI-assisted field extraction for scanned accounts documents.

   Takes text already extracted from a PDF (each shell is responsible for its
   own PDF-to-text step — this module has no PDF parser of its own; see the
   native-shell tasks) and asks Claude to pull out the handful of fields the
   Accounts Document workflow needs: which of the four document kinds this
   is, its number and date, the supplier and its identifying codes, and (for
   the main document) a PO reference and due date.

   Runs on Claude Sonnet 5 specifically (model id "claude-sonnet-5"), not
   whichever provider/model Settings has configured for the existing
   business-card "AI cleanup" feature — that stays independent (and may be a
   different provider entirely), so this module takes its own Anthropic key
   rather than reusing that one. It sends already-extracted text, never the
   PDF itself or an image of it. */
window.CS_EXTRACT = (function () {
"use strict";

var MODEL = "claude-sonnet-5";
var API_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";

var DOC_TYPES = ["purchase_invoice", "proforma_invoice", "sales_invoice",
	"customs_declaration", "cd_invoice", "shipping_invoice"];

var SCHEMA_PROMPT =
"You are extracting structured data from an accounts document (an invoice, " +
"customs declaration, or shipping invoice) for a Lithuanian import/export " +
"company. Read the document text below and reply with ONLY a single JSON " +
"object — no markdown fences, no commentary — with exactly these keys:\n\n" +
"{\n" +
"  \"doc_type\": one of " + JSON.stringify(DOC_TYPES) + ",\n" +
"  \"document_no\": the document/invoice number as printed, or null,\n" +
"  \"document_date\": the document's own date, ISO 8601 (YYYY-MM-DD), or null,\n" +
"  \"payment_due_date\": ISO 8601, or null if not a purchase/sales/proforma invoice or not stated,\n" +
"  \"supplier_name\": the selling/issuing company's name exactly as printed, or null,\n" +
"  \"supplier_reg_number\": the supplier's company registration number (not a bank or invoice number), or null,\n" +
"  \"supplier_tax_id\": the supplier's VAT/Tax ID, or null,\n" +
"  \"purchase_order_reference\": a PO number this document references, or null,\n" +
"  \"currency\": ISO 4217 currency code, or null,\n" +
"  \"total_amount\": the document total as a plain number (no currency symbol or thousands separators), or null,\n" +
"  \"confidence\": your own confidence in this extraction, 0 to 1,\n" +
"  \"notes\": anything worth a human double-checking, or \"\"\n" +
"}\n\n" +
"If a field is not present in the text, use null — never invent a value. " +
"Base doc_type on the document's own heading/title and layout, not on any " +
"filename you might see mentioned.";

function stripFences(s) {
	var t = String(s || "").trim();
	var m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return m ? m[1] : t;
}

/* This module takes its Anthropic key as a plain argument (settings.key)
   rather than reading window Settings itself, so callers decide which
   Settings field feeds it — see the note above about not reusing the
   general AI-cleanup key/provider. */
function ready(settings) {
	if (!settings || !settings.key) {
		return "Set the Anthropic API key for document extraction in Settings first.";
	}
	return "";
}

/* extractFields(text, settings, hint) -> Promise<{ fields, raw }>
   `hint` is an optional doc_type guess from the UI (e.g. which button the
   employee tapped to start the scan) passed along as a strong suggestion,
   not a constraint — the model can override it if the text disagrees. */
function extractFields(text, settings, hint) {
	var bad = ready(settings);
	if (bad) return Promise.reject(new Error(bad));

	var prompt = SCHEMA_PROMPT +
		(hint ? "\n\nThe employee scanning this expects it to be a: " + hint +
			" — but trust the document's own text over that if they disagree.\n" : "\n") +
		"\n--- DOCUMENT TEXT ---\n" + String(text || "").slice(0, 15000);

	var body = JSON.stringify({
		model: MODEL,
		max_tokens: 1024,
		temperature: 0,
		messages: [{ role: "user", content: prompt }]
	});

	return window.CS_NET.request("POST", API_URL, {
		"Content-Type": "application/json",
		"x-api-key": settings.key,
		"anthropic-version": ANTHROPIC_VERSION
	}, body, 60).then(function (r) {
		if (r.status < 200 || r.status >= 300) {
			var msg = "The extraction request failed (" + r.status + ")";
			try {
				var ej = JSON.parse(r.body);
				if (ej && ej.error && ej.error.message) msg += ": " + ej.error.message;
			} catch (e) { /* keep the generic message */ }
			throw new Error(msg);
		}
		var j = JSON.parse(r.body || "{}");
		var replyText = (j.content && j.content[0] && j.content[0].text) || "";
		var parsed;
		try {
			parsed = JSON.parse(stripFences(replyText));
		} catch (e) {
			throw new Error("Could not read the extracted fields back as JSON.");
		}
		return { fields: parsed, raw: replyText };
	});
}

return {
	MODEL: MODEL, DOC_TYPES: DOC_TYPES, ready: ready,
	extractFields: extractFields,
	_internals: { stripFences: stripFences, SCHEMA_PROMPT: SCHEMA_PROMPT }
};
})();
