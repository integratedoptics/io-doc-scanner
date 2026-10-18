/* mailsafety.test.js — the scam filter for mailbox attachments (app/mailsafety.js). npm test */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../app/mailsafety");

const PDF = (extra) => Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n" + (extra || "") + "\n%%EOF\n", "latin1");

test("file names: only PDF/JPG/PNG are listed", () => {
	assert.equal(s.checkFileName("Invoice 12.03.2026.pdf").listable, true);
	assert.equal(s.checkFileName("scan.JPEG").kind, "image");
	assert.equal(s.checkFileName("a.png").listable, true);
	["invoice.exe", "invoice.zip", "doc.docm", "page.html", "x.svg", "x.js", "x.iso", "x.eml", "noext", "x.txt"].forEach((n) => {
		assert.equal(s.checkFileName(n).listable, false, n);
	});
});

test("file names: disguises are blocked", () => {
	const dbl = s.checkFileName("invoice.exe.pdf");
	assert.equal(dbl.listable, false);
	assert.ok(dbl.issues.some((i) => i.code === "double-extension"));
	assert.equal(s.checkFileName("invoice.pdf.exe").listable, false);
	assert.equal(s.checkFileName("invoice\u202Efdp.exe").listable, false);            // right-to-left override
	assert.equal(s.checkFileName("invoice\u200b.pdf").listable, false);                // zero-width character
	assert.equal(s.checkFileName("invoice                     .pdf").listable, false);   // padded with spaces
	assert.equal(s.checkFileName("C:\\evil\\..\\invoice.pdf").listable, true);        // path part is dropped
	assert.equal(s.checkFileName("").listable, false);
	// a date with dots is not a disguise
	assert.equal(s.checkFileName("INV.2026.03.12.pdf").listable, true);
});

test("content: the bytes must match the name", () => {
	assert.equal(s.checkContent("pdf", PDF()).ok, true);
	const mz = Buffer.concat([Buffer.from("MZ\x90\x00", "latin1"), Buffer.alloc(100)]);
	const r = s.checkContent("pdf", mz);
	assert.equal(r.ok, false);
	assert.match(r.issues[0].text, /windows program/);
	assert.equal(s.checkContent("pdf", Buffer.from("<html><script>alert(1)</script>")).ok, false);
	assert.equal(s.checkContent("pdf", Buffer.from("PK\x03\x04restofzip", "latin1")).ok, false);
	assert.equal(s.checkContent("image", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).ok, true);
	assert.equal(s.checkContent("image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).ok, true);
	assert.equal(s.checkContent("image", PDF()).ok, false);
	assert.equal(s.checkContent("pdf", Buffer.alloc(0)).ok, false);
	// a few junk bytes before %PDF- are tolerated (some generators write them)
	assert.equal(s.checkContent("pdf", Buffer.concat([Buffer.from("\r\n\r\n"), PDF()])).ok, true);
});

test("pdf scan: programs are blocked, scripts warned, e-invoice XML tolerated", () => {
	const launch = s.checkContent("pdf", PDF("<< /S /Launch /F (cmd.exe) >>"));
	assert.equal(launch.ok, false);
	// an escaped name does not get past the scan
	assert.equal(s.checkContent("pdf", PDF("<< /S /La#75nch >>")).ok, false);
	const exe = s.checkContent("pdf", PDF("<< /Type /Filespec /F (setup.exe) /EmbeddedFile >>"));
	assert.equal(exe.ok, false);
	const js = s.checkContent("pdf", PDF("<< /S /JavaScript /JS (app.alert(1)) >>"));
	assert.equal(js.ok, true);
	assert.ok(js.issues.some((i) => i.code === "pdf-script" && i.level === "warn"));
	const js2 = s.checkContent("pdf", PDF("<< /S /J#61vaScript >>"));
	assert.ok(js2.issues.some((i) => i.code === "pdf-script"));
	const zug = s.checkContent("pdf", PDF("<< /Type /Filespec /F (factur-x.xml) /EF << /F 9 0 R >> >> /EmbeddedFile"));
	assert.equal(zug.ok, true);
	assert.ok(zug.issues.some((i) => i.code === "pdf-attachment" && i.level === "info"));
	assert.ok(s.checkContent("pdf", PDF("/Encrypt 5 0 R")).issues.some((i) => i.code === "pdf-encrypted"));
	// a plain invoice with a web link is fine and silent
	const plain = s.checkContent("pdf", PDF("<< /S /URI /URI (https://supplier.com/pay) >>"));
	assert.equal(plain.ok, true);
	assert.equal(plain.issues.length, 0);
});

test("addresses and trusted list", () => {
	assert.deepEqual(s.parseAddress("ACME Ltd <Billing@Acme.COM>"), { address: "billing@acme.com", domain: "acme.com", display: "ACME Ltd" });
	assert.equal(s.parseAddress("&quot;A&quot; &lt;a@b.lt&gt;").address, "a@b.lt");
	assert.equal(s.parseAddress("plain@x.org").domain, "x.org");
	const t = s.parseTrusted("acme.com, @dhl.de\n*.ups.com ann@small.lt");
	assert.deepEqual(t.domains, ["acme.com", "dhl.de", "ups.com"]);
	assert.deepEqual(t.addresses, ["ann@small.lt"]);
});

const PASS = { "Authentication-Results": ["mx.zohomail.eu; dkim=pass header.d=acme.com; spf=pass smtp.mailfrom=acme.com; dmarc=pass header.from=acme.com"] };
const FAIL = { "Authentication-Results": ["mx.zohomail.eu; dkim=none; spf=fail smtp.mailfrom=acme.com; dmarc=fail header.from=acme.com"] };

test("sender: trusted and verified", () => {
	const v = s.analyseSender({ from: "Acme <billing@acme.com>", headers: PASS, trusted: "acme.com", own: ["integratedoptics.com"], subject: "Invoice 123" });
	assert.equal(v.level, "trusted");
	assert.equal(v.known, true);
});

test("sender: unknown but clean is 'check'", () => {
	const v = s.analyseSender({ from: "sales@newvendor.eu", headers: PASS, trusted: "acme.com", subject: "Invoice" });
	assert.equal(v.level, "check");
	assert.ok(v.reasons.some((r) => r.code === "unknown-sender"));
});

test("sender: trusted domain that fails the checks is forged -> risky", () => {
	const v = s.analyseSender({ from: "billing@acme.com", headers: FAIL, trusted: "acme.com" });
	assert.equal(v.level, "risky");
	assert.ok(v.reasons.some((r) => r.code === "auth-fail"));
});

test("sender: no authentication result -> check, never trusted", () => {
	const v = s.analyseSender({ from: "billing@acme.com", headers: {}, trusted: "acme.com" });
	assert.equal(v.level, "check");
	assert.ok(v.reasons.some((r) => r.code === "auth-unknown"));
});

test("sender: a lower, sender-written Authentication-Results line is ignored", () => {
	const h = { "Authentication-Results": ["mx.zohomail.eu; dmarc=fail; spf=fail; dkim=none", "evil.example; dmarc=pass; spf=pass; dkim=pass"] };
	assert.equal(s.analyseSender({ from: "billing@acme.com", headers: h, trusted: "acme.com" }).level, "risky");
});

test("sender: look-alike domains", () => {
	const t = { trusted: "acme-optics.com", own: ["integratedoptics.com"], headers: PASS };
	assert.equal(s.analyseSender(Object.assign({ from: "x@acme-optlcs.com" }, t)).level, "risky");           // one letter off
	assert.equal(s.analyseSender(Object.assign({ from: "x@integratedopt1cs.com" }, t)).level, "risky");      // 1 for i
	assert.equal(s.analyseSender(Object.assign({ from: "x@integratedoptics.com.pay-now.ru" }, t)).level, "risky"); // name inside a longer one
	assert.equal(s.analyseSender(Object.assign({ from: "billing@dhl-express-billing.net" }, t)).level, "risky");
	assert.equal(s.analyseSender(Object.assign({ from: "x@dhl.de" }, t)).reasons.some((r) => r.code === "lookalike"), false);   // real DHL ending
	assert.ok(s.analyseSender(Object.assign({ from: "x@acme-optics.lt" }, t)).reasons.some((r) => r.code === "lookalike"));       // other ending: only a warning
	assert.notEqual(s.analyseSender(Object.assign({ from: "x@acme-optics.lt" }, t)).level, "risky");
});

test("sender: own domain must verify", () => {
	const t = { trusted: "", own: ["integratedoptics.com"] };
	assert.equal(s.analyseSender(Object.assign({ from: "ceo@integratedoptics.com", headers: FAIL }, t)).level, "risky");
	assert.equal(s.analyseSender(Object.assign({ from: "ceo@integratedoptics.com", headers: {} }, t)).level, "risky");
	assert.notEqual(s.analyseSender(Object.assign({ from: "ceo@integratedoptics.com", headers: PASS }, t)).level, "risky");
});

test("sender: the own-domain warning says what was read", () => {
	const t = { trusted: "", own: ["integratedoptics.com"] };
	const none = s.analyseSender(Object.assign({ from: "ceo@integratedoptics.com", headers: {} }, t)).reasons.find((r) => r.code === "own-domain-unverified");
	assert.match(none.text, /no SPF\/DKIM\/DMARC result/);
	const fail = s.analyseSender(Object.assign({ from: "ceo@integratedoptics.com", headers: FAIL }, t)).reasons.find((r) => r.code === "own-domain-unverified");
	assert.match(fail.text, /SPF \S+, DKIM \S+, DMARC \S+/);
});

test("sender: display-name trick, Reply-To redirect, free webmail, bank-change wording", () => {
	const spoof = s.analyseSender({ from: "\"billing@acme.com\" <x@gmail.com>", headers: PASS });
	assert.equal(spoof.level, "risky");
	const rt = s.analyseSender({ from: "billing@acme.com", replyTo: "acme.invoice@gmail.com", headers: PASS, trusted: "acme.com" });
	assert.equal(rt.level, "risky");
	const rt2 = s.analyseSender({ from: "billing@unknown.com", replyTo: "ops@other.com", headers: PASS });
	assert.ok(rt2.reasons.some((r) => r.code === "reply-to"));
	assert.ok(s.analyseSender({ from: "x@gmail.com", headers: PASS }).reasons.some((r) => r.code === "free-mail"));
	["Our bank details have changed", "Please use our new bank account", "URGENT payment required today", "Neue Bankverbindung ab sofort",
		"Pakeisti banko rekvizitai", "Final reminder: invoice overdue", "Please verify your account"].forEach((txt) => {
		const v = s.analyseSender({ from: "billing@acme.com", headers: PASS, trusted: "acme.com", subject: txt });
		assert.ok(v.reasons.some((r) => r.code === "money-talk"), txt);
		assert.equal(v.level, "check", txt);   // trusted sender, but never one-click
	});
	assert.equal(s.analyseSender({ from: "billing@acme.com", headers: PASS, trusted: "acme.com", subject: "Invoice 2026-114 for PO-08353" }).level, "trusted");
});

test("sender: Received-SPF fallback, raw header text, and unicode domains", () => {
	const raw = "Received-SPF: pass (mx: domain of acme.com designates ip as permitted)\r\nFrom: a@acme.com\r\nSubject: x";
	assert.equal(s.authResults(s.normaliseHeaders(raw)).spf, "pass");
	assert.ok(s.analyseSender({ from: "x@аcme.com", headers: PASS }).reasons.some((r) => r.code === "idn"));   // Cyrillic a
	assert.ok(s.analyseSender({ from: "x@xn--cme-9cd.com", headers: PASS }).reasons.some((r) => r.code === "idn"));
});

test("acknowledgement levels", () => {
	assert.equal(s.ackCovers("", "trusted"), true);
	assert.equal(s.ackCovers("", "check"), false);
	assert.equal(s.ackCovers("check", "check"), true);
	assert.equal(s.ackCovers("check", "risky"), false);
	assert.equal(s.ackCovers("risky", "risky"), true);
	assert.equal(s.ackCovers("risky", "check"), true);
});
