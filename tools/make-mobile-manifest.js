#!/usr/bin/env node
/* make-mobile-manifest.js — writes (or updates) mobile.json, the file the phone apps read to learn that a newer version
   exists (see docs/MOBILE-UPDATES.md). It never touches the other platform's entry in an existing file.

     node tools/make-mobile-manifest.js --out mobile.json --android app-release.apk --android-version 1.5
     node tools/make-mobile-manifest.js --out mobile.json --ios-version 1.5 --ios-message "Install build 1.5 from Xcode."

   --android <apk>          the apk to publish; its SHA-256 is computed here and its file name is what the app downloads
   --android-version <v>    the versionName inside that apk (build.gradle), e.g. 1.5
   --ios-version <v>        the iPhone app's version (MARKETING_VERSION)
   --ios-message <text>     what the app tells the user (optional)
   --out <file>             default mobile.json in the current folder */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function parse(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!/^--/.test(a)) throw new Error("unexpected argument: " + a);
		const v = argv[++i];
		if (v === undefined) throw new Error(a + " needs a value");
		o[a.slice(2)] = v;
	}
	return o;
}

function sha256(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/* returns the new manifest object */
function build(o, existing) {
	const m = existing && typeof existing === "object" ? existing : {};
	if (o.android) {
		if (!o["android-version"]) throw new Error("--android needs --android-version");
		if (!/^\d+(\.\d+)*$/.test(o["android-version"])) throw new Error("--android-version must look like 1.5");
		m.android = { version: o["android-version"], url: path.basename(o.android), sha256: sha256(o.android) };
	}
	if (o["ios-version"]) {
		if (!/^\d+(\.\d+)*$/.test(o["ios-version"])) throw new Error("--ios-version must look like 1.5");
		m.ios = { version: o["ios-version"] };
		if (o["ios-message"]) m.ios.message = o["ios-message"];
	}
	if (!m.android && !m.ios) throw new Error("nothing to write: give --android and/or --ios-version");
	return m;
}

if (require.main === module) {
	try {
		const o = parse(process.argv.slice(2));
		const out = o.out || "mobile.json";
		let existing = null;
		try { existing = JSON.parse(fs.readFileSync(out, "utf8")); } catch (e) { existing = null; }
		const m = build(o, existing);
		fs.writeFileSync(out, JSON.stringify(m, null, 2) + "\n");
		console.log("Wrote " + out + ":\n" + JSON.stringify(m, null, 2));
		if (m.android) console.log("\nCopy " + m.android.url + " to the update server first, then " + path.basename(out) + " last.");
	} catch (e) {
		console.error("Error: " + e.message);
		process.exit(1);
	}
}

module.exports = { build, parse, sha256 };
