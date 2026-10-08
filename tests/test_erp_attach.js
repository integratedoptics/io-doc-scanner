/* test_erp_attach.js — erp.js attachFile against a fake ERPNext: it must check what it did (file address,
   stored size, file really served, field written) and report what failed instead of swallowing it. */
"use strict";
var fs = require("fs"), path = require("path"), vm = require("vm");
var file = path.join(__dirname, "../android/CardScanner/app/src/main/assets/erp.js");
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }

var B64 = Buffer.from("%PDF-1.4 hello world, this is a test pdf body of some length 0123456789").toString("base64");
var DATA = "data:application/pdf;base64," + B64, BYTES = Buffer.from(B64, "base64").length;

function world(opts) {
	var log = [], state = { madePrivate: false };
	var w = { window: {}, console: console };
	w.window.CS_NET = { request: function (method, url, headers, body) {
		var rec = { method: method, url: url, headers: headers, body: body ? JSON.parse(body) : null };
		log.push(rec);
		function ok(data, status) { return Promise.resolve({ status: status || 200, body: JSON.stringify({ data: data }) }); }
		if (method === "POST" && /\/api\/resource\/File$/.test(url)) return ok({ name: "abc123" });
		if (method === "GET" && /\/api\/resource\/File\/abc123$/.test(url)) {
			if (opts.public && !state.madePrivate) return ok({ name: "abc123", file_url: "/files/ILTE PO-08385.pdf", file_size: BYTES, is_private: 0 });
			if (opts.noUrl) return ok({ name: "abc123", file_url: "", file_size: 0 });
			return ok({ name: "abc123", file_url: "/private/files/PO 08286 ą.pdf", file_size: opts.size === undefined ? BYTES : opts.size });
		}
		if (method === "GET" && /\/private\/files\//.test(url)) return Promise.resolve({ status: opts.serve || 206, body: "%PDF-1.4 hello" });
		if (method === "PUT" && /\/api\/resource\/File\/abc123$/.test(url)) {
			if (opts.noMove) return Promise.resolve({ status: 417, body: JSON.stringify({ exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: "cannot move" })]) }) });
			state.madePrivate = true; return ok({ name: "abc123" });
		}
		if (method === "PUT") {
			if (opts.putFails) return Promise.resolve({ status: 417, body: JSON.stringify({ exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: "Field is read only" })]) }) });
			return ok({ name: "ACC-1" });
		}
		return Promise.resolve({ status: 404, body: "{}" });
	} };
	vm.createContext(w); vm.runInContext(fs.readFileSync(file, "utf8"), w);
	w.window.CS_ERP.configure({ erp_url: "https://erp.example.com", erp_mode: "token", erp_key: "k", erp_secret: "s" });
	return { E: w.window.CS_ERP.shared, I: w.window.CS_ERP._internals, log: log };
}

(async function () {
	var t = world({}), r = await t.E.attachFile("Accounts Document", "ACC-1", DATA, "PO-08286.pdf", "file");
	check("good case: created, with the file address", r.state === "created" && r.url === "/private/files/PO 08286 ą.pdf", JSON.stringify(r));
	var post = t.log.filter(function (x) { return x.method === "POST"; })[0].body;
	check("the file is sent decoded-by-server, private, attached to the record and the field", post.decode === 1 && post.is_private === 1 &&
		post.attached_to_doctype === "Accounts Document" && post.attached_to_name === "ACC-1" && post.attached_to_field === "file" && post.content === B64);
	var get = t.log.filter(function (x) { return x.method === "GET" && /private/.test(x.url); })[0];
	check("the address is requested from the server (first bytes only, URL-encoded)", !!get && get.headers.Range === "bytes=0-15" &&
		get.url === "https://erp.example.com/private/files/PO%2008286%20%C4%85.pdf", get && get.url);
	var put = t.log.filter(function (x) { return x.method === "PUT"; })[0];
	check("the field is written with the file address", !!put && put.body.file === "/private/files/PO 08286 ą.pdf");

	r = await world({ serve: 404 }).E.attachFile("Accounts Document", "ACC-1", DATA, "a.pdf", "file");
	check("file missing on the server (404) is reported", r.state === "error" && /missing on the server \(404/.test(r.errors[0].message), JSON.stringify(r));
	r = await world({ serve: 403 }).E.attachFile("Accounts Document", "ACC-1", DATA, "a.pdf", "file");
	check("file refused (403) is reported", r.state === "error" && /refuses to serve it \(403/.test(r.errors[0].message), JSON.stringify(r));
	r = await world({ size: 96 }).E.attachFile("Accounts Document", "ACC-1", DATA, "a.pdf", "file");
	check("stored size different from what was sent is reported (e.g. text instead of the file)", r.state === "error" && /stored 96 bytes/.test(r.errors[0].message), JSON.stringify(r));
	r = await world({ noUrl: true }).E.attachFile("Accounts Document", "ACC-1", DATA, "a.pdf", "file");
	check("attachment record without a file address is reported", r.state === "error" && /no file address/.test(r.errors[0].message), JSON.stringify(r));
	r = await world({ putFails: true }).E.attachFile("Accounts Document", "ACC-1", DATA, "a.pdf", "file");
	check("field write refused is reported, not swallowed", r.state === "error" && /could not be written into the .file. field/.test(r.errors[0].message) && /read only/.test(r.errors[0].message), JSON.stringify(r));
	t = world({}); r = await t.E.attachFile("Accounts Document", "ACC-1", DATA, "a.pdf", "");
	check("no field: attached only, no field write", r.state === "created" && !t.log.some(function (x) { return x.method === "PUT"; }));
	r = await t.E.attachFile("Accounts Document", "ACC-1", "", "a.pdf", "file");
	check("nothing to send -> off", r.state === "off");

	/* ERPNext put the file in the PUBLIC folder: the app makes it private, and the field gets the private address */
	t = world({ public: true }); r = await t.E.attachFile("Accounts Document", "ACC-1", DATA, "ILTE PO-08385.pdf", "file");
	var mv = t.log.filter(function (x) { return x.method === "PUT" && /File\/abc123/.test(x.url); })[0];
	var fput = t.log.filter(function (x) { return x.method === "PUT" && /Accounts%20Document/.test(x.url); })[0];
	check("public address -> the File is switched to private", !!mv && mv.body.is_private === 1, JSON.stringify(t.log.map(function (x) { return x.method + " " + x.url; })));
	check("...and the Attach field gets /private/files/…", r.state === "created" && /^\/private\/files\//.test(r.url) && !!fput && /^\/private\/files\//.test(fput.body.file), JSON.stringify([r, fput && fput.body]));
	r = await world({ public: true, noMove: true }).E.attachFile("Accounts Document", "ACC-1", DATA, "a.pdf", "file");
	check("public address that cannot be moved is reported", r.state === "error" && /public folder \(\/files\/ILTE PO-08385\.pdf\) and refused to make it private: cannot move/.test(r.errors[0].message), JSON.stringify(r));
	t = world({ public: true }); r = await t.I.attachImage("Contact", "C-1", DATA, "Jane Doe");
	check("business-card photo is made private too", r.state === "created" && /^\/private\/files\//.test(r.url), JSON.stringify(r));

	console.log(fails ? fails + " FAILED" : "all passed");
	process.exit(fails ? 1 : 0);
})();
