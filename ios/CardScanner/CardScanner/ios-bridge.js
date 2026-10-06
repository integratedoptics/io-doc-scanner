/* Card Scanner — iOS bridge.
   Injected at document start, before app.js runs, so app.js finds a ready
   window.Android object and the web layer stays byte-identical between the
   Android and the iOS build.

   WKWebView cannot call native code synchronously, so the synchronous parts of
   the contract are served entirely inside JavaScript:
     readData / writeData  -> localStorage (persistent WKWebsiteDataStore)
     readAsset             -> window.CS_ASSETS, injected by the native side
     appVersion            -> window.CS_VERSION, injected by the native side
     readCardImage         -> "" (thumbnails are stored inside the card record)
     saveToDocuments       -> returns the planned path at once and hands the
                              bytes to native, which writes the file and warns
                              through a toast if the write fails
   Everything else is a plain async postMessage. */
(function () {
"use strict";

function send(name, args) {
	try {
		window.webkit.messageHandlers.native.postMessage({ fn: name, args: args || [] });
	} catch (e) {
		console.log("[bridge] no native host:", name);
	}
}

window.Android = {
	appVersion: function () { return window.CS_VERSION || "1.1"; },

	toast: function (msg) { send("toast", [String(msg)]); },

	takePhoto: function () { send("takePhoto", []); },
	pickPhoto: function () { send("pickPhoto", []); },
	reOcr: function (name) { send("reOcr", [String(name || "")]); },

	/* Accounts documents: a PDF/picture from Files, or a photo from the camera.
	   Both answer through window.onDocPicked({ok, name, dataUrl, error}). */
	pickDocument: function () { send("pickDocument", []); },
	captureDocument: function () { send("captureDocument", []); },

	readData: function (name) {
		try { return localStorage.getItem("cs:" + name) || ""; } catch (e) { return ""; }
	},
	writeData: function (name, content) {
		try { localStorage.setItem("cs:" + name, content); return true; }
		catch (e) { send("toast", ["Could not save: storage is full"]); return false; }
	},

	readAsset: function (name) { return (window.CS_ASSETS || {})[name] || ""; },

	/* Full-size stored pictures are not read back on iOS; every card keeps its
	   own thumbnail, so the preview still works. */
	readCardImage: function () { return ""; },
	deleteCardImage: function (name) { send("deleteCardImage", [String(name || "")]); return true; },

	saveToDocuments: function (name, b64, mime) {
		send("saveFile", [String(name), String(b64), String(mime || "")]);
		return JSON.stringify({
			ok: true,
			path: "On My iPhone/Card Scanner/" + name,
			uri: "file://documents/" + name
		});
	},

	shareFiles: function (urisJson, title) { send("shareFiles", [String(urisJson), String(title || "")]); },

	httpPostJson: function (url, headersJson, body, timeoutSec, reqId) {
		send("httpPostJson", [String(url), String(headersJson), String(body),
			Number(timeoutSec) || 30, String(reqId)]);
	},

	/* Any method, any status code, cookies kept — this is what the ERPNext sync
	   uses. The reply comes back through window.onHttp as {"status":n,"body":"…"}
	   or as "ERR:<message>". */
	httpRequest: function (method, url, headersJson, body, timeoutSec, reqId) {
		send("httpRequest", [String(method || "GET"), String(url), String(headersJson || "{}"),
			String(body == null ? "" : body), Number(timeoutSec) || 30, String(reqId)]);
	}
};
})();
