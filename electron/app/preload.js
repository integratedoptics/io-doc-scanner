/* preload.js — the desktop shell's "native bridge". Runs before the shared
   web/ UI's own scripts, in the same JS realm as the page (main.js disables
   context isolation for this single, fully-trusted, offline bundled page —
   see the security note there), so simply assigning window.Android here is
   exactly equivalent to what MainActivity.java / the iOS WKWebView bridge
   do natively: erp.js, net.js and app.js need no changes to talk to it.

   Two small, backward-compatible additions were needed on the shared-web
   side to support this shell fully, both already made:
     - app.js: window.CS.showDraft(fields, image, thumb) now accepts the
       image/thumbnail too (previously fields only), so a card opened via
       Claude's vision reading (see cardvision.js) can show its picture and
       have it attached like a normally-scanned card.
     - index.html/app.js: the "Document field extraction" Anthropic key
       (S.extract_key) is now also used here for reading business-card
       photos directly (no on-device OCR exists on desktop) — see
       pickPhoto() below and cardvision.js.

   Desktop-specific behaviour, per the confirmed scope for this shell:
     - Camera: "Take a photo" opens the computer's webcam in an overlay
       (camera.js, shared with the Documents screen). A picture can also be
       chosen from disk. (Version 1.4 — earlier it was file picker only.)
     - No on-device OCR: a picked card photo is sent to Claude (using the
       same key as document extraction) to read its fields, since vendoring
       an offline OCR/WASM engine was decided against for this shell. If no
       key is configured, or the request fails, the picture is still saved
       and attached — the employee just fills in the fields by hand, same
       as it would if OCR found nothing on a phone. */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ipcRenderer, shell } = require("electron");

function userDataDir() {
	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support", "IO Doc Scanner");
	}
	if (process.platform === "win32") {
		return path.join(process.env.APPDATA || os.homedir(), "IO Doc Scanner");
	}
	return path.join(os.homedir(), ".io-doc-scanner");
}

var DATA_DIR = userDataDir();
var IMAGES_DIR = path.join(DATA_DIR, "card-images");
var DOCS_DIR = path.join(os.homedir(), "Documents", "CardScanner");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

function imageMime(nameOrPath) {
	return /\.png$/i.test(nameOrPath) ? "image/png" : "image/jpeg";
}
function imageExt(mime) {
	return /png/.test(mime) ? ".png" : ".jpg";
}

/* ---------------------------------------------------------------- HTTP bridge */

function doFetch(method, url, headersJson, body, timeout, id, rawBodyOnly) {
	var headers = {};
	try { headers = JSON.parse(headersJson || "{}"); } catch (e) { /* keep {} */ }
	ipcRenderer.invoke("http-fetch", { method: method, url: url, headers: headers, body: body, timeout: timeout })
		.then(function (r) {
			if (!r.ok) { window.onHttp(id, "ERR:" + r.error); return; }
			if (rawBodyOnly) { window.onHttp(id, r.body); return; }
			window.onHttp(id, JSON.stringify({ status: r.status, body: r.body }));
		})
		.catch(function (e) {
			window.onHttp(id, "ERR:" + ((e && e.message) || String(e)));
		});
}

/* A business-card picture (chosen from disk or taken with the webcam): store it, then
   have Claude read the card. Big photos are shrunk first — the reading service accepts
   at most 5 MB per picture. */
function processCardPhoto(buf, mime) {
	var dataUrl = "data:" + mime + ";base64," + buf.toString("base64");
	var prep = buf.length > 3 * 1024 * 1024 && window.CS_CAMERA
		? window.CS_CAMERA.shrink(dataUrl, 2400) : Promise.resolve(dataUrl);
	prep.then(function (small) {
		if (small !== dataUrl) { dataUrl = small; mime = "image/jpeg"; buf = Buffer.from(small.split(",")[1], "base64"); }
		var name = "card-" + Date.now() + imageExt(mime);
		fs.writeFileSync(path.join(IMAGES_DIR, name), buf);

		var settings = (window.CS && window.CS.settings()) || {};
		var bad = window.CS_CARDVISION.ready({ key: settings.extract_key });
		if (bad) {
			window.CS.showDraft({ notes: bad }, name, dataUrl);
			return;
		}
		window.CS_CARDVISION.extractCard(dataUrl, { key: settings.extract_key }).then(function (x) {
			window.CS.showDraft(x.fields || {}, name, dataUrl);
		}).catch(function (e) {
			window.CS.showDraft({ notes: "Automatic field recognition failed: " +
				((e && e.message) || String(e)) + " — fill in the fields by hand." }, name, dataUrl);
		});
	}).catch(function (e) {
		window.onScan({ ok: false, error: "Could not read that picture: " + ((e && e.message) || String(e)) });
	});
}

/* macOS asks for camera permission per app; ask explicitly so the prompt always appears. */
window.CS_CAMERA_BEFORE = function () { return ipcRenderer.invoke("camera-access"); };

/* ------------------------------------------------------------------- the bridge */

window.Android = {
	appVersion: function () { return "1.4-desktop"; },
	toast: function (msg) { console.log("[toast]", msg); },

	/* Webcam: same pipeline as a picture chosen from disk afterwards. */
	takePhoto: function () {
		if (!window.CS_CAMERA || !window.CS_CAMERA.available()) {
			window.onScan({ ok: false, error: "No camera is available — use “Choose an existing picture” instead." });
			return;
		}
		window.CS_CAMERA.open({ title: "Photograph the business card",
			hint: "Hold the card flat, fill the frame, avoid glare." }).then(function (dataUrl) {
			if (!dataUrl) { window.onScanCancelled(); return; }
			processCardPhoto(Buffer.from(dataUrl.split(",")[1], "base64"), "image/jpeg");
		}).catch(function (e) {
			window.onScan({ ok: false, error: (e && e.message) || String(e) });
		});
	},

	/* Opens a native file picker, saves the chosen photo under this app's
	   own data folder (so it can be re-read/deleted later like a native
	   scan's image), and — since there's no on-device OCR here — asks
	   Claude to read the card directly (see cardvision.js) rather than
	   running text OCR + parseCard() as the phone apps do. */
	pickPhoto: function () {
		ipcRenderer.invoke("pick-file", { kind: "image" }).then(function (res) {
			if (!res || res.canceled || !res.filePath) { window.onScanCancelled(); return; }
			try {
				processCardPhoto(fs.readFileSync(res.filePath), imageMime(res.filePath));
			} catch (e) {
				window.onScan({ ok: false, error: "Could not read that picture: " + ((e && e.message) || String(e)) });
			}
		});
	},

	/* app.js's re-OCR flow expects a raw OCR text refresh it can re-parse
	   with parseCard() — not something a structured vision read fits (and
	   nothing in the shared UI currently calls A.reOcr() anyway). Rather
	   than force that mismatch, be honest about it: delete-and-rescan
	   gets the same result through a path that already works properly. */
	reOcr: function () {
		window.onScan({ ok: false,
			error: "Re-reading isn't available on desktop — delete this card and scan the photo again for a fresh read." });
	},

	readData: function (name) {
		try { return fs.readFileSync(path.join(DATA_DIR, name), "utf8"); } catch (e) { return ""; }
	},
	writeData: function (name, content) {
		try { fs.writeFileSync(path.join(DATA_DIR, name), content, "utf8"); return true; } catch (e) { return false; }
	},

	readAsset: function (name) {
		try { return fs.readFileSync(path.join(__dirname, "web", name)).toString("base64"); } catch (e) { return ""; }
	},

	readCardImage: function (imageName) {
		try {
			var buf = fs.readFileSync(path.join(IMAGES_DIR, imageName));
			return "data:" + imageMime(imageName) + ";base64," + buf.toString("base64");
		} catch (e) { return ""; }
	},
	deleteCardImage: function (imageName) {
		try { fs.unlinkSync(path.join(IMAGES_DIR, imageName)); return true; } catch (e) { return false; }
	},

	saveToDocuments: function (fileName, base64) {
		try {
			fs.mkdirSync(DOCS_DIR, { recursive: true });
			var full = path.join(DOCS_DIR, fileName);
			fs.writeFileSync(full, Buffer.from(base64, "base64"));
			return JSON.stringify({ ok: true, path: full, uri: full });
		} catch (e) {
			return JSON.stringify({ ok: false, error: (e && e.message) || String(e) });
		}
	},
	shareFiles: function (urisJson) {
		try {
			var uris = JSON.parse(urisJson || "[]");
			if (uris && uris.length) shell.showItemInFolder(uris[0]);
		} catch (e) { /* nothing sensible to fall back to */ }
	},

	/* A PDF or a picture of an accounts document. Pictures over ~3 MB are shrunk. */
	pickDocument: function () {
		ipcRenderer.invoke("pick-file", { kind: "document" }).then(function (res) {
			if (!res || res.canceled || !res.filePath) { window.onDocPicked({ ok: false, error: "No file chosen." }); return; }
			try {
				var buf = fs.readFileSync(res.filePath);
				var base = path.basename(res.filePath);
				if (/\.pdf$/i.test(base)) {
					window.onDocPicked({ ok: true, name: base,
						dataUrl: "data:application/pdf;base64," + buf.toString("base64") });
					return;
				}
				var url = "data:" + imageMime(base) + ";base64," + buf.toString("base64");
				var prep = buf.length > 3 * 1024 * 1024 && window.CS_CAMERA
					? window.CS_CAMERA.shrink(url, 2400) : Promise.resolve(url);
				prep.then(function (u) {
					window.onDocPicked({ ok: true, name: u === url ? base : base.replace(/\.[A-Za-z0-9]+$/, "") + ".jpg", dataUrl: u });
				}).catch(function (e) {
					window.onDocPicked({ ok: false, error: (e && e.message) || String(e) });
				});
			} catch (e) {
				window.onDocPicked({ ok: false, error: "Could not read that file: " + ((e && e.message) || String(e)) });
			}
		});
	},

	httpPostJson: function (url, headersJson, body, timeout, id) {
		doFetch("POST", url, headersJson, body, timeout, id, true);
	},
	httpRequest: function (method, url, headersJson, body, timeout, id) {
		doFetch(method, url, headersJson, body, timeout, id, false);
	}
};
