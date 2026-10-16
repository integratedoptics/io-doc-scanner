/* logger.js — the main process's logger: console plus a log file next to the app's data, so a packaged app (which
   has no visible console) still leaves a trace. info / warn / error / debug, as electron-updater expects. */
"use strict";

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 1024 * 1024;   // the file is started afresh when it grows past 1 MB
let file = null;

function logFile() {
	if (file !== null) return file;
	file = "";
	try {
		const { app } = require("electron");
		if (app && app.getPath) {
			const dir = path.join(app.getPath("userData"), "logs");
			fs.mkdirSync(dir, { recursive: true });
			file = path.join(dir, "main.log");
			try { if (fs.statSync(file).size > MAX_BYTES) fs.writeFileSync(file, ""); } catch (e) { /* no file yet */ }
		}
	} catch (e) { file = ""; }
	return file;
}

function text(a) { return a instanceof Error ? (a.stack || a.message) : (typeof a === "string" ? a : JSON.stringify(a)); }

function write(level, args) {
	const line = new Date().toISOString() + " [" + level + "] " + Array.prototype.map.call(args, text).join(" ");
	(level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
	const f = logFile();
	if (f) { try { fs.appendFileSync(f, line + "\n"); } catch (e) { /* logging must never break the app */ } }
}

module.exports = {
	info: function () { write("info", arguments); },
	warn: function () { write("warn", arguments); },
	error: function () { write("error", arguments); },
	debug: function () { write("debug", arguments); }
};
