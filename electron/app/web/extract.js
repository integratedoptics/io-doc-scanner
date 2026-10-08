/* extract.js — AI-assisted field extraction for accounts documents.

   Two ways in, same prompt, same answer shape:
     extractFields(text, ...)        text already pulled out of a PDF on the
                                     device (pdfview.js) — the cheap, default path
     extractFromFile(dataUrl, ...)   the PDF or photo itself, sent as a PDF /
                                     image block — for scans and camera shots,
                                     which have no text layer, and PDFs whose
                                     text layer is unusable

   Documents arrive in English, Lithuanian or German (sometimes mixed), so the
   prompt carries the vocabulary of all three: what each kind of document is
   called, which label marks the seller and which the buyer, how dates and
   numbers are written. The most important rule it states is the one the first
   real invoice taught: the supplier is the company that ISSUED the document —
   which on Lithuanian invoices is often only named in the footer or next to
   "Sąskaitą išrašė" — and never the buyer (that is us, Integrated Optics).

   Runs on Claude Sonnet 5 (model id "claude-sonnet-5") with its own Anthropic
   key, independent of the business-card "AI cleanup" provider setting. */
window.CS_EXTRACT = (function () {
"use strict";

var MODEL = "claude-sonnet-5";
var API_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";
var MAX_B64 = 26 * 1000 * 1000;   // the API's request limit is 32 MB; leave room for the prompt

var DOC_TYPES = ["purchase_invoice", "proforma_invoice", "sales_invoice",
	"customs_declaration", "cd_invoice", "shipping_invoice", "attachment"];

var SCHEMA_PROMPT =
"You are reading an accounts document for Integrated Optics UAB (Vilnius, Lithuania; company code 302833442; " +
"VAT LT100007179012) — that is OUR company; the records are kept for it only. Its German subsidiary IO Integrated Optics " +
"GmbH (HRB 37938; USt-IdNr. DE355412240) is an ORDINARY counterparty: our supplier when it bills us, our customer when " +
"we bill it. Documents come in English, Lithuanian or German, sometimes mixed. " +
"Reply with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:\n\n" +
"{\n" +
"  \"doc_type\": one of " + JSON.stringify(DOC_TYPES) + ",\n" +
"  \"document_no\": the document/invoice number as printed, or null,\n" +
"  \"document_date\": the document's own date, ISO 8601 (YYYY-MM-DD), or null,\n" +
"  \"payment_due_date\": ISO 8601, or null if not stated (see below),\n" +
"  \"supplier_name\": the company that ISSUED the document, exactly as printed, or null,\n" +
"  \"supplier_reg_number\": that company's registration number, or null,\n" +
"  \"supplier_tax_id\": that company's VAT / tax ID, with country prefix, or null,\n" +
"  \"customer_name\": the company BILLED on the document (the buyer), exactly as printed, or null,\n" +
"  \"customer_reg_number\": the buyer's registration number, or null,\n" +
"  \"customer_tax_id\": the buyer's VAT / tax ID, with country prefix, or null,\n" +
"  \"issuer_is_ours\": true only if the document was ISSUED by Integrated Optics UAB (not the GmbH), else false,\n" +
"  \"purchase_order_reference\": OUR purchase order number(s) the document refers to, normalised like PO-08353, or null,\n" +
"  \"related_references\": a JSON array of every number that ties this document to others: our PO numbers, sales order / " +
"proforma numbers (SO-…, PIN-…), the customer's own PO, invoice numbers it cites, the customs declaration MRN, waybill / " +
"tracking numbers — as printed, without this document's own number (empty array if none),\n" +
"  \"attachment_kind\": for doc_type \"attachment\" only: \"waybill\", \"payment_order\" or \"other\"; else \"\",\n" +
"  \"currency\": ISO 4217 code, or null,\n" +
"  \"total_amount\": the gross total payable as a plain JSON number, or null,\n" +
"  \"language\": \"en\", \"lt\", \"de\" or \"other\" — the main language of the document,\n" +
"  \"confidence\": your own confidence in this extraction, 0 to 1,\n" +
"  \"notes\": in English, anything a human should double-check, or \"\"\n" +
"}\n\n" +
"WHAT KIND OF DOCUMENT (decide from its own heading and content; the filename is irrelevant):\n" +
"- purchase_invoice: an invoice where WE are the buyer. Lithuanian \"PVM sąskaita faktūra\", \"Sąskaita faktūra\", " +
"\"Sąskaita\"; German \"Rechnung\", \"Eingangsrechnung\"; English \"Invoice\", \"Tax invoice\", \"Commercial invoice\".\n" +
"- proforma_invoice: headed \"Išankstinė sąskaita (faktūra)\", \"Proforma sąskaita\", \"Proformarechnung\", " +
"\"Pro-forma-Rechnung\", \"Proforma invoice\".\n" +
"- sales_invoice: an invoice that WE issue — i.e. the SELLER is Integrated Optics UAB. This includes UAB billing its " +
"subsidiary IO Integrated Optics GmbH (intercompany): the customer is then the GmbH. An invoice FROM the GmbH TO the UAB " +
"is a purchase_invoice with the GmbH as supplier.\n" +
"- customs_declaration: \"Muitinės deklaracija\", \"Importo / Eksporto deklaracija\", \"Bendrasis administracinis " +
"dokumentas (BAD)\", \"Zollanmeldung\", \"Einfuhranmeldung\", \"Ausfuhranmeldung\", \"Customs declaration\", " +
"\"Single Administrative Document (SAD)\". Its document_no is the MRN (18 characters, " +
"like 26LTVA100025C7F4R1). These are FORMS with numbered boxes: take values by box number (2 exporter, 8 consignee, " +
"14 declarant, 22 currency and invoice value, 40 / 44 attached documents — a code N380 is an invoice number, N740 / N760 " +
"a waybill number — and the PO in box 44). Leave supplier_* null on a customs declaration (the app fills in the customs " +
"authority) and total_amount null.\n" +
"- cd_invoice: an invoice FROM a customs broker or agent for clearing a declaration: \"Muitinės tarpininko / " +
"muitinės paslaugų sąskaita\", \"Zollabfertigungsrechnung\", \"Customs clearance / broker invoice\".\n" +
"- attachment: a supporting paper that is NOT an invoice or a declaration and is only filed with the record: a waybill or " +
"courier label (DHL / FedEx / UPS / TNT, \"Važtaraštis\", \"Frachtbrief\", CMR), or a bank payment order / transfer " +
"confirmation (\"Mokėjimo nurodymas\", \"Payment Order\", \"Zahlungsauftrag\"). Read its date, amount and currency, " +
"and its references: the PO and invoice numbers in the payment details, the tracking number, the customer's PO.\n" +
"- shipping_invoice: an invoice from a carrier or forwarder: \"Transporto / vežimo / ekspedijavimo paslaugų " +
"sąskaita\", \"Frachtrechnung\", \"Speditionsrechnung\", \"Transportrechnung\", \"Freight / forwarding / shipping " +
"invoice\". (A CMR, \"Krovinio važtaraštis\", \"Frachtbrief\" or waybill is not an invoice — pick the closest kind " +
"and say so in notes.)\n\n" +
"WHO IS WHO — the most important rule:\n" +
"- The SUPPLIER is the SELLER / ISSUER. Labels: Lithuanian \"Pardavėjas\", \"Tiekėjas\", \"Sąskaitą išrašė\", " +
"\"Išrašė\"; German \"Verkäufer\", \"Lieferant\", \"Rechnungssteller\", \"Aussteller\"; English \"Seller\", " +
"\"Supplier\", \"Vendor\", \"From\", \"Issued by\". Its name, codes and bank details are often in a letterhead or " +
"in the FOOTER (next to \"Sąskaitą išrašė\", the IBAN, e-mail and web address) — look there too.\n" +
"- The BUYER / CUSTOMER is the party billed. Labels: Lithuanian \"Pirkėjas\", \"Gavėjas\", \"Klientas\"; German \"Käufer\", " +
"\"Kunde\", \"Rechnungsempfänger\"; English \"Buyer\", \"Bill to\", \"Customer\", \"Sold to\". Put it in customer_*.\n" +
"- On a document issued BY someone else (including the GmbH), Integrated Optics UAB is normally the buyer: put the issuer " +
"in supplier_* (for the GmbH use its own codes) and leave customer_* null; issuer_is_ours is false. NEVER put the buyer in " +
"supplier_name, supplier_reg_number or supplier_tax_id, and never use 302833442 or LT100007179012 for another company.\n" +
"- On a document issued BY Integrated Optics UAB (a sales invoice, or a proforma we send): issuer_is_ours is true, " +
"supplier_* is null, and customer_* is the company we are billing — copy its name exactly as printed with its legal form, " +
"and its codes. This also holds when UAB bills the GmbH.\n" +
"- Copy supplier_name exactly as printed, with its legal form (UAB, AB, MB, IĮ, VšĮ, GmbH, AG, KG, Ltd, …) and " +
"with Lithuanian/German letters intact (ą č ę ė į š ų ū ž ä ö ü ß).\n\n" +
"FIELD LABELS in the three languages:\n" +
"- document_no: \"Sąskaitos Nr.\", \"Dokumento Nr.\", \"Serija … Nr. …\" | \"Rechnungsnummer\", \"Rechnungs-Nr.\", " +
"\"Belegnummer\" | \"Invoice No./Number\". If a series and a number are printed separately (\"Serija E Nr. 202604-122\") " +
"join them without a space: \"E202604-122\".\n" +
"- document_date: \"Data\", \"Sąskaitos data\", \"Išrašymo data\" | \"Rechnungsdatum\", \"Datum\" | \"Invoice date\", " +
"\"Date\". Not the due date, delivery date or print date.\n" +
"- payment_due_date: \"Apmokėti iki\", \"Apmokėjimo terminas\" | \"Zahlbar bis\", \"Fällig am\", \"Zahlungsziel\" | " +
"\"Due date\", \"Payment due\". If only a term is given (\"30 Tage\", \"Net 30\", \"30 d.\") add it to document_date; " +
"if you cannot, null.\n" +
"- supplier_reg_number: \"Įmonės kodas\", \"Įm. kodas\" | \"Handelsregisternummer\", \"HRB/HRA …\" | \"Company code\", " +
"\"Company reg. no.\", \"Registration number\".\n" +
"- supplier_tax_id: \"PVM mokėtojo kodas\", \"PVM kodas\" | \"USt-IdNr.\", \"Umsatzsteuer-ID\" (use \"Steuernummer\" only " +
"if there is no USt-IdNr.) | \"VAT No./ID\", \"Tax ID\". Keep the country prefix (LT258168314).\n" +
"- purchase_order_reference: \"Užsakymo Nr.\" | \"Bestellnummer\", \"Ihre Bestellung\", \"Auftragsnummer\" | " +
"\"PO number\", \"Your order\". Several POs (also one per line item): list each once, in order, joined with \", \". " +
"Ours look like PO-07808: normalise \"PO:08353\", \"PO 08353\", \"P.O. 08353\" or a bare number after \"PO\" to " +
"\"PO-08353\". An invoice number printed together with a PO (\"20260730-FG394 PO-08258\") is the number only: " +
"\"20260730-FG394\". On a document WE issue, a PO printed on it is the CUSTOMER's: leave purchase_order_reference null " +
"and list it in related_references.\n" +
"- total_amount: the GROSS amount payable, including VAT: \"Suma, EUR\", \"Iš viso\", \"Viso mokėti\", \"Mokėtina " +
"suma\" | \"Gesamtbetrag\", \"Rechnungsbetrag\", \"Brutto\", \"Zu zahlen\" | \"Total\", \"Amount due\", \"Grand total\". " +
"NOT the net or subtotal (\"Viso, be PVM\", \"Netto\", \"Zwischensumme\", \"Subtotal\") and not the VAT line.\n\n" +
"FORMATS: Dates are day-first. \"22.04.2026\" is 2026-04-22; Lithuanian \"2026 m. balandžio 22 d.\" is 2026-04-22; " +
"German \"22. April 2026\"; also \"15th-September-2026\", \"2026/8/22\" and \"23SEP26\". Lithuanian months: sausio, vasario, kovo, balandžio, gegužės, birželio, liepos, " +
"rugpjūčio, rugsėjo, spalio, lapkričio, gruodžio. German months: Januar, Februar, März, April, Mai, Juni, Juli, " +
"August, September, Oktober, November, Dezember. Amounts: \"1.234,56\" and \"1 234,56\" (German/Lithuanian style) " +
"both mean 1234.56 — return a JSON number with a dot as the decimal separator and no thousands separators.\n\n" +
"If a field is not in the document, use null — never invent a value or copy one from the wrong party.";

function stripFences(s) {
	var t = String(s || "").trim();
	var m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return m ? m[1] : t;
}

/* This module takes its Anthropic key as a plain argument (settings.key). */
function ready(settings) {
	if (!settings || !settings.key) {
		return "Set the Anthropic API key for document extraction in Settings first.";
	}
	return "";
}

function hintLine(hint) {
	return hint ? "\n\nThe employee scanning this expects it to be a: " + hint +
		" — but trust the document itself over that if they disagree.\n" : "\n";
}

/* the content blocks for the request */
function buildContent(input, hint) {
	var prompt = SCHEMA_PROMPT + hintLine(hint);
	if (input && input.dataUrl) {
		var m = String(input.dataUrl).match(/^data:([^;,]+);base64,(.*)$/);
		if (!m || !m[2]) throw new Error("Could not read that file.");
		var mime = m[1].toLowerCase();
		if (m[2].length > MAX_B64) throw new Error("That file is too large to send for reading (over about 19 MB).");
		var block;
		if (mime === "application/pdf") {
			block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: m[2] } };
		} else if (/^image\/(jpeg|jpg|png|gif|webp)$/.test(mime)) {
			block = { type: "image", source: { type: "base64", media_type: mime === "image/jpg" ? "image/jpeg" : mime, data: m[2] } };
		} else {
			throw new Error("Only PDF, JPEG and PNG files can be read (this one is " + mime + ").");
		}
		return [block, { type: "text", text: prompt }];
	}
	return prompt + "\n--- DOCUMENT TEXT ---\n" + String((input && input.text) || "").slice(0, 15000);
}

function send(content, settings) {
	var body = JSON.stringify({
		model: MODEL,
		max_tokens: 1024,
		temperature: 0,
		messages: [{ role: "user", content: content }]
	});
	var headers = {
		"Content-Type": "application/json",
		"x-api-key": settings.key,
		"anthropic-version": ANTHROPIC_VERSION
	};
	/* Keys that are not scoped to one workspace need the workspace named per request. */
	if (settings.workspace) headers["anthropic-workspace-id"] = String(settings.workspace).trim();
	return window.CS_NET.request("POST", API_URL, headers, body, 90).then(function (r) {
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

/* extractFields(text, settings, hint) -> Promise<{ fields, raw }> */
function extractFields(text, settings, hint) {
	var bad = ready(settings);
	if (bad) return Promise.reject(new Error(bad));
	try { return send(buildContent({ text: text }, hint), settings); }
	catch (e) { return Promise.reject(e); }
}

/* extractFromFile(dataUrl, settings, hint) -> Promise<{ fields, raw }> */
function extractFromFile(dataUrl, settings, hint) {
	var bad = ready(settings);
	if (bad) return Promise.reject(new Error(bad));
	try { return send(buildContent({ dataUrl: dataUrl }, hint), settings); }
	catch (e) { return Promise.reject(e); }
}

return {
	MODEL: MODEL, DOC_TYPES: DOC_TYPES, ready: ready,
	extractFields: extractFields, extractFromFile: extractFromFile,
	_internals: { stripFences: stripFences, SCHEMA_PROMPT: SCHEMA_PROMPT, buildContent: buildContent }
};
})();
