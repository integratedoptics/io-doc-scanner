/* test_extract.js — request building and reply parsing for extract.js, with the
   network stubbed. Run: node tests/test_extract.js */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/extract.js");
var sent = null, reply = null;
var sb = { window: { CS_NET: { request: function (m, url, headers, body) {
	sent = { method: m, url: url, headers: headers, body: JSON.parse(body) };
	return Promise.resolve(reply);
} } }, console: console };
vm.createContext(sb);
vm.runInContext(fs.readFileSync(file, "utf8"), sb, { filename: file });
var X = sb.window.CS_EXTRACT;

var fails = 0;
function check(l, c) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l); }

(async function () {
	var P = X._internals.SCHEMA_PROMPT;
	["Sąskaitą išrašė", "Pardavėjas", "Pirkėjas", "Įmonės kodas", "PVM mokėtojo kodas", "Apmokėti iki", "Suma, EUR",
		"Rechnungsempfänger", "USt-IdNr.", "Zahlbar bis", "Gesamtbetrag", "Frachtrechnung", "Zollanmeldung",
		"Muitinės deklaracija", "Išankstinė sąskaita", "Proformarechnung", "Bestellnummer", "Handelsregisternummer",
		"balandžio", "Dezember", "1.234,56", "Serija E Nr. 202604-122", "NEVER put the buyer"]
		.forEach(function (w) { check("prompt mentions " + w, P.indexOf(w) >= 0); });
	check("prompt names our own company codes so they are not mistaken for the supplier",
		P.indexOf("302833442") >= 0 && P.indexOf("LT100007179012") >= 0);

	/* text request */
	reply = { status: 200, body: JSON.stringify({ content: [{ text: "```json\n{\"supplier_name\":\"ESEMDA, UAB\",\"total_amount\":3856.39}\n```" }] }) };
	var r = await X.extractFields("PVM SĄSKAITA FAKTŪRA …", { key: "k" }, "purchase_invoice");
	check("fenced JSON reply is parsed", r.fields.supplier_name === "ESEMDA, UAB" && r.fields.total_amount === 3856.39);
	check("text goes into one string message", typeof sent.body.messages[0].content === "string" &&
		sent.body.messages[0].content.indexOf("--- DOCUMENT TEXT ---\nPVM SĄSKAITA") > 0);
	check("hint is passed along", sent.body.messages[0].content.indexOf("purchase_invoice") > 0);
	check("key and version headers", sent.headers["x-api-key"] === "k" && !!sent.headers["anthropic-version"]);
	check("model", sent.body.model === "claude-sonnet-5");
	check("no temperature parameter (deprecated for this model)", !("temperature" in sent.body) && !("top_p" in sent.body) && !("top_k" in sent.body));
	/* a file goes with its text layer, and the prompt explains side-by-side seller / buyer columns */
	await X.extractFromFile("data:application/pdf;base64,QUJD", { key: "k" }, "purchase_invoice", "Tiekėjas: UAB \"Nano Vita\" Pirkėjas: UAB \"Integrated optics\"");
	check("file request: document block first, then one text block carrying prompt and text layer",
		sent.body.messages[0].content[0].type === "document" && sent.body.messages[0].content[1].type === "text" &&
		/TEXT LAYER OF THE FILE[^\n]*\n[\s\S]*Tiekėjas: UAB "Nano Vita"/.test(sent.body.messages[0].content[1].text));
	await X.extractFromFile("data:application/pdf;base64,QUJD", { key: "k" }, "");
	check("file request without a text layer has no text-layer section", !/TEXT LAYER/.test(sent.body.messages[0].content[1].text));
	var SPR = X._internals.SCHEMA_PROMPT;
	check("prompt: seller/buyer rule for side-by-side columns", /SIDE BY SIDE/.test(SPR) && /Tiekėjas/.test(SPR) && /Pirkėjas/.test(SPR) &&
		/never the supplier/.test(SPR));
	check("no workspace header unless a workspace is set", !("anthropic-workspace-id" in sent.headers));
	await X.extractFields("x", { key: "k", workspace: " wrkspc_123 " }, "");
	check("workspace header sent (trimmed) when set", sent.headers["anthropic-workspace-id"] === "wrkspc_123");
	await X.extractFromFile("data:application/pdf;base64,QUJD", { key: "k", workspace: "wrkspc_123" }, "");
	check("workspace header also sent for file requests", sent.headers["anthropic-workspace-id"] === "wrkspc_123");

	/* the prompt knows both our companies, the customer fields and the intercompany rule */
	var SP = X._internals.SCHEMA_PROMPT;
	check("prompt names both of our companies", /Integrated Optics UAB/.test(SP) && /IO Integrated Optics GmbH/.test(SP));
	check("prompt asks for the customer and the issuer flag", /customer_name/.test(SP) && /customer_tax_id/.test(SP) && /issuer_is_ours/.test(SP));
	check("prompt states the intercompany rule", /intercompany/i.test(SP) && /UAB billing its subsidiary/.test(SP));

	/* PDF and image requests */
	await X.extractFromFile("data:application/pdf;base64,QUJD", { key: "k" }, "");
	var c = sent.body.messages[0].content;
	check("PDF is sent as a document block first", c[0].type === "document" && c[0].source.media_type === "application/pdf" &&
		c[0].source.data === "QUJD" && c[1].type === "text");
	await X.extractFromFile("data:image/jpeg;base64,QUJD", { key: "k" }, "");
	check("JPEG is sent as an image block", sent.body.messages[0].content[0].type === "image" &&
		sent.body.messages[0].content[0].source.media_type === "image/jpeg");
	await X.extractFromFile("data:image/png;base64,QUJD", { key: "k" }, "");
	check("PNG is sent as an image block", sent.body.messages[0].content[0].source.media_type === "image/png");

	/* failures */
	var e1 = null; try { await X.extractFromFile("data:text/plain;base64,QUJD", { key: "k" }, ""); } catch (e) { e1 = e; }
	check("unsupported type is refused with a clear message", !!e1 && /Only PDF, JPEG and PNG/.test(e1.message));
	var e2 = null; try { await X.extractFromFile("data:application/pdf;base64," + new Array(27e6).join("A"), { key: "k" }, ""); } catch (e) { e2 = e; }
	check("oversized file is refused before sending", !!e2 && /too large/.test(e2.message));
	var e3 = null; try { await X.extractFields("x", {}, ""); } catch (e) { e3 = e; }
	check("no key is refused", !!e3 && /API key/.test(e3.message));
	reply = { status: 401, body: JSON.stringify({ error: { message: "invalid x-api-key" } }) };
	var e4 = null; try { await X.extractFields("x", { key: "bad" }, ""); } catch (e) { e4 = e; }
	check("API error text is surfaced", !!e4 && /401/.test(e4.message) && /invalid x-api-key/.test(e4.message));
	reply = { status: 200, body: JSON.stringify({ content: [{ text: "Sorry, I can't" }] }) };
	var e5 = null; try { await X.extractFields("x", { key: "k" }, ""); } catch (e) { e5 = e; }
	check("non-JSON reply is reported", !!e5 && /JSON/.test(e5.message));
	check("non-JSON reply: the message shows how it began", /Sorry, I can/.test(e5.message));
	reply = { status: 200, body: JSON.stringify({ content: [{ text: "Here are the fields:\n{\"document_no\":\"26LTVA10002C3B64R0\",\"supplier_name\":\"Muitinės departamentas\"}\nLet me know." }] }) };
	var rp = await X.extractFields("x", { key: "k" }, "customs_declaration");
	check("JSON with a sentence before and after it is still read", rp.fields.document_no === "26LTVA10002C3B64R0");
	reply = { status: 200, body: JSON.stringify({ stop_reason: "max_tokens", content: [{ text: "{\"document_no\":\"26LT" }] }) };
	var e6 = null; try { await X.extractFields("x", { key: "k" }, ""); } catch (x) { e6 = x; }
	check("a reply cut off at the token limit is named as such", !!e6 && /cut off/.test(e6.message));
	check("the reply limit is large enough for a long form", sent.body.max_tokens >= 4096);

	/* plain completion for the card clean-up / LinkedIn lookup */
	reply = { status: 200, body: JSON.stringify({ content: [{ text: "{\"first_name\":\"Jane\"}" }] }) };
	var ct = await X.complete({ prov: "anthropic", key: "sk-ant-x", workspace: " wrkspc_1 ", model: "" }, "clean this", 1500);
	check("complete (Anthropic): text comes back, default model, key, version and workspace headers",
		ct === "{\"first_name\":\"Jane\"}" && sent.url === "https://api.anthropic.com/v1/messages" && sent.body.model === "claude-sonnet-5" &&
		sent.headers["x-api-key"] === "sk-ant-x" && sent.headers["anthropic-workspace-id"] === "wrkspc_1" && !("temperature" in sent.body));
	await X.complete({ prov: "anthropic", key: "k", url: "https://example.com/v1/chat/completions" }, "p");
	check("complete: a non-Anthropic address in the endpoint box is ignored for Anthropic", sent.url === "https://api.anthropic.com/v1/messages");
	await X.complete({ prov: "anthropic", key: "k" }, "p");
	check("complete: no workspace header when none is set", !("anthropic-workspace-id" in sent.headers));
	reply = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "{\"a\":\"b\"}" } }] }) };
	var co = await X.complete({ prov: "openai", key: "sk-o", model: "" }, "p");
	check("complete (OpenAI-style): reads choices[0].message.content, Bearer key, json mode", co === "{\"a\":\"b\"}" &&
		sent.url === "https://api.openai.com/v1/chat/completions" && sent.headers.Authorization === "Bearer sk-o" && sent.body.response_format.type === "json_object");
	reply = { status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header" } }) };
	var e7 = null; try { await X.complete({ prov: "anthropic", key: "k" }, "p"); } catch (x) { e7 = x; }
	check("complete: a refused request shows the server's message instead of an empty answer", !!e7 && /failed \(400\)/.test(e7.message) && /workspace/.test(e7.message), e7 && e7.message);
	var e8 = null; try { await X.complete({ prov: "anthropic", key: "" }, "p"); } catch (x) { e8 = x; }
	check("complete: no key is reported", !!e8 && /no API key/.test(e8.message));

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
