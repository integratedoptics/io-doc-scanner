/* main.js — Electron main process for the desktop Card/Document Scanner.
   Loads the same shared web/ UI used by Android and iOS (see
   sync-web-assets.sh) inside one BrowserWindow, with preload.js providing a
   window.Android bridge object that mirrors the native Android/iOS
   JavaScript interfaces exactly — the shared HTML/CSS/JS needed zero
   changes to run here beyond the two small, backward-compatible additions
   noted in preload.js's header comment.

   Security note: this window runs with nodeIntegration enabled and context
   isolation OFF. That's normally unsafe for a browser shell, but this app
   never loads remote or user-supplied web content — only its own bundled
   web/index.html, loaded from disk, with navigation and new-window
   creation both blocked below. Treat adding any remote URL loading to this
   window as a security-relevant change that needs re-review of this
   trade-off. */
"use strict";

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const { URL } = require("url");
const httpClient = require("./http");

const WEB_DIR = path.join(__dirname, "web");
const WEB_ENTRY = path.join(WEB_DIR, "index.html");

function createWindow() {
	const win = new BrowserWindow({
		width: 480,
		height: 860,
		minWidth: 380,
		minHeight: 560,
		title: "IO Doc Scanner",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: false,
			nodeIntegration: true,
			sandbox: false,
			webSecurity: true
		}
	});

	win.setMenuBarVisibility(false);
	win.loadFile(WEB_ENTRY);

	// Never let this window navigate anywhere but its own bundled page, and
	// never let it spawn a second, less-locked-down window.
	win.webContents.on("will-navigate", (event, targetUrl) => {
		if (targetUrl !== win.webContents.getURL()) {
			try {
				const target = new URL(targetUrl);
				if (target.protocol === "file:" && path.resolve(target.pathname) === path.resolve(WEB_ENTRY)) return;
			} catch (e) { /* fall through to blocking it */ }
			event.preventDefault();
		}
	});
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

	return win;
}

app.whenReady().then(() => {
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

/* ------------------------------------------------------------- native file picking */

ipcMain.handle("pick-file", async (event, opts) => {
	const kind = (opts && opts.kind) || "image";
	const filters = kind === "pdf"
		? [{ name: "PDF documents", extensions: ["pdf"] }]
		: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }];
	const win = BrowserWindow.fromWebContents(event.sender);
	const res = await dialog.showOpenDialog(win, { properties: ["openFile"], filters });
	if (res.canceled || !res.filePaths.length) return { canceled: true };
	return { canceled: false, filePath: res.filePaths[0] };
});

/* ------------------------------------------------------------------ HTTP bridge
   Runs in the main process (a plain Node context) rather than the renderer,
   specifically so requests to ERPNext and to the Anthropic API are not
   subject to the browser's same-origin/CORS restrictions that would apply
   to a fetch() made from the file:// page itself — exactly the problem the
   real native HTTP bridges on Android/iOS sidestep by using a native HTTP
   client instead of the WebView's own networking. */
ipcMain.handle("http-fetch", async (event, req) => {
	const r = await httpClient.request({
		method: (req && req.method) || "GET",
		url: req.url,
		headers: (req && req.headers) || {},
		body: req && req.body,
		timeoutMs: ((req && req.timeout) || 30) * 1000
	});
	if (r.hops && r.hops.length) console.log("[http] redirects:", r.hops.join(" | "));
	// one line per request, never the credentials themselves
	const hasAuth = Object.keys((req && req.headers) || {}).some((k) => /^authorization$/i.test(k));
	console.log("[http]", (req && req.method) || "GET", req.url, "auth:" + (hasAuth ? "yes" : "no"),
		"->", r.ok ? r.status : "ERR " + r.error,
		r.ok && r.status >= 400 ? String(r.body).slice(0, 200).replace(/\s+/g, " ") : "");
	return r;
});
