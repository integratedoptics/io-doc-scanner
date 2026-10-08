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

/* ---------------------------------------------------------- reading order
   pdf.js reports text in the order the PDF's author drew it, which for a two-column header
   ("Tiekėjas: | Pirkėjas:" above the two company blocks) is row by row — or worse, with one
   column's text drawn much later. Read flat, the label "Pirkėjas:" then sits right in front of the
   SELLER's name. This finds such side-by-side blocks from the positions and re-emits each as
   column 1 followed by column 2, leaving everything else (tables, paragraphs, forms) exactly in
   the order pdf.js gave it. `items` are pdf.js text items ({ str, transform:[…, x, y], width }). */
var CELL_GAP = 10, LINE_TOL = 2.5, COL_TOL = 6, MIN_COL_SPACING = 60, MAX_ROW_GAP = 45;

function layoutText(items) {
	var all = [];
	(items || []).forEach(function (it, i) {
		var str = it && typeof it.str === "string" ? it.str : "";
		var t = it && it.transform;
		all.push({ i: i, str: str, x: t ? t[4] : 0, y: t ? t[5] : 0, w: (it && it.width) || 0, blank: !str.trim() });
	});
	var real = all.filter(function (a) { return !a.blank; });

	/* lines (same baseline) -> cells (items close together) */
	var sorted = real.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; });
	var lines = [];
	sorted.forEach(function (a) {
		var ln = lines[lines.length - 1];
		if (ln && Math.abs(ln.y - a.y) <= LINE_TOL) ln.items.push(a); else lines.push({ y: a.y, items: [a] });
	});
	lines.forEach(function (ln) {
		ln.items.sort(function (a, b) { return a.x - b.x; });
		ln.cells = [];
		ln.items.forEach(function (a) {
			var c = ln.cells[ln.cells.length - 1];
			if (c && a.x - c.end <= CELL_GAP) {
				c.text += (a.x - c.end > 1 && !/\s$/.test(c.text) ? " " : "") + a.str; c.end = Math.max(c.end, a.x + a.w); c.items.push(a);
			} else {
				ln.cells.push({ x: a.x, end: a.x + a.w, text: a.str, items: [a] });
			}
		});
		ln.cells.forEach(function (c) { c.text = c.text.replace(/\s+/g, " ").trim(); });
	});

	/* side-by-side blocks: consecutive lines of at most two cells whose left edges line up in two columns */
	var blocks = [], cur = null;
	function near(a, b) { return Math.abs(a - b) <= COL_TOL; }
	function close() {
		if (cur && cur.two >= 2) blocks.push(cur);
		cur = null;
	}
	lines.forEach(function (ln) {
		var cs = ln.cells, fits = false;
		if (cur && cs.length <= 2 && cur.lastY - ln.y <= MAX_ROW_GAP) {
			if (cs.length === 2) fits = near(cs[0].x, cur.c1) && near(cs[1].x, cur.c2);
			else if (near(cs[0].x, cur.c1)) fits = cs[0].end < cur.c2 - 4;
			else if (near(cs[0].x, cur.c2)) fits = true;
		}
		if (fits) {
			cur.lines.push(ln); cur.lastY = ln.y; if (cs.length === 2) cur.two++;
			return;
		}
		close();
		if (cs.length === 2 && cs[1].x - cs[0].x >= MIN_COL_SPACING && cs[1].x - cs[0].end >= 15) {
			cur = { c1: cs[0].x, c2: cs[1].x, lines: [ln], lastY: ln.y, two: 1 };
		}
	});
	close();
	/* "Label:  amount" pairs on one line (totals, usually right-aligned) whose label and number the PDF
	   drew far apart: keep each pair together. Lines already inside a side-by-side block are left alone. */
	var inBlock = {};
	blocks.forEach(function (b) { b.lines.forEach(function (ln) { inBlock[ln.y + ":" + ln.items[0].i] = 1; }); });
	lines.forEach(function (ln) {
		var cs = ln.cells;
		if (inBlock[ln.y + ":" + ln.items[0].i] || cs.length !== 2) return;
		if (/[:)]$/.test(cs[0].text) && /^[-+]?\d[\d\s.,]*\s?(?:[A-Za-z€$£]{1,3})?$/.test(cs[1].text)) {
			blocks.push({ lines: [ln], pair: true, text: cs[0].text + " " + cs[1].text });
		}
	});
	if (!blocks.length) return all.map(function (a) { return a.str; }).join(" ");

	var owner = {};
	blocks.forEach(function (b, bi) {
		if (b.pair) { b.lines[0].cells.forEach(function (c) { c.items.forEach(function (a) { owner[a.i] = bi; }); }); return; }
		var col1 = [], col2 = [];
		b.lines.forEach(function (ln) {
			ln.cells.forEach(function (c) {
				(near(c.x, b.c2) && !near(c.x, b.c1) ? col2 : col1).push(c.text);
				c.items.forEach(function (a) { owner[a.i] = bi; });
			});
		});
		b.text = col1.concat(col2).join("  ");
	});
	var done = {}, out = [];
	all.forEach(function (a) {
		if (a.blank || owner[a.i] === undefined) { out.push(a.str); return; }
		var bi = owner[a.i];
		if (!done[bi]) { done[bi] = true; out.push(blocks[bi].text); }
	});
	return out.join(" ");
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
						var line = layoutText(tc.items);
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

return { extractText: extractText, ready: init, layoutText: layoutText };
})();
