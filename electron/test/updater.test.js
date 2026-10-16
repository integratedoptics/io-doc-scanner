/* updater.test.js — app/updater.js with electron-updater, electron's app/dialog and the logger mocked.
       npm test        (node --test) */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const updater = require("../app/updater");

function make(opts) {
	opts = opts || {};
	let ready;
	const readyPromise = new Promise((r) => { ready = r; });
	const au = new EventEmitter();
	au.checks = 0; au.installs = [];
	au.checkForUpdates = function () {
		au.checks++;
		if (opts.checkThrows) throw new Error("boom (sync)");
		return opts.checkRejects ? Promise.reject(new Error("getaddrinfo ENOTFOUND 192.168.1.79")) : Promise.resolve(null);
	};
	au.quitAndInstall = function (silent, run) { au.installs.push([silent, run]); };
	const logs = { info: [], warn: [], error: [], debug: [] };
	const logger = {};
	Object.keys(logs).forEach((k) => { logger[k] = (m) => logs[k].push(String(m)); });
	const dialogs = [];
	const dialog = { showMessageBox: (o) => { dialogs.push(o); return Promise.resolve({ response: opts.answer === undefined ? 1 : opts.answer }); } };
	const timers = [];
	const deps = {
		app: { isPackaged: opts.packaged !== false, whenReady: () => readyPromise },
		dialog, logger, autoUpdater: au, platform: opts.platform || "win32",
		setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }
	};
	return { deps, au, logs, dialogs, timers, ready };
}
const tick = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => updater._reset());

test("an unpackaged app does not check for updates", async () => {
	const m = make({ packaged: false });
	assert.equal(updater.start(m.deps), null);
	m.ready(); await tick();
	assert.equal(m.au.checks, 0);
	assert.equal(m.timers.length, 0);
	assert.equal(m.au.listenerCount("update-downloaded"), 0);
});

test("outside Windows nothing is checked (the installer is Windows only)", async () => {
	const m = make({ platform: "darwin" });
	assert.equal(updater.start(m.deps), null);
	m.ready(); await tick();
	assert.equal(m.au.checks, 0);
});

test("packaged: first check after app is ready, then every 30 minutes from one interval", async () => {
	const m = make();
	const p = updater.start(m.deps);
	await tick();
	assert.equal(m.au.checks, 0, "no check before app.whenReady() resolves");
	m.ready(); await p;
	assert.equal(m.au.checks, 1);
	assert.equal(m.timers.length, 1);
	assert.equal(m.timers[0].ms, 30 * 60 * 1000);
	m.timers[0].fn(); m.timers[0].fn();
	assert.equal(m.au.checks, 3);
	assert.equal(m.au.autoDownload, true);
	assert.equal(m.au.autoInstallOnAppQuit, true);
	m.au.logger.info("hello"); m.au.logger.error("library error");
	assert.ok(m.logs.info.includes("hello"), "the library logs through the project's logger");
	assert.ok(m.logs.warn.includes("library error") && m.logs.error.length === 0, "its error lines are warnings");
	await updater.start(m.deps);   // a second start does not add a second interval
	assert.equal(m.timers.length, 1);
});

test("an error event is only logged as a warning", async () => {
	const m = make();
	m.ready(); await updater.start(m.deps);
	assert.doesNotThrow(() => m.au.emit("error", new Error("net::ERR_CONNECTION_REFUSED")));
	assert.equal(m.logs.warn.length, 1);
	assert.match(m.logs.warn[0], /ERR_CONNECTION_REFUSED/);
	assert.equal(m.dialogs.length, 0);
});

test("a rejected or throwing checkForUpdates() is only logged; the periodic check keeps running", async () => {
	for (const o of [{ checkRejects: true }, { checkThrows: true }]) {
		updater._reset();
		const m = make(o);
		m.ready(); await updater.start(m.deps); await tick();
		assert.equal(m.logs.warn.length, 1);
		m.timers[0].fn(); await tick();
		assert.equal(m.au.checks, 2);
		assert.equal(m.logs.warn.length, 2);
		assert.equal(m.dialogs.length, 0);
		assert.equal(m.logs.error.length, 0);
	}
});

test("the downloaded-update dialog is shown once per version; Later does nothing", async () => {
	const m = make({ answer: 1 });
	m.ready(); await updater.start(m.deps);
	m.au.emit("update-downloaded", { version: "1.5.0" });
	await tick();
	assert.equal(m.dialogs.length, 1);
	assert.equal(m.dialogs[0].message, "Update 1.5.0 has been downloaded");
	assert.deepEqual(m.dialogs[0].buttons, ["Restart now", "Later"]);
	// every periodic check fires the event again for the same version
	m.au.emit("update-downloaded", { version: "1.5.0" });
	m.au.emit("update-downloaded", { version: "1.5.0" });
	await tick();
	assert.equal(m.dialogs.length, 1);
	assert.equal(m.au.installs.length, 0);
	// a newer version asks again
	m.au.emit("update-downloaded", { version: "1.6.0" });
	await tick();
	assert.equal(m.dialogs.length, 2);
	assert.equal(m.dialogs[1].message, "Update 1.6.0 has been downloaded");
});

test("Restart now installs with quitAndInstall(false, true)", async () => {
	const m = make({ answer: 0 });
	m.ready(); await updater.start(m.deps);
	m.au.emit("update-downloaded", { version: "1.5.0" });
	await tick();
	assert.deepEqual(m.au.installs, [[false, true]]);
});

test("a failing dialog does not crash the app", async () => {
	const m = make();
	m.deps.dialog.showMessageBox = () => Promise.reject(new Error("no window"));
	m.ready(); await updater.start(m.deps);
	m.au.emit("update-downloaded", { version: "1.5.0" });
	await tick();
	assert.equal(m.logs.warn.length, 1);
	assert.equal(m.au.installs.length, 0);
});
