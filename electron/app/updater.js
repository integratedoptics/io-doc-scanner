/* updater.js — basic auto-update from the internal update server (electron-updater, "generic" provider; the feed
   address is build.publish in package.json). Windows installed (NSIS) builds only: the portable build and the zip
   do not update, and macOS builds are unsigned, which macOS refuses to auto-update.

   - Checks only in a packaged app, first right after app.whenReady(), then every 30 minutes (one setInterval).
   - Downloads in the background. An unreachable server or a failed check is only logged as a warning.
   - When an update is downloaded: "Update <version> has been downloaded" — [Restart now] [Later]. "Restart now"
     installs and restarts; "Later" does nothing, and the update is installed when the app is closed.
   - The dialog is shown once per version: every later check fires the same events again for the version that is
     already downloaded, and "Later" must not come back on every interval.

   start(deps) takes its collaborators as optional arguments so the unit test can hand in mocks. */
"use strict";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

let started = false;

function start(deps) {
	deps = deps || {};
	const electron = deps.app && deps.dialog ? null : require("electron");
	const app = deps.app || electron.app;
	const dialog = deps.dialog || electron.dialog;
	const log = deps.logger || require("./logger");
	const platform = deps.platform || process.platform;
	const intervalMs = deps.intervalMs || CHECK_INTERVAL_MS;
	const setTimer = deps.setInterval || setInterval;

	if (!app.isPackaged) { log.info("updates: not checking (the app is not packaged)"); return null; }
	if (platform !== "win32") { log.info("updates: not checking (automatic updates are for the Windows installer only)"); return null; }
	if (started) return null;

	const autoUpdater = deps.autoUpdater || require("electron-updater").autoUpdater;
	started = true;

	// electron-updater logs through the project's logger; an unreachable server is normal here, so its own
	// error-level lines are written as warnings
	autoUpdater.logger = {
		info: function () { log.info.apply(log, arguments); },
		warn: function () { log.warn.apply(log, arguments); },
		error: function () { log.warn.apply(log, arguments); },
		debug: function () { if (log.debug) log.debug.apply(log, arguments); }
	};
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;   // "Later": installed when the app closes

	let shownVersion = null;   // the version the dialog was already shown for

	autoUpdater.on("error", function (err) {
		log.warn("updates: " + ((err && err.message) || err));
	});

	autoUpdater.on("update-downloaded", function (info) {
		const version = info && info.version;
		if (version && version === shownVersion) return;
		shownVersion = version || "";
		Promise.resolve(dialog.showMessageBox({
			type: "info",
			title: "IO Doc Scanner",
			message: "Update " + version + " has been downloaded",
			detail: "Restart now to install it, or choose Later — it will be installed when you close the app.",
			buttons: ["Restart now", "Later"],
			defaultId: 0,
			cancelId: 1,
			noLink: true
		})).then(function (r) {
			if (r && r.response === 0) autoUpdater.quitAndInstall(false, true);
		}).catch(function (err) {
			log.warn("updates: the update dialog failed: " + ((err && err.message) || err));
		});
	});

	function check() {
		try {
			Promise.resolve(autoUpdater.checkForUpdates()).catch(function (err) {
				log.warn("updates: check failed: " + ((err && err.message) || err));
			});
		} catch (err) {
			log.warn("updates: check failed: " + ((err && err.message) || err));
		}
	}

	return Promise.resolve(app.whenReady()).then(function () {
		check();
		const timer = setTimer(check, intervalMs);
		if (timer && timer.unref) timer.unref();
		return { check: check, timer: timer };
	});
}

module.exports = { start: start, CHECK_INTERVAL_MS: CHECK_INTERVAL_MS, _reset: function () { started = false; } };
