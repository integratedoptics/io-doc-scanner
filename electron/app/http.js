/* http.js — the desktop shell's HTTP client (runs in the Electron main
   process, plain Node).

   Why not just call fetch(): Node's fetch follows redirects itself and, per
   the Fetch spec, silently DROPS the Authorization header when a redirect
   crosses to a different origin — including the very common
   http -> https and example.com -> www.example.com hops in front of an
   ERPNext site. ERPNext then sees an anonymous request and answers
   403 PermissionError, which looks exactly like a permissions problem even
   though the key and secret are fine. The Android app's native HTTP client
   re-sends its headers on redirect, so the same settings worked there.

   So redirects are followed by hand: all headers (Authorization included)
   are kept when the target is the same host or the same host with/without
   a leading "www." — never when it is some unrelated host, so a credential
   can't be handed to a third party by a redirect. */
"use strict";

const MAX_REDIRECTS = 5;

function bareHost(host) {
	return String(host || "").toLowerCase().replace(/^www\./, "");
}

function sameSite(a, b) {
	return bareHost(a.hostname) === bareHost(b.hostname);
}

async function request(opts) {
	const timeoutMs = opts.timeoutMs || 30000;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		let method = opts.method || "GET";
		let url = new URL(opts.url);
		let headers = Object.assign({}, opts.headers || {});
		let body = opts.body || undefined;
		const hops = [];

		for (let i = 0; i <= MAX_REDIRECTS; i++) {
			const bodyless = method === "GET" || method === "HEAD";
			const r = await fetch(url.href, {
				method: method,
				headers: headers,
				body: bodyless ? undefined : body,
				redirect: "manual",
				signal: ctrl.signal
			});
			const loc = r.headers.get("location");
			if (r.status >= 300 && r.status < 400 && loc) {
				const next = new URL(loc, url);
				hops.push(r.status + " " + url.href + " -> " + next.href);
				if (!sameSite(url, next)) {
					headers = Object.assign({}, headers);
					Object.keys(headers).forEach((k) => {
						if (/^(authorization|cookie)$/i.test(k)) delete headers[k];
					});
				}
				// 301/302/303 turn a POST into a GET (as browsers do); 307/308 keep it
				if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) {
					method = "GET";
					body = undefined;
				}
				url = next;
				continue;
			}
			const text = await r.text();
			return { ok: true, status: r.status, body: text, finalUrl: url.href, hops: hops };
		}
		return { ok: false, error: "Too many redirects from " + opts.url + "." };
	} catch (e) {
		const msg = e && e.name === "AbortError"
			? "The server did not answer within " + Math.round(timeoutMs / 1000) + " s."
			: (e && e.cause && e.cause.code ? e.message + " (" + e.cause.code + ")" : (e && e.message) || String(e));
		return { ok: false, error: msg };
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { request, sameSite };
