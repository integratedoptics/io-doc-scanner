/* mailsafety.js — the scam filter for documents fetched from the mailbox.

   Pure functions, no network and no Electron, so the whole policy can be tested with plain Node (test/mailsafety.test.js).
   Used by zoho.js in the main process, which applies it on the server side of the app — the web page cannot talk
   it out of a verdict.

   Three layers, because each catches something the others miss:
     1. the FILE NAME   — only PDF, JPG and PNG are listed at all; disguised names (invoice.pdf.exe, hidden characters,
                          right-to-left override tricks) are blocked;
     2. the FILE CONTENT — the first bytes must really be what the name claims (an .exe renamed to .pdf is refused),
                          and a PDF is scanned for programs it would run (/Launch, /JavaScript, embedded executables);
     3. the SENDER      — is it on the trusted list; did the mail pass the receiving server's SPF / DKIM / DMARC
                          checks; does it use a look-alike of a trusted or well-known domain; does the Reply-To point
                          somewhere else; does the text ask for changed bank details or urgent payment.

   A sender ends up "trusted" (known and verified), "check" (unknown, nothing wrong found) or "risky" (something wrong).
   A file ends up listable, or blocked. Nothing here is a guarantee — it lowers the odds that someone opens a forgery by
   habit, and says why when it hesitates. */
"use strict";

/* ------------------------------------------------------------------------------------------ file names */

const ALLOWED = { pdf: "pdf", jpg: "image", jpeg: "image", png: "image" };

const DANGEROUS = new Set(["exe", "scr", "com", "bat", "cmd", "msi", "msp", "pif", "cpl", "dll", "js", "jse", "vbs", "vbe",
	"wsf", "wsh", "ps1", "psm1", "hta", "jar", "lnk", "url", "reg", "iso", "img", "vhd", "vhdx", "dmg", "pkg", "app", "apk",
	"sh", "command", "html", "htm", "xhtml", "shtml", "svg", "chm", "docm", "xlsm", "pptm", "dotm", "xlsb", "xlam", "one",
	"zip", "rar", "7z", "gz", "tar", "ace", "cab", "arj", "iqy", "slk", "appx", "msix", "website", "eml", "msg"]);

/* control characters, zero-width characters and the right-to-left / bidi overrides that make "gpj.exe" read as "exe.jpg" */
const HIDDEN_CHARS = /[\u0000-\u001f\u007f­؜᠎​-‏‪-‮⁠-⁩﻿]/;

function baseName(name) {
	return String(name == null ? "" : name).replace(/^.*[\\/]/, "");
}

/* Judges a file name before anything is downloaded.
   -> { listable, kind: "pdf"|"image"|null, issues: [{level: "block"|"warn", code, text}] } */
function checkFileName(rawName) {
	const issues = [];
	const name = baseName(rawName).normalize("NFC");
	if (!name) return { listable: false, kind: null, issues: [{ level: "block", code: "noname", text: "The attachment has no name." }] };
	if (HIDDEN_CHARS.test(name)) {
		issues.push({ level: "block", code: "hidden-chars", text: "The file name contains hidden or direction-changing characters, a way of disguising what a file really is." });
	}
	const parts = name.toLowerCase().split(".");
	const ext = parts.length > 1 ? parts[parts.length - 1].trim() : "";
	/* "invoice.exe.pdf": a program extension hiding in the middle */
	const inner = parts.slice(1, -1).map((s) => s.trim());
	const disguised = inner.find((s) => DANGEROUS.has(s));
	if (disguised) {
		issues.push({ level: "block", code: "double-extension", text: "The file name has a second extension (." + disguised + ") — a common way to disguise a program or script as a document." });
	}
	if (/\s{4,}\.[a-z0-9]{2,5}$/i.test(name)) {
		issues.push({ level: "block", code: "padded-name", text: "The file name is padded with spaces so that the real extension is hidden from view." });
	}
	const kind = ALLOWED[ext] || null;
	if (!kind && !issues.length) {
		const bad = DANGEROUS.has(ext);
		issues.push({ level: bad ? "block" : "warn", code: bad ? "dangerous-type" : "unsupported-type",
			text: bad ? "A ." + ext + " file can run code or hold a macro, so it is not offered." : "Only PDF, JPG and PNG attachments are offered." });
	}
	const blocked = issues.some((i) => i.level === "block");
	return { listable: !!kind && !blocked, kind: kind, issues: issues, dangerous: blocked || (!kind && DANGEROUS.has(ext)) };
}

/* ---------------------------------------------------------------------------------------- file content */

const MAX_PDF = 25 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;

/* what a file really is, from its first bytes */
function sniff(buf) {
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
	const head = b.subarray(0, 1024).toString("latin1");
	if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
	if (head.indexOf("%PDF-") >= 0 && head.indexOf("%PDF-") < 1024) return "pdf";
	if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return "windows program (.exe/.dll)";
	if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return "linux program";
	if (b.length >= 4 && b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) return "macOS program";
	if (b.length >= 4 && b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe) return "program (Java/macOS)";
	if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) return "zip archive or Office document";
	if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "old Office document (can hold macros)";
	if (/^\s*(<\s*!doctype\s+html|<\s*html|<\s*script|<\s*svg|<\?xml|<\s*a\s)/i.test(head)) return "web page or script";
	if (/^\s*\{\\rtf/i.test(head)) return "RTF document";
	if (/^#!/.test(head) || /^\s*@echo\s+off/i.test(head)) return "script";
	if (/^\s*%!PS/.test(head)) return "PostScript program";
	return "unknown";
}

/* PDF names may be written with #xx escapes (/J#61vaScript) to slip past a keyword search; undo that before searching */
function plainPdfText(buf) {
	return buf.toString("latin1").replace(/#([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

const EXEC_NAME = /\.(exe|scr|com|bat|cmd|msi|js|jse|vbs|vbe|wsf|ps1|hta|jar|lnk|dll|iso|reg|sh)$/i;

/* Looks inside a PDF for things a document has no business doing.
   Only the readable parts of the file are searched — objects packed into compressed streams are not seen — so a clean
   result is "nothing found", not "safe". The in-app viewer (pdf.js) does not run PDF scripts either way. */
function scanPdf(buf) {
	const text = plainPdfText(buf);
	const issues = [];
	if (/\/Launch\b/.test(text)) {
		issues.push({ level: "block", code: "pdf-launch", text: "The PDF contains a command to launch a program (/Launch)." });
	}
	let m; const nameRe = /\/(?:UF|F)\s*\(([^)]{1,200})\)/g;
	while ((m = nameRe.exec(text))) {
		if (EXEC_NAME.test(m[1].trim())) {
			issues.push({ level: "block", code: "pdf-embedded-exe", text: "The PDF carries an embedded program or script (" + m[1].trim().slice(0, 60) + ")." });
			break;
		}
	}
	if (/\/(JavaScript|JS)\b/.test(text)) {
		issues.push({ level: "warn", code: "pdf-script", text: "The PDF contains JavaScript. Invoices do not need it." });
	}
	if (/\/RichMedia\b/.test(text)) {
		issues.push({ level: "warn", code: "pdf-richmedia", text: "The PDF contains embedded media or Flash content." });
	}
	if (/\/(SubmitForm|ImportData)\b/.test(text)) {
		issues.push({ level: "warn", code: "pdf-submit", text: "The PDF contains a form that sends data to a server." });
	}
	if (/\/OpenAction\b/.test(text) && /\/(URI|GoToR|GoToE)\b/.test(text)) {
		issues.push({ level: "warn", code: "pdf-openaction", text: "The PDF does something automatically when opened (it jumps to a web address or another file)." });
	}
	if (/\/EmbeddedFile\b/.test(text) && !issues.some((i) => i.code === "pdf-embedded-exe")) {
		issues.push({ level: "info", code: "pdf-attachment", text: "The PDF has a file embedded in it (normal for e-invoices such as ZUGFeRD / Factur-X)." });
	}
	if (/\/Encrypt\b/.test(text)) {
		issues.push({ level: "warn", code: "pdf-encrypted", text: "The PDF is password-protected, so its content cannot be checked." });
	}
	return issues;
}

/* Judges the downloaded bytes against the claimed kind. -> { ok, issues } ; ok=false means: never open it. */
function checkContent(kind, buf) {
	const issues = [];
	const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
	if (!b.length) return { ok: false, issues: [{ level: "block", code: "empty", text: "The attachment is empty." }] };
	const real = sniff(b);
	const expected = kind === "pdf" ? "pdf" : null;
	if (kind === "pdf" && real !== "pdf") {
		issues.push({ level: "block", code: "type-mismatch", text: "Named like a PDF, but the content is a " + real + ". It was not opened." });
	} else if (kind === "image" && real !== "png" && real !== "jpeg") {
		issues.push({ level: "block", code: "type-mismatch", text: "Named like a picture, but the content is a " + real + ". It was not opened." });
	}
	const limit = kind === "pdf" ? MAX_PDF : MAX_IMAGE;
	if (b.length > limit) {
		issues.push({ level: "block", code: "too-big", text: "The file is larger than " + Math.round(limit / 1048576) + " MB." });
	}
	if (!issues.length && real === "pdf" && expected) issues.push.apply(issues, scanPdf(b));
	return { ok: !issues.some((i) => i.level === "block"), kind: real, issues: issues };
}

/* ------------------------------------------------------------------------------------------- the sender */

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
	"ymail.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net",
	"web.de", "mail.com", "mail.ru", "yandex.ru", "yandex.com", "inbox.lt", "one.lt", "takas.lt", "zoho.com", "zohomail.eu", "zohomail.com"]);

/* names a forger likes to imitate: couriers, customs, tax office, banks, big senders */
const WELL_KNOWN = ["dhl.com", "dhl.de", "ups.com", "fedex.com", "tnt.com", "dpd.com", "dpd.lt", "dpd.de", "gls-group.com",
	"omniva.lt", "lpexpress.lt", "vmi.lt", "sodra.lt", "lrmuitine.lt", "customs.gov.lt", "zoll.de", "swedbank.lt", "seb.lt",
	"luminor.lt", "revolut.com", "paypal.com", "microsoft.com", "office.com", "google.com", "amazon.com", "docusign.com",
	"docusign.net", "zoho.com", "zoho.eu"];

const MONEY_TALK = [
	/\b(bank|account|iban|payment|banking)\s+(details|information|data|account|instructions)\b[^.]{0,40}\b(chang|updat|new|revis)/i,
	/\b(chang|updat|new|revis)\w*\s+(of\s+)?(our\s+)?(bank|banking|payment)\s+(details|account|information)/i,
	/\bnew\s+(bank\s+)?account\b/i, /\bnew\s+iban\b/i,
	/\burgent(ly)?\b[^.]{0,30}\b(payment|transfer|invoice|wire)/i, /\bpayment\s+(is\s+)?(overdue|due\s+today)\b/i,
	/\b(final|last)\s+(reminder|notice|warning)\b/i, /\bwire\s+transfer\s+(today|now|asap)\b/i, /\bgift\s*card/i,
	/\b(verify|confirm)\s+your\s+(account|password|identity|email)\b/i, /\benable\s+(editing|content|macros)\b/i,
	/\b(shared|sent)\s+(a\s+)?(secure|protected)\s+(document|file)\b/i, /\bvoice\s*(mail|message)\b/i,
	/pakeist\w*\s+(mūsų\s+)?banko|nauj\w+\s+(banko\s+)?sąskait|banko\s+rekvizit\w*\s+(pasikeit|pakeist|atnaujin)|skubus\s+mokėjim|paskutinis\s+(priminimas|įspėjimas)/i,
	/neue\s+bankverbindung|(ge|ver)ändert\w*\s+bankverbindung|bankverbindung\s+(hat\s+sich\s+)?(ge|ver)ändert|dringende?\s+zahlung|letzte\s+mahnung|kontodaten\s+(ge|ver)ändert/i
];

function decodeEntities(s) {
	return String(s == null ? "" : s).replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&");
}

/* "Name <a@b.com>" -> { address, domain, display } (address and domain lowercase; empty strings when absent) */
function parseAddress(raw) {
	const s = decodeEntities(raw).trim();
	const angle = s.match(/<([^<>]+)>\s*$/);
	let addr = (angle ? angle[1] : s).trim().replace(/^mailto:/i, "");
	let display = angle ? s.slice(0, s.lastIndexOf("<")).trim().replace(/^"|"$/g, "") : "";
	const em = addr.match(/[^\s<>"',;()]+@[^\s<>"',;()]+/);
	addr = em ? em[0].toLowerCase() : "";
	return { address: addr, domain: addr ? addr.slice(addr.lastIndexOf("@") + 1).replace(/\.+$/, "") : "", display: display };
}

/* the entries of the trusted list: "supplier.com", "@supplier.com", "*.supplier.com", "ann@supplier.com" */
function parseTrusted(list) {
	const items = Array.isArray(list) ? list : String(list || "").split(/[\s,;]+/);
	const out = { domains: [], addresses: [] };
	items.forEach((x) => {
		let s = String(x || "").trim().toLowerCase().replace(/^\*@/, "@").replace(/^\*\./, "").replace(/^@/, "");
		if (!s) return;
		if (s.indexOf("@") > 0) out.addresses.push(s); else out.domains.push(s.replace(/^\./, ""));
	});
	return out;
}

function inDomain(domain, root) {
	return domain === root || domain.endsWith("." + root);
}

function isTrusted(from, trusted) {
	if (!from.address) return false;
	if (trusted.addresses.indexOf(from.address) >= 0) return true;
	return trusted.domains.some((d) => inDomain(from.domain, d));
}

function levenshtein(a, b) {
	const m = a.length, n = b.length;
	if (Math.abs(m - n) > 3) return 9;
	let prev = []; for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = cur;
	}
	return prev[n];
}

/* common letter swaps used to imitate a name: rn -> m, vv -> w, 0 -> o, 1 -> l */
function confusable(s) {
	return s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/0/g, "o").replace(/[1|]/g, "l").replace(/-/g, "");
}

function labelOf(domain) {
	const p = domain.split(".");
	return p.length > 1 ? p.slice(0, -1).join(".").replace(/^.*\./, "") : domain;
}

/* a look-alike of a name we know: one or two letters off, a swapped letter, or the name inside a longer made-up domain.
   -> null, or { known, how, strong } (strong = very likely an imitation; the same name under another ending is only weak) */
function lookalikeOf(domain, known) {
	if (known.some((k) => inDomain(domain, k))) return null;
	const la = labelOf(domain);
	const whole = domain.indexOf(".") > 0 ? domain.slice(0, domain.lastIndexOf(".")) : domain;   // everything before the ending
	for (const k of known) {
		const lk = labelOf(k);
		if (la === lk) return { known: k, how: "the same name under a different ending", strong: false };
		if (lk.length >= 5 && levenshtein(domain, k) <= 2) return { known: k, how: "one or two letters different", strong: true };
		if (lk.length >= 5 && confusable(la) === confusable(lk)) return { known: k, how: "letters that look alike", strong: true };
		if (lk.length >= 5 && whole.indexOf(lk) >= 0) return { known: k, how: "the name inside a longer one", strong: true };
		if (lk.length >= 3 && lk.length <= 4 && whole.split(/[-.]/).indexOf(lk) >= 0) return { known: k, how: "the name inside a longer one", strong: true };
	}
	return null;
}

/* Pulls the sender-authentication results out of the headers the receiving server added.
   `headers` is a map of header name -> array of values (Zoho's raw=false format) or a raw header string.
   Only the TOPMOST Authentication-Results counts: the receiving server puts its own above everything else, so lower
   ones may have been written by the sender. */
function normaliseHeaders(h) {
	const out = {};
	if (!h) return out;
	if (typeof h === "string") {
		const lines = h.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
		lines.forEach((ln) => {
			const i = ln.indexOf(":");
			if (i < 1) return;
			const k = ln.slice(0, i).trim().toLowerCase();
			(out[k] = out[k] || []).push(ln.slice(i + 1).trim());
		});
		return out;
	}
	Object.keys(h).forEach((k) => {
		const v = h[k];
		out[k.toLowerCase()] = (Array.isArray(v) ? v : [v]).map((x) => decodeEntities(String(x)));
	});
	return out;
}

function authResults(headers) {
	const res = { spf: "", dkim: "", dmarc: "", server: "", found: false };
	const ar = (headers["authentication-results"] || [])[0];
	if (ar) {
		res.found = true;
		res.server = (ar.split(";")[0] || "").trim().slice(0, 60);
		const re = /\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi; let m;
		while ((m = re.exec(ar))) { const k = m[1].toLowerCase(); if (!res[k]) res[k] = m[2].toLowerCase(); }
	}
	if (!res.spf) {
		const rs = (headers["received-spf"] || [])[0];
		const m = rs && rs.match(/^\s*([a-z]+)/i);
		if (m) { res.spf = m[1].toLowerCase(); res.found = true; }
	}
	return res;
}

/* How far to trust the receiving server's verdict: "pass", "fail", "weak" (nothing proven) or "unknown" (no result at all) */
function authVerdict(a) {
	if (!a.found) return "unknown";
	if (a.dmarc === "fail" || a.dmarc === "reject" || a.dmarc === "quarantine") return "fail";
	if (a.spf === "fail" && a.dkim !== "pass") return "fail";
	if (a.dkim === "fail" && a.spf !== "pass") return "fail";
	if (a.dmarc === "pass") return "pass";
	if (a.dkim === "pass" || a.spf === "pass") return "pass";
	return "weak";
}

/* Judges a sender.
   input: { from, replyTo, subject, summary, headers, trusted, own }
     from / replyTo   address strings ("Name <a@b.com>")
     headers          Zoho header map or raw header text (optional)
     trusted          the user's list (string or array)
     own              the user's own domains (array), e.g. ["integratedoptics.com"]
   -> { level: "trusted"|"check"|"risky", known: bool, reasons: [{level: "bad"|"warn"|"good", code, text}], auth, from } */
function analyseSender(input) {
	const reasons = [];
	const add = (level, code, text) => reasons.push({ level: level, code: code, text: text });
	const from = parseAddress(input.from);
	const reply = parseAddress(input.replyTo);
	const trusted = parseTrusted(input.trusted);
	const own = (input.own || []).map((d) => String(d).toLowerCase()).filter(Boolean);
	const headers = normaliseHeaders(input.headers);
	const auth = authResults(headers);
	const av = authVerdict(auth);
	const known = isTrusted(from, trusted);
	const fromOwn = own.some((d) => inDomain(from.domain, d));

	if (!from.address) add("bad", "no-sender", "The sender address could not be read.");

	/* the display name shows one address, the real one is another */
	const shown = from.display.match(/[^\s<>"',;()]+@[^\s<>"',;()]+/);
	if (shown && shown[0].toLowerCase().replace(/[.,;]+$/, "") !== from.address) {
		add("bad", "display-spoof", "The name shown (" + shown[0] + ") is a different address from the real sender (" + from.address + ").");
	}

	if (av === "fail") {
		add("bad", "auth-fail", "The receiving server could not confirm that this mail really comes from " + (from.domain || "that domain") +
			" (SPF " + (auth.spf || "-") + ", DKIM " + (auth.dkim || "-") + ", DMARC " + (auth.dmarc || "-") + "). It may be forged.");
	} else if (av === "weak") {
		add("warn", "auth-weak", "Nothing proves that this mail comes from " + (from.domain || "that domain") + " (SPF " + (auth.spf || "-") +
			", DKIM " + (auth.dkim || "-") + ", DMARC " + (auth.dmarc || "-") + ").");
	} else if (av === "unknown") {
		add("warn", "auth-unknown", "The sender checks (SPF/DKIM/DMARC) could not be read for this mail.");
	}

	if (fromOwn && av !== "pass") {
		add("bad", "own-domain-unverified", "The mail claims to come from your own domain (" + from.domain + ") but is not verified — internal-looking forgeries are a common trick.");
	}

	const lookup = [];
	trusted.domains.forEach((d) => lookup.push(d));
	own.forEach((d) => lookup.push(d));
	WELL_KNOWN.forEach((d) => lookup.push(d));
	if (from.domain && !known && !fromOwn) {
		const like = lookalikeOf(from.domain, Array.from(new Set(lookup)));
		if (like) add(like.strong ? "bad" : "warn", "lookalike", "The domain " + from.domain + " resembles " + like.known + " (" + like.how + ").");
	}

	if (/[^\x00-\x7f]/.test(from.domain) || /(^|\.)xn--/.test(from.domain)) {
		add("warn", "idn", "The sender's domain uses non-standard characters, which forgers use to imitate real names.");
	}

	if (reply.address && reply.domain && from.domain && reply.domain !== from.domain &&
		!inDomain(reply.domain, from.domain) && !inDomain(from.domain, reply.domain)) {
		const free = FREE_MAIL.has(reply.domain);
		add(known && !isTrusted(reply, trusted) ? "bad" : "warn", "reply-to",
			"Replies would go to a different address (" + reply.address + ")" + (free ? ", a free webmail account" : "") + ".");
	}

	if (!known && FREE_MAIL.has(from.domain)) {
		add("warn", "free-mail", "Sent from a free webmail address (" + from.domain + "), not a company domain.");
	}

	const talk = (String(input.subject || "") + " \n" + String(input.summary || ""));
	if (MONEY_TALK.some((re) => re.test(talk))) {
		add("warn", "money-talk", "The subject or text talks about changed bank details, urgent payment or a login — typical of payment-fraud mails. Confirm by phone with a known number.");
	}

	if (known) add("good", "trusted", "On your trusted list (" + (trusted.addresses.indexOf(from.address) >= 0 ? from.address : (trusted.domains.filter((d) => inDomain(from.domain, d))[0] || from.domain)) + ").");
	else if (!reasons.some((r) => r.level === "bad")) add("warn", "unknown-sender", "Not on your trusted list.");
	if (av === "pass") add("good", "auth-pass", "Sender checks passed (SPF " + (auth.spf || "-") + ", DKIM " + (auth.dkim || "-") + ", DMARC " + (auth.dmarc || "-") + ").");

	let level;
	if (reasons.some((r) => r.level === "bad")) level = "risky";
	else if (known && av === "pass" && !reasons.some((r) => r.level === "warn")) level = "trusted";
	else level = "check";
	return { level: level, known: known, reasons: reasons, auth: auth, from: from };
}

/* what the user has to acknowledge before a file of this sender is opened: "" | "check" | "risky" */
function needsAck(level) {
	return level === "risky" ? "risky" : level === "check" ? "check" : "";
}
function ackCovers(ack, level) {
	const need = needsAck(level);
	if (!need) return true;
	if (need === "check") return ack === "check" || ack === "risky";
	return ack === "risky";
}

module.exports = { checkFileName, checkContent, scanPdf, sniff, analyseSender, parseAddress, parseTrusted, normaliseHeaders,
	authResults, authVerdict, lookalikeOf, needsAck, ackCovers, FREE_MAIL, WELL_KNOWN, MAX_PDF, MAX_IMAGE };
