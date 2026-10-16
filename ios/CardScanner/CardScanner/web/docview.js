/* docview.js — shows the attached document (a PDF, page by page, or a picture) so it can be compared with the fields.

   The PDF is drawn with pdf.js into one canvas per page, as wide as the viewer (zoom 100 % = fit to width); the
   buttons zoom in and out. A picture is shown as it is, with the same zoom. Used by the Documents screen: beside the
   form on the desktop apps, in a fold-out box on the phones (drawn only when it is opened). */
window.CS_DOCVIEW = (function () {
"use strict";

var ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
var st = { dataUrl: "", kind: "pdf", zoom: 2, token: 0, doc: null, pages: 0, shown: false, resizeT: 0, lastW: 0 };

function $(id) { return document.getElementById(id); }

function paintBar() {
	var z = $("dv-zoom");
	if (z) z.textContent = Math.round(ZOOMS[st.zoom] * 100) + " %";
	var info = $("dv-info");
	if (info) info.textContent = st.kind === "pdf" && st.pages ? st.pages + (st.pages === 1 ? " page" : " pages") : (st.dataUrl ? "picture" : "");
	var out = $("dv-out"), inn = $("dv-in");
	if (out) out.disabled = st.zoom <= 0;
	if (inn) inn.disabled = st.zoom >= ZOOMS.length - 1;
}

function message(html) {
	var pg = $("dv-pages");
	if (pg) pg.innerHTML = '<p class="hint" style="margin:14px">' + html + "</p>";
}

/* (re)draws what is loaded at the current zoom; a newer call cancels an older one that is still drawing */
function render() {
	var pg = $("dv-pages");
	if (!pg || !st.dataUrl) return Promise.resolve();
	var token = ++st.token;
	paintBar();
	var width = Math.max(240, (pg.clientWidth || 360) - 4) * ZOOMS[st.zoom];
	st.lastW = pg.clientWidth;
	if (st.kind === "image") {
		pg.innerHTML = "";
		var img = document.createElement("img");
		img.alt = "The attached document";
		img.src = st.dataUrl;
		img.style.width = width + "px";
		img.style.maxWidth = "none";
		pg.appendChild(img);
		return Promise.resolve();
	}
	if (!window.CS_PDF || !window.CS_PDF.openDoc) { message("The PDF viewer is not available in this build."); return Promise.resolve(); }
	var ready = st.doc ? Promise.resolve(st.doc) : window.CS_PDF.openDoc(st.dataUrl).then(function (d) { st.doc = d; st.pages = d.numPages; return d; });
	return ready.then(function (doc) {
		if (token !== st.token) return;
		paintBar();
		pg.innerHTML = "";
		var dpr = Math.min(2, window.devicePixelRatio || 1);
		var chain = Promise.resolve();
		for (var n = 1; n <= doc.numPages; n++) {
			(function (no) {
				chain = chain.then(function () {
					if (token !== st.token) return;
					return doc.getPage(no).then(function (page) {
						if (token !== st.token) return;
						var base = page.getViewport({ scale: 1 });
						var scale = width / base.width;
						var vp = page.getViewport({ scale: scale * dpr });
						var c = document.createElement("canvas");
						c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
						c.style.width = Math.floor(vp.width / dpr) + "px";
						c.style.height = Math.floor(vp.height / dpr) + "px";
						c.className = "dvpage";
						pg.appendChild(c);
						return page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
					});
				});
			})(n);
		}
		return chain;
	}).catch(function (e) {
		if (token === st.token) message("The document could not be shown here: " + esc((e && e.message) || String(e)));
	});
}

function esc(s) { return String(s).replace(/[<>&]/g, function (m) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]; }); }

/* kind: "pdf" | "image" */
function show(dataUrl, kind) {
	st.token++;
	st.dataUrl = dataUrl || "";
	st.kind = kind === "image" ? "image" : "pdf";
	st.doc = null; st.pages = 0;
	st.zoom = 2;
	var pg = $("dv-pages");
	if (pg) pg.innerHTML = "";
	paintBar();
	if (st.dataUrl && st.shown) render();
}

function clear() { show("", "pdf"); }

/* the viewer is on screen (always on the desktop apps, once opened on the phones): draw now if a file waits */
function setVisible(on) {
	st.shown = !!on;
	if (on && st.dataUrl && !($("dv-pages") && $("dv-pages").firstChild)) render();
}

function zoom(delta) {
	var z = Math.max(0, Math.min(ZOOMS.length - 1, st.zoom + delta));
	if (z === st.zoom) return;
	st.zoom = z;
	render();
}

function fit() { st.zoom = 2; render(); }

function init() {
	var a = $("dv-in"), b = $("dv-out"), c = $("dv-fit");
	if (a) a.onclick = function () { zoom(1); };
	if (b) b.onclick = function () { zoom(-1); };
	if (c) c.onclick = fit;
	window.addEventListener("resize", function () {
		clearTimeout(st.resizeT);
		st.resizeT = setTimeout(function () {
			var pg = $("dv-pages");
			if (st.shown && st.dataUrl && pg && Math.abs(pg.clientWidth - st.lastW) > 8) render();
		}, 250);
	});
	paintBar();
}

return { init: init, show: show, clear: clear, setVisible: setVisible, zoom: zoom, fit: fit, render: render,
	state: function () { return { zoom: ZOOMS[st.zoom], pages: st.pages, kind: st.kind, loaded: !!st.dataUrl }; } };
})();
