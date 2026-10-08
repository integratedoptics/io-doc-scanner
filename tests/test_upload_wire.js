/* test_upload_wire.js — the whole path of a file upload as bytes: erp.js builds the multipart body, the desktop
   HTTP layer (electron/app/http.js) turns the base64 text back into raw bytes, and a local server receives
   exactly the file that was sent — including bytes that are not valid UTF-8. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm"), http = require("http");
var httpClient = require("../electron/app/http.js");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/erp.js");
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }

var payload = Buffer.alloc(70000);
for (var i = 0; i < payload.length; i++) payload[i] = i % 256;           /* every byte value, many times */
Buffer.from("%PDF-1.4\r\n--not-a-boundary\r\n").copy(payload, 0);
var DATA = "data:application/pdf;base64," + payload.toString("base64");

var got = {};
var server = http.createServer(function (req, res) {
	var chunks = [];
	req.on("data", function (c) { chunks.push(c); });
	req.on("end", function () {
		var body = Buffer.concat(chunks);
		got.headers = req.headers; got.body = body;
		res.setHeader("Content-Type", "application/json");
		if (req.url.indexOf("/api/method/uploadfile") === 0) { res.statusCode = 404; res.end("{}"); }
		else if (/multipart/.test(req.headers["content-type"] || "")) {
			res.end(JSON.stringify({ message: { name: "f1", file_url: "/private/files/up.pdf" } }));
		} else if (req.url.indexOf("/api/method/upload_file") === 0) {
			got.form = body.toString(); res.end(JSON.stringify({ message: { name: "f2", file_url: "/private/files/up.pdf" } }));
		} else if (req.method === "GET" && req.url.indexOf("/api/resource/File/f1") === 0) {
			res.end(JSON.stringify({ data: { name: "f1", file_url: "/private/files/up.pdf", file_size: payload.length } }));
		} else if (req.url.indexOf("/private/files/") === 0) { res.statusCode = 206; res.end("%PDF"); }
		else res.end(JSON.stringify({ data: { name: "ACC-1" } }));
	});
}).listen(0, "127.0.0.1", async function () {
	var base = "http://127.0.0.1:" + server.address().port;
	var w = { window: {}, console: console, atob: function (x) { return Buffer.from(x, "base64").toString("binary"); },
		btoa: function (x) { return Buffer.from(x, "binary").toString("base64"); } };
	var seen = [];
	w.window.CS_NET = { request: function (method, url, headers, body) {
		/* what the native bridge receives is text; http.js gets the same arguments the Electron preload passes */
		return httpClient.request({ method: method, url: url, headers: headers, body: body, timeoutMs: 10000 }).then(function (r) {
			if (!r.ok) throw new Error(r.error);
			seen.push(method + " " + url);
			return { status: r.status, body: r.body };
		});
	} };
	vm.createContext(w); vm.runInContext(fs.readFileSync(file, "utf8"), w);
	w.window.CS_ERP.configure({ erp_url: base, erp_mode: "token", erp_key: "k", erp_secret: "s" });
	var multipartSeen = null;
	var r = await w.window.CS_ERP.shared.attachFile("Accounts Document", "ACC-1", DATA, "ILTE PO-08385 ą.pdf", "file");
	check("upload through the desktop HTTP layer succeeds", r.state === "created" && r.url === "/private/files/up.pdf", JSON.stringify(r));
	/* re-run step 1 alone to inspect the wire body */
	got = {};
	await w.window.CS_ERP.shared.attachFile("Accounts Document", "ACC-1", DATA, "x.pdf", "").catch(function () {});
	check("the transfer marker header never reaches the server", !got.headers || !("x-cs-body-encoding" in got.headers));
	/* capture the multipart request itself */
	var cap = null;
	var orig = httpClient.request;
	httpClient.request = function (o) { if (/multipart/.test(o.headers["Content-Type"] || "")) cap = o; return orig(o); };
	await w.window.CS_ERP.shared.attachFile("Accounts Document", "ACC-1", DATA, "ILTE PO-08385 ą.pdf", "file");
	httpClient.request = orig;
	/* run once more with a spy server-side body */
	var spy = http.createServer(function (req, res) {
		var c = []; req.on("data", function (d) { c.push(d); }); req.on("end", function () { multipartSeen = { h: req.headers, b: Buffer.concat(c) };
			res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ message: { name: "f1", file_url: "/private/files/up.pdf" } })); });
	}).listen(0, "127.0.0.1");
	await new Promise(function (ok) { spy.on("listening", ok); });
	var res = await httpClient.request({ method: "POST", url: "http://127.0.0.1:" + spy.address().port + "/api/method/upload_file",
		headers: { "Content-Type": cap.headers["Content-Type"], "X-CS-Body-Encoding": "base64" }, body: cap.body, timeoutMs: 10000 });
	check("server received a multipart request", res.ok && !!multipartSeen && /^multipart\/form-data; boundary=/.test(multipartSeen.h["content-type"]));
	check("marker header removed before the wire", !("x-cs-body-encoding" in multipartSeen.h));
	var b = multipartSeen.b, bin = b.toString("binary");
	var start = bin.indexOf("\r\n\r\n", bin.indexOf('name="file"')) + 4;
	var boundary = /boundary=(.*)$/.exec(multipartSeen.h["content-type"])[1];
	var end = bin.lastIndexOf("\r\n--" + boundary + "--");
	var fileBytes = b.slice(start, end);
	check("the file arrives byte for byte (70000 bytes, all values, no UTF-8 damage)", fileBytes.equals(payload), fileBytes.length + " vs " + payload.length);
	check("content-length is the raw size, not the base64 text", Number(multipartSeen.h["content-length"]) === b.length && b.length < payload.length * 1.1);
	check("UTF-8 file name survives", /filename="ILTE PO-08385 ą\.pdf"/.test(b.toString("utf8").slice(0, 400)));
	spy.close(); server.close();
	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
});
