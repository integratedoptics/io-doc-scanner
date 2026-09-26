/* net.js — the single owner of window.onHttp.

   Both the AI cleanup and the ERPNext sync need the native HTTP bridge, and the
   native side can only call one global callback, so all replies land here and
   get routed by request id.

   Two shapes are offered:
     raw(...)      resolves with the response body as a string, which is what
                   the AI cleanup has always expected
     request(...)  resolves with { status, body }, which the ERPNext sync needs
                   because it has to tell a 409 duplicate from a 417 validation
                   failure

   The native layer replies with either "ERR:<message>" or, for httpRequest, a
   JSON envelope { status, body }. Older bridges only have httpPostJson and
   answer with the bare body; that case is handled too so the AI cleanup keeps
   working if the web assets are ever newer than the shell. */
window.CS_NET = (function () {
"use strict";

var seq = 0;
var pending = {};

window.onHttp = function (reqId, payload) {
	var p = pending[reqId];
	if (!p) return;
	delete pending[reqId];
	clearTimeout(p.timer);
	p.done(payload);
};

function bridge() { return window.Android || {}; }

function register(timeout, done) {
	var id = "r" + (++seq) + "-" + Date.now();
	pending[id] = { done: done };
	pending[id].timer = setTimeout(function () {
		var p = pending[id];
		if (!p) return;
		delete pending[id];
		p.done("ERR:The server did not answer within " + timeout + " s.");
	}, (timeout + 6) * 1000);
	return id;
}

/* POST, body returned verbatim. cb(payloadString). */
function raw(url, headers, body, timeout, cb) {
	timeout = timeout || 45;
	var A = bridge();
	var id = register(timeout, cb);
	if (A.httpPostJson) A.httpPostJson(url, JSON.stringify(headers || {}), body || "", timeout, id);
	else window.onHttp(id, "ERR:This build has no network bridge.");
	return id;
}

/* Any method, resolves { status, body }. */
function request(method, url, headers, body, timeout) {
	timeout = timeout || 30;
	return new Promise(function (resolve, reject) {
		var A = bridge();
		var id = register(timeout, function (payload) {
			if (typeof payload === "string" && payload.indexOf("ERR:") === 0) {
				reject(new Error(payload.slice(4)));
				return;
			}
			var env = null;
			try { env = JSON.parse(payload); } catch (e) { env = null; }
			if (env && typeof env.status === "number") {
				resolve({ status: env.status, body: env.body === undefined ? "" : env.body });
			} else {
				// a bridge that only returns the body: assume it succeeded
				resolve({ status: 200, body: payload });
			}
		});
		if (A.httpRequest) {
			A.httpRequest(method, url, JSON.stringify(headers || {}), body || "", timeout, id);
		} else if (method === "POST" && A.httpPostJson) {
			A.httpPostJson(url, JSON.stringify(headers || {}), body || "", timeout, id);
		} else {
			window.onHttp(id, "ERR:This build cannot make " + method +
				" requests. Reinstall the app to get the ERPNext sync.");
		}
	});
}

return { raw: raw, request: request };
})();
