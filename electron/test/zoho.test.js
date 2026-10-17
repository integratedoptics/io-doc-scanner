/* zoho.test.js — app/zoho.js against a mock Zoho server (OAuth, inbox listing, attachments) with scam samples.
       npm test */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const zoho = require("../app/zoho");

const NOW = Date.now();
const PDF = (extra) => Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n" + (extra || "") + "\n%%EOF", "latin1");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40000)]);
const PASS = (d) => ({ "Authentication-Results": ["mx.zohomail.eu; dkim=pass header.d=" + d + "; spf=pass; dmarc=pass header.from=" + d] });
const FAIL = (d) => ({ "Authentication-Results": ["mx.zohomail.eu; dkim=none; spf=fail; dmarc=fail header.from=" + d] });

/* messageId -> mail definition */
const MAILS = {
	"1001": { subject: "Invoice IO-114", sender: "Acme Billing", from: "billing@acme.com", hdr: PASS("acme.com"),
		atts: [{ id: "a1", name: "IO-114.pdf", size: 5000, data: PDF() }, { id: "a2", name: "logo.png", size: 3000, data: Buffer.alloc(3000) }] },
	"1002": { subject: "Quote", sender: "New Vendor", from: "sales@newvendor.eu", hdr: PASS("newvendor.eu"),
		atts: [{ id: "b1", name: "quote.pdf", size: 4000, data: PDF() }] },
	"1003": { subject: "Invoice", sender: "Acme Billing", from: "billing@acme.com", hdr: FAIL("acme.com"),
		atts: [{ id: "c1", name: "invoice.pdf", size: 4000, data: PDF() }] },
	"1004": { subject: "Invoice attached", sender: "DHL", from: "billing@dhl-express-billing.net", hdr: PASS("dhl-express-billing.net"),
		atts: [{ id: "d1", name: "awb.pdf", size: 4000, data: PDF() }] },
	"1005": { subject: "Doc", sender: "x", from: "x@evil.example", hdr: PASS("evil.example"),
		atts: [{ id: "e1", name: "setup.exe", size: 90000, data: Buffer.from("MZ") }, { id: "e2", name: "a.zip", size: 900, data: Buffer.from("PK") },
			{ id: "e3", name: "invoice.exe.pdf", size: 900, data: Buffer.from("MZ") }] },
	"1006": { subject: "Invoice", sender: "Acme Billing", from: "billing@acme.com", hdr: PASS("acme.com"),
		atts: [{ id: "f1", name: "real.pdf", size: 4000, data: Buffer.concat([Buffer.from("MZ\x90\x00", "latin1"), Buffer.alloc(300)]) }] },
	"1007": { subject: "Invoice", sender: "Acme Billing", from: "billing@acme.com", hdr: PASS("acme.com"),
		atts: [{ id: "g1", name: "launch.pdf", size: 4000, data: PDF("<< /S /Launch /F (cmd.exe) >>") },
			{ id: "g2", name: "script.pdf", size: 4000, data: PDF("<< /S /JavaScript /JS (x) >>") },
			{ id: "g3", name: "scan.png", size: 40008, data: PNG }] },
	"1008": { subject: "Our bank details have changed", sender: "Acme Billing", from: "billing@acme.com", hdr: Object.assign(PASS("acme.com"), { "Reply-To": ["acme.billing@gmail.com"] }),
		atts: [{ id: "h1", name: "notice.pdf", size: 4000, data: PDF() }] },
	"1009": { subject: "Old", sender: "Acme Billing", from: "billing@acme.com", hdr: PASS("acme.com"), old: true,
		atts: [{ id: "i1", name: "old.pdf", size: 4000, data: PDF() }] }
};

function startServer() {
	const state = { tokenCalls: [], refreshCalls: 0, validAccess: "AT1", apiCalls: [], expireNext: false, downloads: [] };
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
		if (url.pathname === "/oauth/v2/token") {
			let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
				const p = new URLSearchParams(body); state.tokenCalls.push(Object.fromEntries(p));
				if (p.get("grant_type") === "authorization_code") {
					if (p.get("code") !== "GOODCODE") return send(200, { error: "invalid_code" });
					if (p.get("client_secret") !== "SECRET") return send(200, { error: "invalid_client_secret" });
					return send(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600, api_domain: "x" });
				}
				if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "RT1") {
					state.refreshCalls++; state.validAccess = "AT" + (state.refreshCalls + 1);
					return send(200, { access_token: state.validAccess, expires_in: 3600 });
				}
				return send(400, { error: "invalid_code" });
			});
			return;
		}
		if (!/^Zoho-oauthtoken /.test(req.headers.authorization || "") || req.headers.authorization.split(" ")[1] !== state.validAccess) {
			return send(401, { status: { code: 401, description: "INVALID_OAUTHTOKEN" } });
		}
		state.apiCalls.push(url.pathname + url.search);
		const p = url.pathname;
		if (p === "/api/accounts") return send(200, { status: { code: 200 }, data: [{ accountId: "5551", primaryEmailAddress: "evaldas@integratedoptics.com" }] });
		if (p === "/api/accounts/5551/folders") return send(200, { status: { code: 200 }, data: [{ folderId: "11", folderType: "Sent" }, { folderId: "10", folderType: "Inbox" }] });
		if (p === "/api/accounts/5551/messages/view") {
			if (url.searchParams.get("folderId") !== "10") return send(200, { data: [] });
			const data = Object.keys(MAILS).map((id) => ({
				messageId: id, folderId: "10", subject: MAILS[id].subject, sender: MAILS[id].sender, fromAddress: MAILS[id].from, summary: "",
				hasAttachment: "1", receivedTime: String(NOW - (MAILS[id].old ? 40 : 1) * 86400000)
			}));
			return send(200, { status: { code: 200 }, data: data });
		}
		let m = p.match(/^\/api\/accounts\/5551\/folders\/10\/messages\/(\d+)\/(attachmentinfo|header)$/);
		if (m && MAILS[m[1]]) {
			const mail = MAILS[m[1]];
			if (m[2] === "attachmentinfo") return send(200, { data: { attachments: mail.atts.map((a) => ({ attachmentId: a.id, attachmentName: a.name, attachmentSize: a.size })) } });
			const h = Object.assign({ From: [mail.sender + " <" + mail.from + ">"], Subject: [mail.subject] }, mail.hdr);
			return send(200, { data: { headerContent: h, messageId: m[1] } });
		}
		m = p.match(/^\/api\/accounts\/5551\/folders\/10\/messages\/(\d+)\/attachments\/(\w+)$/);
		if (m && MAILS[m[1]]) {
			const a = MAILS[m[1]].atts.find((x) => x.id === m[2]);
			if (!a) return send(404, {});
			state.downloads.push(m[1] + "/" + m[2]);
			res.writeHead(200, { "Content-Type": "application/octet-stream" }); return res.end(a.data);
		}
		send(404, { status: { code: 404 } });
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
		const base = "http://127.0.0.1:" + server.address().port;
		resolve({ server, state, base });
	}));
}

function memStore() {
	let v = null;
	return { load: () => (v ? JSON.parse(JSON.stringify(v)) : null), save: (o) => { v = JSON.parse(JSON.stringify(o)); }, clear: () => { v = null; }, peek: () => v };
}

async function setup() {
	const srv = await startServer();
	const store = memStore();
	const z = zoho.create({ store: store, endpoints: { eu: { label: "t", accounts: srv.base, mail: srv.base } } });
	return Object.assign(srv, { store, z });
}

const TRUST = "acme.com";

test("connect: wrong code and wrong secret are explained, nothing is stored", async () => {
	const t = await setup();
	await assert.rejects(t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "BAD" }), /invalid_code.*expired/s);
	await assert.rejects(t.z.connect({ region: "eu", clientId: "ID", clientSecret: "NOPE", code: "GOODCODE" }), /Client Secret/);
	await assert.rejects(t.z.connect({ region: "eu", clientId: "", clientSecret: "x", code: "y" }), /Enter the Client ID/);
	assert.equal(t.store.peek(), null);
	assert.equal(t.z.status().connected, false);
	await assert.rejects(t.z.list({ days: 14 }), /not connected/);
	t.server.closeAllConnections(); t.server.close();
});

test("connect: stores the refresh token, reads the mailbox address", async () => {
	const t = await setup();
	const st = await t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "GOODCODE" });
	assert.equal(st.connected, true);
	assert.equal(st.email, "evaldas@integratedoptics.com");
	assert.equal(t.store.peek().refreshToken, "RT1");
	t.server.closeAllConnections(); t.server.close();
});

test("list: trusted / check / risky verdicts, hidden dangerous files, old mail dropped", async () => {
	const t = await setup();
	await t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "GOODCODE" });
	const r = await t.z.list({ days: 14, trusted: TRUST });
	const by = (id) => r.mails.find((m) => m.messageId === id);
	assert.equal(by("1001").level, "trusted");
	assert.deepEqual(by("1001").attachments.map((a) => a.name), ["IO-114.pdf"]);   // the 3 KB logo is not offered
	assert.equal(by("1001").hiddenAttachments, 1);
	assert.equal(by("1002").level, "check");
	assert.equal(by("1003").level, "risky");                                     // trusted domain, failed checks
	assert.ok(by("1003").reasons.some((x) => x.code === "auth-fail"));
	assert.equal(by("1004").level, "risky");                                     // look-alike of DHL
	assert.equal(by("1005"), undefined);                                         // only an .exe, a .zip and a disguised name
	assert.equal(by("1008").level, "risky");                                     // trusted sender, replies go to gmail
	assert.equal(by("1009"), undefined);                                         // 40 days old
	assert.equal(r.blockedFiles, 3);
	assert.equal(r.hiddenMails, 1);
	assert.equal(r.account, "evaldas@integratedoptics.com");
	// only reads: the mock saw GETs for list, folders, accounts, info and headers — and never a download
	assert.equal(t.state.downloads.length, 0);
	t.server.closeAllConnections(); t.server.close();
});

test("list: the same mails are 'check' when the sender is not trusted", async () => {
	const t = await setup();
	await t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "GOODCODE" });
	const r = await t.z.list({ days: 14, trusted: "" });
	assert.equal(r.mails.find((m) => m.messageId === "1001").level, "check");
	t.server.closeAllConnections(); t.server.close();
});

test("fetch: the sender is judged again, and an unconfirmed check is refused", async () => {
	const t = await setup();
	await t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "GOODCODE" });
	const ok = await t.z.fetchAttachment({ folderId: "10", messageId: "1001", attachmentId: "a1", name: "IO-114.pdf", ack: "", trusted: TRUST });
	assert.match(ok.dataUrl, /^data:application\/pdf;base64,/);
	assert.equal(ok.level, "trusted");
	// a page that claims everything is fine cannot skip the confirmation
	await assert.rejects(t.z.fetchAttachment({ folderId: "10", messageId: "1002", attachmentId: "b1", name: "quote.pdf", ack: "", trusted: TRUST }), /not confirmed/);
	assert.ok(!t.state.downloads.includes("1002/b1"));
	const chk = await t.z.fetchAttachment({ folderId: "10", messageId: "1002", attachmentId: "b1", name: "quote.pdf", ack: "check", trusted: TRUST });
	assert.equal(chk.level, "check");
	// a risky sender needs the stronger confirmation; "check" is not enough
	await assert.rejects(t.z.fetchAttachment({ folderId: "10", messageId: "1003", attachmentId: "c1", name: "invoice.pdf", ack: "check", trusted: TRUST }), /not confirmed/);
	const risky = await t.z.fetchAttachment({ folderId: "10", messageId: "1003", attachmentId: "c1", name: "invoice.pdf", ack: "risky", trusted: TRUST });
	assert.equal(risky.level, "risky");
	assert.ok(risky.warnings.some((w) => /could not confirm/.test(w)));
	// a look-alike of DHL needs the strong confirmation too
	await assert.rejects(t.z.fetchAttachment({ folderId: "10", messageId: "1004", attachmentId: "d1", name: "awb.pdf", ack: "check", trusted: TRUST }), /not confirmed/);
	t.server.closeAllConnections(); t.server.close();
});

test("fetch: bad content is refused even for a trusted sender and a full acknowledgement", async () => {
	const t = await setup();
	await t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "GOODCODE" });
	await assert.rejects(t.z.fetchAttachment({ folderId: "10", messageId: "1006", attachmentId: "f1", name: "real.pdf", ack: "risky", trusted: TRUST }), /Refused.*windows program/s);
	await assert.rejects(t.z.fetchAttachment({ folderId: "10", messageId: "1007", attachmentId: "g1", name: "launch.pdf", ack: "risky", trusted: TRUST }), /Refused.*launch/is);
	const js = await t.z.fetchAttachment({ folderId: "10", messageId: "1007", attachmentId: "g2", name: "script.pdf", ack: "", trusted: TRUST });
	assert.ok(js.warnings.some((w) => /JavaScript/.test(w)));
	const png = await t.z.fetchAttachment({ folderId: "10", messageId: "1007", attachmentId: "g3", name: "scan.png", ack: "", trusted: TRUST });
	assert.equal(png.mime, "image/png");
	// disguised or dangerous names are refused before any download
	const before = t.state.downloads.length;
	await assert.rejects(t.z.fetchAttachment({ folderId: "10", messageId: "1005", attachmentId: "e3", name: "invoice.exe.pdf", ack: "risky", trusted: "" }), /Refused/);
	await assert.rejects(t.z.fetchAttachment({ folderId: "10", messageId: "1005", attachmentId: "e1", name: "setup.exe", ack: "risky", trusted: "" }), /Refused/);
	assert.equal(t.state.downloads.length, before);
	t.server.closeAllConnections(); t.server.close();
});

test("an expired access token is refreshed once and the call repeated", async () => {
	const t = await setup();
	await t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "GOODCODE" });
	t.state.validAccess = "SOMETHING-ELSE";   // the server no longer accepts AT1
	// the refresh grant answers with a new valid token
	const r = await t.z.list({ days: 14, trusted: TRUST });
	assert.ok(r.mails.length > 0);
	assert.equal(t.state.refreshCalls, 1);
	t.server.closeAllConnections(); t.server.close();
});

test("disconnect forgets the credentials", async () => {
	const t = await setup();
	await t.z.connect({ region: "eu", clientId: "ID", clientSecret: "SECRET", code: "GOODCODE" });
	await t.z.disconnect();
	assert.equal(t.store.peek(), null);
	assert.equal(t.z.status().connected, false);
	t.server.closeAllConnections(); t.server.close();
});

test("the credential file store: encrypted when the keychain is available, plain-file fallback otherwise", () => {
	const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zoho-"));
	const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("ENC:" + Buffer.from(s).toString("base64")), decryptString: (b) => Buffer.from(b.toString().slice(4), "base64").toString() };
	const st = zoho.fileStore(dir, fs, path, fake);
	st.save({ refreshToken: "SECRET-RT" });
	const onDisk = fs.readFileSync(path.join(dir, "zoho.bin")).toString();
	assert.ok(!onDisk.includes("SECRET-RT"));
	assert.equal(st.load().refreshToken, "SECRET-RT");
	st.clear();
	assert.equal(st.load(), null);
	const plain = zoho.fileStore(dir, fs, path, null);
	plain.save({ refreshToken: "RT-PLAIN" });
	assert.equal(plain.load().refreshToken, "RT-PLAIN");
	assert.equal(plain.encrypted(), false);
	plain.clear();
	fs.rmSync(dir, { recursive: true, force: true });
});
