/* test_camera.js — the permission hook and the error wording in camera.js.
   (The live video overlay needs a real browser; this covers the logic around it.)
   Needs jsdom: JSDOM_PATH=/path/to/node_modules/jsdom node tests/test_camera.js */
"use strict";
var fs = require("fs"), path = require("path");
var JSDOM;
try { JSDOM = require(process.env.JSDOM_PATH || "jsdom").JSDOM; }
catch (e) { console.log("skipped: jsdom is not installed (set JSDOM_PATH)"); process.exit(0); }
var src = fs.readFileSync(path.join(__dirname, "../android/CardScanner/app/src/main/assets/camera.js"), "utf8");
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "  " + (x || ""))); }

(async function () {
	var w = new JSDOM("<body></body>", { runScripts: "outside-only" }).window;
	w.eval(src);
	check("no mediaDevices -> not available", w.CS_CAMERA.available() === false);
	var err = null; try { await w.CS_CAMERA.open({}); } catch (e) { err = e; }
	check("open() without a camera API fails clearly", !!err && /no camera/i.test(err.message));

	Object.defineProperty(w.navigator, "mediaDevices", { value: { getUserMedia: function () { return Promise.reject(new Error("x")); } }, configurable: true });
	check("with getUserMedia -> available", w.CS_CAMERA.available() === true);

	w.CS_CAMERA_BEFORE = function () { return Promise.resolve(false); };
	err = null; try { await w.CS_CAMERA.open({}); } catch (e) { err = e; }
	check("macOS permission refused -> message names System Settings", !!err && /System Settings/.test(err.message));
	check("no overlay is left behind", w.document.body.children.length === 0);

	var f = w.CS_CAMERA._friendly;
	check("NotAllowedError wording", /refused/.test(f({ name: "NotAllowedError" })) && /Camera/.test(f({ name: "NotAllowedError" })));
	check("NotFoundError wording", /No camera/.test(f({ name: "NotFoundError" })));
	check("NotReadableError wording", /another application/.test(f({ name: "NotReadableError" })));

	/* overlay opens, can be cancelled with Escape, and cleans up */
	w.CS_CAMERA_BEFORE = undefined;
	var p = w.CS_CAMERA.open({ title: "T" });
	await new Promise(function (r) { setTimeout(r, 20); });
	check("overlay is shown", w.document.body.children.length === 1 && /T/.test(w.document.body.textContent));
	w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	var v = await p;
	check("Escape cancels with null and removes the overlay", v === null && w.document.body.children.length === 0);

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
