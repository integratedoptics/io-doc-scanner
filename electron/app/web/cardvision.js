/* cardvision.js — reads a business-card photo directly with Claude's vision,
   for shells with no on-device OCR of their own. Android/iOS still do native
   on-device OCR (ML Kit / Vision) first, so this module isn't used there;
   it exists specifically for the desktop (Electron) shell, which has no
   native OCR and — per the desktop scope decision — sends the card photo to
   Claude instead of vendoring an offline OCR engine. Mirrors extract.js in
   shape (same model, same key, same JSON-schema-prompt pattern) but takes an
   image instead of pre-extracted text, since Claude can read the photo
   directly with no separate text-extraction step needed for a single image.

   Uses the SAME Anthropic key as extract.js (settings.key, wired from
   S.extract_key) — one "document field extraction" key in Settings now
   covers both accounts-document text extraction and, on desktop only,
   business-card photo extraction, since both are just different content
   types sent to the same Messages API call. */
window.CS_CARDVISION = (function () {
"use strict";

var MODEL = "claude-sonnet-5";
var API_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";

var SCHEMA_PROMPT =
"You are reading a photo of a business card. Reply with ONLY a single JSON " +
"object — no markdown fences, no commentary — with exactly these keys, " +
"each a string or null if that field isn't printed on the card:\n\n" +
"{\n" +
"  \"salutation\": e.g. \"Mr\", \"Ms\", \"Dr\", or null,\n" +
"  \"first_name\": null,\n" +
"  \"middle_name\": null,\n" +
"  \"last_name\": null,\n" +
"  \"designation\": job title, or null,\n" +
"  \"department\": null,\n" +
"  \"company_name\": null,\n" +
"  \"email\": null,\n" +
"  \"email_secondary\": a second email if two are printed, or null,\n" +
"  \"mobile_no\": a number explicitly marked mobile/cell, or null,\n" +
"  \"phone\": a landline/office number, or null,\n" +
"  \"fax\": null,\n" +
"  \"website\": null,\n" +
"  \"linkedin\": only if a linkedin.com URL is literally printed on the card — never guess one,\n" +
"  \"address_line1\": null,\n" +
"  \"address_line2\": null,\n" +
"  \"city\": null,\n" +
"  \"state\": state/region/county, or null,\n" +
"  \"pincode\": postal/zip code, or null,\n" +
"  \"country\": null,\n" +
"  \"notes\": anything worth a human double-checking (illegible text, a card in an " +
"unfamiliar script, ambiguous name-ordering), or \"\"\n" +
"}\n\n" +
"Never invent a value that isn't visible on the card. If unsure which printed number is " +
"mobile vs. landline, put it in \"phone\" and say so in \"notes\".";

function stripFences(s) {
	var t = String(s || "").trim();
	var m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return m ? m[1] : t;
}

function ready(settings) {
	if (!settings || !settings.key) {
		return "Set the Anthropic API key for document/card field extraction in Settings first.";
	}
	return "";
}

function mediaTypeOf(dataUrl) {
	var m = String(dataUrl || "").match(/^data:([^;,]+)/);
	return (m && m[1]) || "image/jpeg";
}

/* extractCard(dataUrl, settings) -> Promise<{ fields, raw }> */
function extractCard(dataUrl, settings) {
	var bad = ready(settings);
	if (bad) return Promise.reject(new Error(bad));

	var comma = String(dataUrl || "").indexOf(",");
	var b64 = comma >= 0 ? dataUrl.slice(comma + 1) : String(dataUrl || "");
	if (!b64) return Promise.reject(new Error("No picture to read."));

	var body = JSON.stringify({
		model: MODEL,
		max_tokens: 1024,
		temperature: 0,
		messages: [{
			role: "user",
			content: [
				{ type: "image", source: { type: "base64", media_type: mediaTypeOf(dataUrl), data: b64 } },
				{ type: "text", text: SCHEMA_PROMPT }
			]
		}]
	});

	return window.CS_NET.request("POST", API_URL, {
		"Content-Type": "application/json",
		"x-api-key": settings.key,
		"anthropic-version": ANTHROPIC_VERSION
	}, body, 60).then(function (r) {
		if (r.status < 200 || r.status >= 300) {
			var msg = "The card-reading request failed (" + r.status + ")";
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
			throw new Error("Could not read the card fields back as JSON.");
		}
		return { fields: parsed, raw: replyText };
	});
}

return { MODEL: MODEL, ready: ready, extractCard: extractCard,
	_internals: { stripFences: stripFences, SCHEMA_PROMPT: SCHEMA_PROMPT } };
})();
