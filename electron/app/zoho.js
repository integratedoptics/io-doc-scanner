/* zoho.js — read-only access to the user's Zoho Mail inbox, for fetching PDF/picture attachments into the app.

   Runs in the Electron main process. The web page never sees the Zoho credentials: it asks this module for a LIST of
   mails with a safety verdict per sender and per attachment, and later for ONE attachment, and gets back only a data
   URL. Every safety decision (see mailsafety.js) is taken here again at download time — the verdict the page showed
   is not trusted.

   Authentication: a Zoho "Self Client" (api-console.zoho.eu -> Self Client -> Generate Code, scopes
   ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.folders.READ). The one-time code is exchanged for a refresh
   token, which is kept encrypted (Electron safeStorage) in the app's data folder. Only read scopes are requested; the
   app cannot send, delete or move mail. Hosts are fixed per region — nothing the page sends can redirect a request to
   another server.

   Written from Zoho's published API documentation; the EU data centre is accounts.zoho.eu / mail.zoho.eu. */
"use strict";

const safety = require("./mailsafety");

const REGIONS = {
	eu: { label: "Europe (zoho.eu)", accounts: "https://accounts.zoho.eu", mail: "https://mail.zoho.eu" },
	com: { label: "United States / global (zoho.com)", accounts: "https://accounts.zoho.com", mail: "https://mail.zoho.com" },
	in: { label: "India (zoho.in)", accounts: "https://accounts.zoho.in", mail: "https://mail.zoho.in" },
	au: { label: "Australia (zoho.com.au)", accounts: "https://accounts.zoho.com.au", mail: "https://mail.zoho.com.au" },
	jp: { label: "Japan (zoho.jp)", accounts: "https://accounts.zoho.jp", mail: "https://mail.zoho.jp" }
};
const SCOPES = "ZohoMail.accounts.READ,ZohoMail.messages.READ,ZohoMail.folders.READ";

/* a listing never goes beyond this many mails, and no attachment is read before the user picks it */
const MAX_MAILS = 40;
const SMALL_IMAGE = 20 * 1024;   // logos and signature pictures are not documents

class ZohoError extends Error {
	constructor(message, code) { super(message); this.name = "ZohoError"; this.code = code || "error"; }
}

function mapPool(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const workers = [];
	for (let w = 0; w < Math.min(limit, items.length); w++) {
		workers.push((async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		})());
	}
	return Promise.all(workers).then(() => out);
}

/* opts.store     { load() -> object|null, save(object), clear() }
   opts.fetch     fetch implementation (tests pass a mock)
   opts.endpoints overrides REGIONS (tests only; never reachable from the web page) */
function create(opts) {
	const store = opts.store;
	const doFetch = opts.fetch || fetch;
	const regions = opts.endpoints || REGIONS;
	let cache = { token: "", expires: 0, accountId: "", folderId: "" };

	function conf() { return store.load() || null; }

	function endpoints(region) {
		const r = regions[region] || regions.eu;
		if (!r) throw new ZohoError("Unknown Zoho region.", "region");
		return r;
	}

	async function http(url, init, timeoutMs) {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
		try {
			return await doFetch(url, Object.assign({ signal: ctrl.signal }, init));
		} catch (e) {
			if (e && e.name === "AbortError") throw new ZohoError("Zoho did not answer in time.", "timeout");
			throw new ZohoError("Could not reach Zoho: " + ((e && e.cause && e.cause.code) || (e && e.message) || String(e)), "network");
		} finally {
			clearTimeout(timer);
		}
	}

	async function tokenCall(region, params) {
		const body = new URLSearchParams(params).toString();
		const r = await http(endpoints(region).accounts + "/oauth/v2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: body
		});
		let j = {};
		try { j = JSON.parse(await r.text()); } catch (e) { /* not JSON */ }
		if (!r.ok || j.error || !j.access_token) {
			const why = j.error || ("HTTP " + r.status);
			const hint = {
				invalid_code: "The code is wrong, already used, or expired (it is valid for only a few minutes). Generate a new one.",
				invalid_client: "The Client ID or Client Secret is wrong, or the region is not the one the client was created in.",
				invalid_client_secret: "The Client Secret is wrong.",
				access_denied: "Access was denied.",
				invalid_scope: "The scopes are wrong. Generate the code with: " + SCOPES
			}[j.error] || "";
			throw new ZohoError("Zoho refused the sign-in (" + why + "). " + hint, "auth");
		}
		return j;
	}

	async function accessToken() {
		const c = conf();
		if (!c || !c.refreshToken) throw new ZohoError("Zoho Mail is not connected. Connect it in Settings first.", "not-connected");
		if (cache.token && Date.now() < cache.expires - 60000) return cache.token;
		const j = await tokenCall(c.region, { grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret });
		cache.token = j.access_token;
		cache.expires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
		return cache.token;
	}

	/* GET against the mail API; one automatic retry with a fresh token on 401 */
	async function api(path, query, config) {
		const c = conf();
		if (!c) throw new ZohoError("Zoho Mail is not connected. Connect it in Settings first.", "not-connected");
		const base = endpoints(c.region).mail;
		const qs = query ? "?" + new URLSearchParams(query).toString() : "";
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = await accessToken();
			const r = await http(base + path + qs, { method: "GET", headers: {
				Authorization: "Zoho-oauthtoken " + token,
				Accept: (config && config.accept) || "application/json"
			} }, (config && config.timeout) || 30000);
			if (r.status === 401 && attempt === 0) { cache.token = ""; continue; }
			if (!r.ok) {
				let msg = "";
				try { const j = JSON.parse(await r.text()); msg = (j.data && j.data.errorCode) || (j.status && j.status.description) || ""; } catch (e) { /* ignore */ }
				throw new ZohoError("Zoho Mail answered " + r.status + (msg ? " (" + msg + ")" : "") + " for " + path.replace(/\/\d{6,}/g, "/…") + ".", "http-" + r.status);
			}
			if (config && config.binary) return Buffer.from(await r.arrayBuffer());
			try { return JSON.parse(await r.text()); } catch (e) { throw new ZohoError("Zoho Mail sent an answer that is not JSON.", "format"); }
		}
		throw new ZohoError("Zoho Mail rejected the access token.", "auth");
	}

	async function account() {
		if (cache.accountId) return cache.accountId;
		const j = await api("/api/accounts");
		const list = Array.isArray(j.data) ? j.data : (j.data ? [j.data] : []);
		const a = list[0];
		if (!a || !a.accountId) throw new ZohoError("No mail account found for this Zoho login.", "no-account");
		cache.accountId = String(a.accountId);
		const c = conf();
		const email = a.primaryEmailAddress || a.mailboxAddress || (a.emailAddress && a.emailAddress[0] && a.emailAddress[0].mailId) || "";
		if (c && email && c.email !== email) { c.email = email; store.save(c); }
		return cache.accountId;
	}

	async function inboxId(acc) {
		if (cache.folderId) return cache.folderId;
		const j = await api("/api/accounts/" + acc + "/folders");
		const list = Array.isArray(j.data) ? j.data : [];
		const f = list.find((x) => String(x.folderType || "").toLowerCase() === "inbox") ||
			list.find((x) => String(x.folderName || "").toLowerCase() === "inbox");
		if (!f) throw new ZohoError("The Inbox folder was not found.", "no-inbox");
		cache.folderId = String(f.folderId);
		return cache.folderId;
	}

	function ownDomains(extra) {
		const c = conf();
		const set = new Set((extra || []).map((d) => String(d).toLowerCase()));
		if (c && c.email && c.email.indexOf("@") > 0) set.add(c.email.slice(c.email.indexOf("@") + 1).toLowerCase());
		return Array.from(set);
	}

	function headerValue(map, name) {
		const v = map[name.toLowerCase()];
		return v && v.length ? v[0] : "";
	}

	async function messageHeaders(acc, folderId, messageId) {
		const j = await api("/api/accounts/" + acc + "/folders/" + folderId + "/messages/" + messageId + "/header", { raw: "false" });
		const hc = j && j.data && j.data.headerContent;
		return hc || {};
	}

	/* ------------------------------------------------------------------------------ public */

	return {
		regions: () => Object.keys(regions).map((k) => ({ id: k, label: regions[k].label })),
		scopes: () => SCOPES,

		status() {
			const c = conf();
			return { connected: !!(c && c.refreshToken), region: c ? c.region : "", email: c ? c.email || "" : "" };
		},

		/* exchanges the one-time code for a refresh token and checks that the mailbox can be read */
		async connect(p) {
			const region = p && regions[p.region] ? p.region : "eu";
			const clientId = String((p && p.clientId) || "").trim();
			const clientSecret = String((p && p.clientSecret) || "").trim();
			const code = String((p && p.code) || "").trim();
			if (!clientId || !clientSecret || !code) throw new ZohoError("Enter the Client ID, the Client Secret and the code.", "input");
			const j = await tokenCall(region, { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code: code });
			if (!j.refresh_token) throw new ZohoError("Zoho did not return a refresh token. Generate the code again from the Self Client tab.", "auth");
			cache = { token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000, accountId: "", folderId: "" };
			store.save({ region: region, clientId: clientId, clientSecret: clientSecret, refreshToken: j.refresh_token, email: "" });
			try {
				await account();
				await inboxId(cache.accountId);
			} catch (e) {
				store.clear(); cache = { token: "", expires: 0, accountId: "", folderId: "" };
				if (e instanceof ZohoError && /^http-(401|403)$/.test(e.code)) {
					throw new ZohoError("Signed in, but the mailbox cannot be read. Generate the code with these scopes: " + SCOPES, "scope");
				}
				throw e;
			}
			return this.status();
		},

		async disconnect() {
			const c = conf();
			if (c && c.refreshToken) {
				try {   // best effort: ask Zoho to void the token as well
					await http(endpoints(c.region).accounts + "/oauth/v2/token/revoke?token=" + encodeURIComponent(c.refreshToken), { method: "POST" }, 10000);
				} catch (e) { /* ignore */ }
			}
			store.clear();
			cache = { token: "", expires: 0, accountId: "", folderId: "" };
			return this.status();
		},

		/* The recent inbox mails that carry a PDF or picture, each with a verdict.
		   p: { days, trusted, own } */
		async list(p) {
			const days = Math.max(1, Math.min(60, Number(p && p.days) || 14));
			const acc = await account();
			const folder = await inboxId(acc);
			const own = ownDomains(p && p.own);
			const j = await api("/api/accounts/" + acc + "/messages/view", {
				folderId: folder, limit: "100", start: "1", sortBy: "date", sortorder: "false", attachedMails: "true"
			});
			const cutoff = Date.now() - days * 86400000;
			const rows = (Array.isArray(j.data) ? j.data : []).filter((m) =>
				String(m.hasAttachment) === "1" && (Number(m.receivedTime) || Date.now()) >= cutoff).slice(0, MAX_MAILS);

			let hiddenMails = 0, blockedFiles = 0;
			const mails = (await mapPool(rows, 4, async (m) => {
				const folderId = String(m.folderId || folder);
				let info, headers = {};
				try {
					info = await api("/api/accounts/" + acc + "/folders/" + folderId + "/messages/" + m.messageId + "/attachmentinfo");
				} catch (e) { return { error: e.message }; }
				const atts = (info && info.data && (info.data.attachments || info.data)) || [];
				const items = [];
				let hidden = 0;
				(Array.isArray(atts) ? atts : []).forEach((a) => {
					const name = a.attachmentName || a.name || "";
					const size = Number(a.attachmentSize || a.size) || 0;
					const fv = safety.checkFileName(name);
					if (fv.dangerous) blockedFiles++;
					if (!fv.listable) { hidden++; return; }
					if (fv.kind === "image" && size && size < SMALL_IMAGE) { hidden++; return; }   // logo / signature picture
					items.push({ attachmentId: String(a.attachmentId || a.id), name: name, size: size, kind: fv.kind });
				});
				if (!items.length) { hiddenMails++; return null; }
				try { headers = await messageHeaders(acc, folderId, m.messageId); } catch (e) { headers = {}; }
				const norm = safety.normaliseHeaders(headers);
				const verdict = safety.analyseSender({
					from: headerValue(norm, "from") || (decodeFrom(m)),
					replyTo: headerValue(norm, "reply-to"),
					subject: m.subject, summary: m.summary, headers: headers, trusted: p && p.trusted, own: own
				});
				return {
					messageId: String(m.messageId), folderId: folderId, subject: m.subject || "", sender: m.sender || verdict.from.display || "",
					fromAddress: verdict.from.address, received: Number(m.receivedTime) || 0,
					level: verdict.level, reasons: verdict.reasons, auth: verdict.auth, attachments: items, hiddenAttachments: hidden
				};
			})).filter(Boolean);
			const failed = mails.filter((m) => m.error).length;
			return { mails: mails.filter((m) => !m.error), hiddenMails: hiddenMails, blockedFiles: blockedFiles, failed: failed, account: conf().email || "", days: days };
		},

		/* One attachment. p: { folderId, messageId, attachmentId, name, ack ("", "check", "risky"), trusted, own }
		   The sender is judged again from the mail's own headers; the acknowledgement must cover the result. */
		async fetchAttachment(p) {
			if (!p || !p.messageId || !p.attachmentId) throw new ZohoError("Missing attachment reference.", "input");
			const acc = await account();
			const folderId = String(p.folderId || await inboxId(acc));
			const fv = safety.checkFileName(p.name);
			if (!fv.listable) throw new ZohoError("Refused: " + (fv.issues[0] ? fv.issues[0].text : "this file type is not accepted."), "blocked");
			let headers = {};
			try { headers = await messageHeaders(acc, folderId, p.messageId); } catch (e) { headers = {}; }
			const norm = safety.normaliseHeaders(headers);
			const verdict = safety.analyseSender({
				from: headerValue(norm, "from"), replyTo: headerValue(norm, "reply-to"), subject: headerValue(norm, "subject"),
				headers: headers, trusted: p.trusted, own: ownDomains(p.own)
			});
			if (!safety.ackCovers(p.ack || "", verdict.level)) {
				throw new ZohoError("Not opened: the sender check says \"" + verdict.level + "\" and was not confirmed.", "ack");
			}
			const buf = await api("/api/accounts/" + acc + "/folders/" + folderId + "/messages/" + p.messageId + "/attachments/" + p.attachmentId,
				null, { binary: true, accept: "*/*", timeout: 90000 });
			const cv = safety.checkContent(fv.kind, buf);
			if (!cv.ok) throw new ZohoError("Refused: " + cv.issues.filter((i) => i.level === "block").map((i) => i.text).join(" "), "blocked");
			const mime = cv.kind === "pdf" ? "application/pdf" : cv.kind === "png" ? "image/png" : "image/jpeg";
			let name = require("path").basename(String(p.name)).normalize("NFC");
			if (cv.kind === "png" && !/\.png$/i.test(name)) name = name.replace(/\.[^.]*$/, "") + ".png";
			return {
				name: name, mime: mime, size: buf.length, dataUrl: "data:" + mime + ";base64," + buf.toString("base64"),
				level: verdict.level, warnings: cv.issues.filter((i) => i.level !== "info").map((i) => i.text).concat(
					verdict.reasons.filter((r) => r.level !== "good").map((r) => r.text)),
				from: verdict.from.address
			};
		}
	};
}

/* the list call gives the sender separately; used only when the header call failed */
function decodeFrom(m) {
	const name = m && m.sender ? String(m.sender) : "";
	const addr = m && m.fromAddress ? String(m.fromAddress) : "";
	return name && addr ? name + " <" + addr + ">" : (addr || name);
}

/* ------------------------------------------------------------------------------------ credential store */

/* The store used by the app: a JSON file in the user-data folder, encrypted with the operating system's keychain
   (Electron safeStorage) when that is available. `fs`, `path` and `safeStorage` are passed in so tests can fake them. */
function fileStore(dir, fs, path, safeStorage) {
	const file = path.join(dir, "zoho.bin");
	return {
		load() {
			try {
				const raw = fs.readFileSync(file);
				const text = raw[0] === 0x7b ? raw.toString("utf8")
					: (safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : "");
				return text ? JSON.parse(text) : null;
			} catch (e) { return null; }
		},
		save(obj) {
			const text = JSON.stringify(obj);
			let data;
			if (safeStorage && safeStorage.isEncryptionAvailable()) data = safeStorage.encryptString(text);
			else data = Buffer.from(text, "utf8");   // no keychain: plain file, readable by this user only
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, data, { mode: 0o600 });
		},
		clear() { try { fs.unlinkSync(file); } catch (e) { /* nothing stored */ } },
		encrypted() { return !!(safeStorage && safeStorage.isEncryptionAvailable()); }
	};
}

module.exports = { create, fileStore, ZohoError, REGIONS, SCOPES };
