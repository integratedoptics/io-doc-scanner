/* pdfview.js — turns a scanned PDF into plain text, so extract.js has
   something to feed to the model. Wraps pdf.js (vendored as pdf.min.js /
   pdf.worker.min.js, MPL-2.0, legacy build — chosen over the default build
   for the widest compatibility across Android WebView, iOS WKWebView and
   Electron/Chromium without any native code) behind a single function, so
   the same implementation is shared by every shell instead of each one
   parsing PDFs its own way. */
window.CS_PDF = (function () {
"use strict";

var ready = false, readyError = "";

function init() {
	if (ready || readyError) return readyError;
	if (!window.pdfjsLib) {
		readyError = "pdf.js did not load — pdf.min.js is missing or failed to run.";
		return readyError;
	}
	try {
		window.pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
		ready = true;
	} catch (e) {
		readyError = "Could not set up pdf.js: " + (e.message || e);
	}
	return readyError;
}

function dataUrlToBytes(dataUrl) {
	var b64 = String(dataUrl || "");
	var comma = b64.indexOf(",");
	if (comma >= 0) b64 = b64.slice(comma + 1);
	var bin = atob(b64);
	var bytes = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/* extractText(dataUrl) -> Promise<{ text, pages }>
   `dataUrl` is a "data:application/pdf;base64,...." string (what a file
   input's FileReader.readAsDataURL, or a native bridge, hands back). Text
   is joined per page in reading order as pdf.js reports it — good enough
   for the model to work from; it does not try to rebuild a layout/table
   structure. */
function extractText(dataUrl) {
	var err = init();
	if (err) return Promise.reject(new Error(err));
	var bytes;
	try {
		bytes = dataUrlToBytes(dataUrl);
	} catch (e) {
		return Promise.reject(new Error("Could not read that file as a PDF."));
	}
	return window.pdfjsLib.getDocument({ data: bytes }).promise.then(function (doc) {
		var pages = doc.numPages;
		var chain = Promise.resolve([]);
		for (var p = 1; p <= pages; p++) {
			chain = chain.then(function (acc) {
				var pageNo = acc.length + 1;
				return doc.getPage(pageNo).then(function (page) {
					return page.getTextContent().then(function (tc) {
						var line = tc.items.map(function (it) { return it.str; }).join(" ");
						/* fillable PDF forms (a bank's payment order, for one) keep what was typed into the fields
						   as annotations, not as page text — add those values so they are read too */
						return Promise.resolve(page.getAnnotations ? page.getAnnotations() : []).then(function (anns) {
							var vals = [];
							(anns || []).forEach(function (a) {
								var v = a && (a.fieldValue !== undefined ? a.fieldValue : a.buttonValue);
								if (Array.isArray(v)) v = v.join(" ");
								if (typeof v === "string" && v.trim() && !/^(off|yes|on|no)$/i.test(v.trim())) vals.push(v.trim());
							});
							return vals;
						}, function () { return []; }).then(function (vals) {
							acc.push(vals.length ? line + " " + vals.join(" ") : line);
							return acc;
						});
					});
				});
			});
		}
		return chain.then(function (lines) {
			return { text: lines.join("\n\n"), pages: pages };
		});
	}).catch(function (e) {
		throw new Error("Could not read that PDF: " + (e && e.message ? e.message : e));
	});
}

return { extractText: extractText, ready: init };
})();
