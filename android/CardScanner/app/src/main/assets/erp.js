/* erp.js — direct synchronisation with ERPNext over its REST API.

   Endpoints, exactly as documented for the instance:
     POST /api/method/login              usr + pwd, form encoded, keeps a cookie
     GET  /api/resource/<DocType>        duplicate lookups and vocabulary
     GET  /api/resource/<DocType>/<name> reading a document back to verify it
     POST /api/resource/<DocType>        creating Customer / Lead / Supplier /
                                         Prospect, Contact, Address and File

   Two ways to authenticate, both offered in Settings:
     token   Authorization: token <api_key>:<api_secret>   — nothing else needed
     login   /api/method/login once, then the session cookie carries the calls

   Order matters. The organisation is written first, because the Contact and the
   Address hang off it through the Dynamic Link child table, and ERPNext will
   not accept a link to a record that does not exist yet.

   Duplicates are skipped, never overwritten: an existing record is reported by
   name and left exactly as it is, and the remaining toggles still go through.

   Four things guard against the kind of failure that used to come back as an
   unreadable Frappe traceback:

     1. readError() digs the real exception out of the response. Frappe puts a
        JSON-encoded traceback in `exc` and the class name in `exc_type`; the
        useful line is the LAST line of that traceback, not the first, which is
        why a truncated response looked like it carried no message at all.
     2. clean() checks the payload against the doctype's own field list before
        sending: unknown fields are dropped, Select values are checked against
        their options, and Link values are looked up — a missing Salutation or
        Gender is created when Settings allows it, otherwise the value is
        dropped and reported.
     3. createDoc() retries without the offending field if ERPNext still names
        one, so a single bad value cannot cost the whole card.
     4. every created document is read back with GET /api/resource/<Doctype>/
        <name>, so a green tick means the record is really there.

   Errors come back as a list of { field, message } so the app can mark the
   offending box instead of showing a wall of Frappe traceback. */
window.CS_ERP = (function () {
"use strict";

var N = window.CS_NORM;

/* All HTTP goes through net.js, which owns window.onHttp and hands back
   { status, body }. */
function request(method, url, headers, body, timeout) {
	return window.CS_NET.request(method, url, headers, body, timeout);
}

/* ------------------------------------------------------------------- config */

var cfg = {
	url: "", mode: "token", key: "", secret: "", usr: "", pwd: "",
	attach: true,      /* upload the card photo to the contact */
	masters: true,     /* create a missing Salutation / Gender / Designation */
	/* This instance's Supplier Type is a Link to its own configurable list,
	   not the stock Company/Individual pair — there is no safe value to
	   guess from a business card, so it has to come from Settings. */
	supplierType: ""
};
var loggedIn = false;

function configure(s) {
	var base = String(s.erp_url || "").trim().replace(/\/+$/, "");
	if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
	var changed = base !== cfg.url || s.erp_mode !== cfg.mode ||
		s.erp_key !== cfg.key || s.erp_usr !== cfg.usr;
	cfg.url = base;
	cfg.mode = s.erp_mode === "login" ? "login" : "token";
	cfg.key = String(s.erp_key || "").trim();
	cfg.secret = String(s.erp_secret || "").trim();
	cfg.usr = String(s.erp_usr || "").trim();
	cfg.pwd = String(s.erp_pwd || "");
	cfg.attach = s.erp_attach !== false;
	cfg.masters = s.erp_masters !== false;
	cfg.supplierType = String(s.erp_supplier_type || "").trim();
	if (changed) { loggedIn = false; meta = {}; known = {}; }
}

function ready() {
	if (!cfg.url) return "Set the ERPNext address in Settings first.";
	if (cfg.mode === "token" && (!cfg.key || !cfg.secret))
		return "Enter the API key and secret in Settings.";
	if (cfg.mode === "login" && (!cfg.usr || !cfg.pwd))
		return "Enter the ERPNext email and password in Settings.";
	if (!/^https:/i.test(cfg.url) && !/^http:\/\/(localhost|127\.|192\.168\.|10\.)/i.test(cfg.url))
		return "Use an https address — a plain http one would send your credentials in the clear.";
	return "";
}

function authHeaders(json) {
	var h = { "Accept": "application/json" };
	h["Content-Type"] = json ? "application/json" : "application/x-www-form-urlencoded";
	if (cfg.mode === "token") h["Authorization"] = "token " + cfg.key + ":" + cfg.secret;
	return h;
}

function form(obj) {
	var out = [];
	for (var k in obj) {
		if (obj[k] === undefined || obj[k] === null) continue;
		out.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]));
	}
	return out.join("&");
}

/* --------------------------------------------------------------- error text */

function stripTags(s) {
	return String(s == null ? "" : s)
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

/* The last line of a Python traceback is the exception itself. Frappe ships the
   traceback as `exc`: a JSON-encoded list of strings. Reading the FIRST line
   only ever yields "Traceback (most recent call last):", which is exactly what
   made these failures look like they carried no message. */
function tracebackTail(exc) {
	var list = exc;
	if (typeof list === "string") {
		try { list = JSON.parse(list); } catch (e) { list = [exc]; }
	}
	if (!list) return [];
	if (!(list instanceof Array)) list = [list];
	var out = [];
	list.forEach(function (tb) {
		var lines = String(tb).split(/\r?\n/).filter(function (l) { return l.trim(); });
		if (!lines.length) return;
		/* walk back past any bare "^^^^" pointer lines Python 3.11+ adds */
		for (var i = lines.length - 1; i >= 0; i--) {
			var line = lines[i].trim();
			if (/^[\^~\s]+$/.test(line)) continue;
			out.push(line);
			break;
		}
	});
	return out;
}

/* "frappe.exceptions.LinkValidationError: Could not find Salutation: Dr"
   -> { type: "LinkValidationError", message: "Could not find Salutation: Dr" } */
function splitException(line) {
	/* "frappe.exceptions.LinkValidationError: ..." — the module path is optional,
	   and when it is there it always ends in a dot */
	var m = String(line).match(/^(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*(?:Error|Exception))\s*:\s*([\s\S]*)$/);
	if (m) return { type: m[1], message: stripTags(m[2]) || m[1] };
	var m2 = String(line).match(/^([A-Za-z_]\w*(?:Error|Exception))\s*:?\s*([\s\S]*)$/);
	if (m2) return { type: m2[1], message: stripTags(m2[2]) || m2[1] };
	return { type: "", message: stripTags(line) };
}

/* Plain English for the exception classes that actually come up. */
var EXPLAIN = {
	LinkValidationError: "ERPNext does not have that value in its own list yet.",
	MandatoryError: "ERPNext needs this field filled in.",
	DuplicateEntryError: "ERPNext already holds a record with this name.",
	ValidationError: "",
	PermissionError: "This ERPNext account is not allowed to create that record.",
	CharacterLengthExceededError: "The value is longer than ERPNext allows.",
	InvalidNameError: "ERPNext could not build a name for the record.",
	UniqueValidationError: "That value has to be unique and is already in use.",
	TimestampMismatchError: "Someone else changed the record at the same time."
};

/* Everything worth reading out of an error response, in the order Frappe means
   it to be read: the messages meant for a person first, then the exception. */
function readError(bodyText) {
	var out = { type: "", msgs: [] };
	var j = null;
	try { j = JSON.parse(bodyText); } catch (e) { j = null; }

	if (j) {
		if (j.exc_type) out.type = String(j.exc_type);

		if (j._server_messages) {
			var arr = null;
			try { arr = JSON.parse(j._server_messages); } catch (e2) { arr = null; }
			(arr || []).forEach(function (s) {
				var m = s;
				try { m = JSON.parse(s); } catch (e3) { /* already a plain string */ }
				var txt = (m && m.message) ? m.message : m;
				txt = stripTags(txt);
				if (txt) out.msgs.push(txt);
			});
		}

		/* the exception itself: `exc` carries the traceback, and its tail is the
		   line that says what actually went wrong */
		if (j.exc) {
			tracebackTail(j.exc).forEach(function (line) {
				var p = splitException(line);
				if (!out.type && p.type) out.type = p.type;
				if (p.message && out.msgs.indexOf(p.message) < 0) out.msgs.push(p.message);
			});
		}
		if (!out.msgs.length && j.exception) {
			var pe = splitException(j.exception);
			if (!out.type && pe.type) out.type = pe.type;
			if (pe.message) out.msgs.push(pe.message);
		}
		if (!out.msgs.length && typeof j.message === "string" && j.message) {
			out.msgs.push(stripTags(j.message));
		}
		if (!out.msgs.length && j.message && j.message.message) {
			out.msgs.push(stripTags(j.message.message));
		}
	}

	/* not JSON at all: a proxy or a maintenance page. Keep the readable text. */
	if (!out.msgs.length && bodyText) {
		var plain = stripTags(bodyText);
		if (plain) out.msgs.push(plain.slice(0, 300));
	}

	/* a bare exception class with no detail is worth a sentence of its own */
	if (out.type && EXPLAIN[out.type] && !out.msgs.length) out.msgs.push(EXPLAIN[out.type]);
	return out;
}

/* ERPNext label -> the id of the box in this app, so a rejection can be shown
   on the field that caused it. */
var LABEL_TO_FIELD = {
	"first name": "first_name", "last name": "last_name",
	"email address": "email", "email id": "email", "email": "email",
	"mobile no": "mobile_no", "mobile number": "mobile_no",
	"phone": "phone", "phone no": "phone", "fax": "fax",
	"designation": "designation", "department": "department",
	"salutation": "salutation", "gender": "salutation",
	"company name": "company_name", "customer name": "company_name",
	"supplier name": "company_name", "organization name": "company_name",
	"lead name": "first_name", "person name": "first_name",
	"address line 1": "address_line1", "address line1": "address_line1",
	"address line 2": "address_line2", "city/town": "city", "city": "city",
	"county": "state", "state": "state", "state/province": "state",
	"postal code": "pincode", "pincode": "pincode", "zip": "pincode",
	"country": "country", "territory": "country",
	"address type": "address_line1", "address title": "company_name",
	"linkedin": "linkedin", "website": "website", "supplier type": "company_name"
};

/* A Link rejection names the target doctype, not the field. */
var LINK_DOCTYPE_TO_FIELD = {
	"Salutation": "salutation", "Gender": "salutation",
	"Designation": "designation", "Department": "department",
	"Country": "country", "Territory": "country",
	"Customer Group": "company_name", "Supplier Group": "company_name",
	"Industry Type": "company_name", "Language": "",
	"Customer": "company_name", "Supplier": "company_name",
	"Lead": "company_name", "Prospect": "company_name",
	"Supplier Type": "company_name"
};

function fieldFromMessage(msg) {
	var raw = String(msg);
	var m = raw.toLowerCase();

	/* "Could not find Salutation: Dr" / "Could not find Row #1: Country: Narnia" */
	var link = raw.match(/could not find\s+(?:row\s*#\d+:\s*)?([A-Za-z ]+?)\s*:/i);
	if (link) {
		var dt = link[1].trim();
		var f = LINK_DOCTYPE_TO_FIELD[dt];
		if (f === undefined) f = LABEL_TO_FIELD[dt.toLowerCase()];
		if (f) return f;
	}
	/* "Value missing for Contact: First Name", "First Name is required" */
	var hit = m.match(/(?:value missing for [^:]*:\s*|missing\s+)([a-z0-9 /]+)/);
	if (hit) {
		var f2 = LABEL_TO_FIELD[hit[1].trim()];
		if (f2) return f2;
	}
	var best = "";
	for (var label in LABEL_TO_FIELD) {
		if (m.indexOf(label) >= 0 && label.length > best.length) best = label;
	}
	return best ? LABEL_TO_FIELD[best] : "";
}

/* The fieldname ERPNext is complaining about, when it can be worked out, so
   createDoc() can drop it and try again. */
function culpritField(msg, doc) {
	var raw = String(msg);
	var link = raw.match(/could not find\s+(?:row\s*#\d+:\s*)?([A-Za-z ]+?)\s*:/i);
	if (link) {
		var dt = link[1].trim();
		var guess = dt.toLowerCase().replace(/ /g, "_");
		if (doc.hasOwnProperty(guess)) return guess;
		var byLink = { "Salutation": "salutation", "Gender": "gender",
			"Designation": "designation", "Department": "department",
			"Country": "country", "Territory": "territory",
			"Customer Group": "customer_group", "Supplier Group": "supplier_group" };
		if (byLink[dt] && doc.hasOwnProperty(byLink[dt])) return byLink[dt];
	}
	/* "Invalid value for Status" / "<b>Status</b> cannot be ..." */
	var named = raw.match(/(?:invalid (?:value|option)[^a-z]*(?:for)?\s*)([A-Za-z ]+)/i);
	if (named) {
		var k = named[1].trim().toLowerCase().replace(/ /g, "_");
		if (doc.hasOwnProperty(k)) return k;
	}
	return "";
}

function toErrors(status, bodyText, what) {
	var e = readError(bodyText);
	/* A 403 PermissionError means the key/secret WERE accepted — the user they
	   belong to just has no rights on this doctype. Telling someone to "check
	   the credentials" there sends them hunting for a typo that isn't there. */
	if (status === 403 && e.type === "PermissionError") {
		var which = e.msgs.length && e.msgs[0] !== what ? " (" + e.msgs[0] + ")" : "";
		return [{ field: "", message: "ERPNext accepted the login, but this user is not allowed to " +
			"access " + what + which + ". Give the API user a role that has permission on it " +
			"(ERPNext: User \u2192 Roles; Role Permissions Manager shows which roles can)." }];
	}
	if (status === 401 || status === 403) {
		var why = e.msgs.length ? " " + e.msgs[0] : "";
		return [{ field: "", message: "ERPNext refused the credentials (" + status +
			")." + why + " Check the API key or the password in Settings." }];
	}
	if (status === 404 && !e.msgs.length) {
		return [{ field: "", message: "ERPNext has no " + what +
			" endpoint at that address — check the ERPNext URL." }];
	}
	if (status === 502 || status === 503 || status === 504) {
		return [{ field: "", message: "ERPNext did not answer (" + status +
			"). It may be restarting — try again in a moment." }];
	}
	if (!e.msgs.length) {
		return [{ field: "", message: "ERPNext returned " + status +
			" with no explanation." }];
	}
	var tail = e.type && EXPLAIN[e.type] ? " " + EXPLAIN[e.type] : "";
	return e.msgs.map(function (m, i) {
		return {
			field: fieldFromMessage(m),
			message: m + (i === 0 ? tail : ""),
			type: e.type
		};
	});
}

/* ------------------------------------------------------------------- calls */

function login() {
	if (cfg.mode === "token") { loggedIn = true; return Promise.resolve(); }
	if (loggedIn) return Promise.resolve();
	return request("POST", cfg.url + "/api/method/login", authHeaders(false),
			form({ usr: cfg.usr, pwd: cfg.pwd }), 30)
		.then(function (r) {
			if (r.status >= 200 && r.status < 300) { loggedIn = true; return; }
			var errs = toErrors(r.status, r.body, "login");
			var e = new Error(errs[0].message);
			e.errors = errs;
			throw e;
		});
}

function apiUrl(doctype, name, query) {
	return cfg.url + "/api/resource/" + encodeURIComponent(doctype) +
		(name ? "/" + encodeURIComponent(name) : "") + (query || "");
}

/* A whitelisted Frappe method call (as opposed to a /api/resource/<doctype>
   REST call) — used for things with no doctype endpoint of their own, such
   as frappe.model.rename_doc for merging two documents. */
function methodUrl(name) {
	return cfg.url + "/api/method/" + name;
}

function getList(doctype, filters, fields, limit, orderBy) {
	var q = "?limit_page_length=" + (limit || 0);
	if (orderBy) q += "&order_by=" + encodeURIComponent(orderBy);
	if (fields) q += "&fields=" + encodeURIComponent(JSON.stringify(fields));
	if (filters) q += "&filters=" + encodeURIComponent(JSON.stringify(filters));
	return login().then(function () {
		return request("GET", apiUrl(doctype, "", q), authHeaders(false), "", 30);
	}).then(function (r) {
		if (r.status >= 200 && r.status < 300) {
			var j = JSON.parse(r.body || "{}");
			return j.data || [];
		}
		var e = new Error("Could not read " + doctype);
		e.errors = toErrors(r.status, r.body, doctype);
		e.status = r.status;
		throw e;
	});
}

/* Reads one document back. Used to verify a create actually landed, which is
   the only way to be sure of a green tick. */
function fetchDoc(doctype, name) {
	return login().then(function () {
		return request("GET", apiUrl(doctype, name), authHeaders(false), "", 30);
	}).then(function (r) {
		if (r.status >= 200 && r.status < 300) {
			var j = JSON.parse(r.body || "{}");
			return j.data || null;
		}
		if (r.status === 404) return null;
		var e = new Error("Could not read back the " + doctype);
		e.errors = toErrors(r.status, r.body, doctype);
		e.status = r.status;
		throw e;
	});
}

function post(doctype, doc) {
	return login().then(function () {
		return request("POST", apiUrl(doctype), authHeaders(true), JSON.stringify(doc), 60);
	});
}

/* Creates a document, and if ERPNext points at one particular field, drops that
   field and tries once more. Three attempts at most, and every dropped field is
   reported so nothing disappears silently. */
function createDoc(doctype, doc, notes) {
	var body = {};
	Object.keys(doc).forEach(function (k) {
		if (doc[k] !== undefined && doc[k] !== null && doc[k] !== "") body[k] = doc[k];
	});
	var tries = 0;

	function attempt() {
		tries++;
		return post(doctype, body).then(function (r) {
			if (r.status >= 200 && r.status < 300) {
				var j = JSON.parse(r.body || "{}");
				return (j.data && j.data.name) ? j.data.name : "";
			}
			var errs = toErrors(r.status, r.body, doctype);
			var bad = "";
			for (var i = 0; i < errs.length && !bad; i++) {
				bad = culpritField(errs[i].message, body);
			}
			if (bad && tries < 3) {
				var dropped = body[bad];
				delete body[bad];
				(notes || []).push({
					field: fieldFromMessage(errs[0].message) || bad,
					message: "ERPNext would not take " + bad.replace(/_/g, " ") +
						" \u201c" + dropped + "\u201d, so it was left out."
				});
				return attempt();
			}
			var e = new Error("ERPNext rejected the " + doctype);
			e.errors = errs;
			e.status = r.status;
			throw e;
		});
	}
	return attempt();
}

/* ------------------------------------------------------- doctype field list */

/* Cache of what the instance's own doctypes look like, so the payload can be
   checked before it is sent. Reading DocType needs a fairly privileged API
   user; when it is refused the checks simply fall back to the handful of Link
   fields that are known to exist in a stock ERPNext. */
var meta = {};

function describe(doctype) {
	if (meta[doctype] !== undefined) return Promise.resolve(meta[doctype]);
	return login().then(function () {
		return Promise.all([
			request("GET", apiUrl("DocType", doctype), authHeaders(false), "", 30),
			request("GET", apiUrl("Custom Field", "", "?limit_page_length=0" +
				"&fields=" + encodeURIComponent(JSON.stringify(
					["fieldname", "fieldtype", "options", "reqd", "label"])) +
				"&filters=" + encodeURIComponent(JSON.stringify([["dt", "=", doctype]]))),
				authHeaders(false), "", 30)
		]);
	}).then(function (rs) {
		if (rs[0].status < 200 || rs[0].status >= 300) { meta[doctype] = null; return null; }
		var doc = (JSON.parse(rs[0].body || "{}").data) || {};
		/* no field list means the answer is not a doctype definition — an API user
		   without DocType read access gets something else entirely, and an
		   incomplete list must never be used to drop fields */
		if (!doc.fields || !doc.fields.length) { meta[doctype] = null; return null; }
		var fields = {};
		(doc.fields || []).forEach(function (f) {
			fields[f.fieldname] = { type: f.fieldtype, options: f.options,
				reqd: !!f.reqd, label: f.label };
		});
		/* custom fields do not live in DocType.fields; without them the list is
		   incomplete and must not be used to drop anything */
		var complete = rs[1].status >= 200 && rs[1].status < 300;
		if (complete) {
			((JSON.parse(rs[1].body || "{}").data) || []).forEach(function (f) {
				fields[f.fieldname] = { type: f.fieldtype, options: f.options,
					reqd: !!f.reqd, label: f.label };
			});
		}
		meta[doctype] = { fields: fields, complete: complete };
		return meta[doctype];
	}).catch(function () { meta[doctype] = null; return null; });
}

/* --------------------------------------------------------------- link values */

/* Single-field masters that are safe to add on the fly: one column, no company
   or accounting behind them. Department is deliberately absent — it needs a
   company — and so are Country and Territory, which are fixed lists that should
   never grow from a business card. */
var CREATABLE = {
	"Salutation": "salutation",
	"Gender": "gender",
	"Designation": "designation_name"
};

var known = {};   /* "Doctype\u0000value" -> true | false */

function linkExists(doctype, value) {
	var k = doctype + "\u0000" + value;
	if (known[k] !== undefined) return Promise.resolve(known[k]);
	return fetchDoc(doctype, value).then(function (d) {
		known[k] = !!d;
		return known[k];
	}).catch(function () { return true; });   /* cannot tell — do not interfere */
}

/* Makes sure a Link value will be accepted. Resolves with a note when the value
   had to be created or dropped. */
function ensureLink(doctype, value) {
	if (!value) return Promise.resolve({ ok: true });
	return linkExists(doctype, value).then(function (there) {
		if (there) return { ok: true };
		if (!cfg.masters || !CREATABLE[doctype]) {
			return { ok: false, note: "ERPNext has no " + doctype + " called \u201c" +
				value + "\u201d, so it was left out." };
		}
		var d = {};
		d[CREATABLE[doctype]] = value;
		return createDoc(doctype, d, []).then(function () {
			known[doctype + "\u0000" + value] = true;
			return { ok: true, note: "Added \u201c" + value + "\u201d to the " +
				doctype + " list in ERPNext." };
		}).catch(function () {
			return { ok: false, note: "ERPNext has no " + doctype + " called \u201c" +
				value + "\u201d and it could not be added, so it was left out." };
		});
	});
}

/* Link fields worth checking even when the doctype's field list is not
   readable. These are stock ERPNext, so they are always right. */
var FALLBACK_LINKS = {
	Contact: { salutation: "Salutation", gender: "Gender" },
	Address: { country: "Country" },
	Customer: { territory: "Territory", customer_group: "Customer Group" },
	Supplier: { supplier_group: "Supplier Group", country: "Country",
		supplier_type: "Supplier Type" },
	Lead: { territory: "Territory", country: "Country", salutation: "Salutation" },
	Prospect: { territory: "Territory", industry: "Industry Type" },
	/* Accounts Document (purchase invoice / customs declaration / CD invoice /
	   shipping invoice bundle) — see accdoc.js. Kept here too so clean() still
	   validates these Link fields when the API user lacks DocType read access
	   and describe() falls back to this table instead of live metadata. */
	"Accounts Document": {
		supplier: "Supplier", cd_supplier: "Supplier", cd_provider: "Supplier",
		shipping_service_provider: "Supplier", customer: "Customer",
		purchase_order_reference: "Purchase Order",
		sales_invoice_reference: "Sales Invoice",
		parent_document: "Accounts Document", amended_from: "Accounts Document"
	}
};

/* Checks a payload against the doctype before it is sent: drops fields the
   instance does not have, checks Select values against their options, and
   resolves Link values. Resolves with { doc, notes }. */
function clean(doctype, doc, notes) {
	notes = notes || [];
	return describe(doctype).then(function (m) {
		var out = {};
		var links = [];

		Object.keys(doc).forEach(function (k) {
			var v = doc[k];
			if (v === undefined || v === null || v === "") return;

			var f = m && m.fields ? m.fields[k] : null;

			if (m && m.complete && !f) {
				notes.push({ field: LABEL_TO_FIELD[k] || k,
					message: "This ERPNext has no \u201c" + k.replace(/_/g, " ") +
						"\u201d field on " + doctype + ", so it was left out." });
				return;
			}

			if (f && f.type === "Select" && typeof v === "string") {
				var opts = String(f.options || "").split("\n")
					.map(function (o) { return o.trim(); })
					.filter(function (o) { return o.length; });
				if (opts.length && opts.indexOf(v) < 0) {
					notes.push({ field: LABEL_TO_FIELD[k] || k,
						message: (f.label || k) + " has to be one of " +
							opts.join(", ") + " in ERPNext, so \u201c" + v +
							"\u201d was left out." });
					return;
				}
			}

			if (f && f.type === "Link" && f.options && typeof v === "string") {
				links.push({ key: k, doctype: f.options, value: v });
			} else if (!f) {
				var fb = FALLBACK_LINKS[doctype] || {};
				if (fb[k] && typeof v === "string") {
					links.push({ key: k, doctype: fb[k], value: v });
				}
			}
			out[k] = v;
		});

		/* resolve the Link values one after another; they share the cache */
		return links.reduce(function (chain, l) {
			return chain.then(function () {
				return ensureLink(l.doctype, l.value).then(function (r) {
					if (r.note) {
						notes.push({ field: LINK_DOCTYPE_TO_FIELD[l.doctype] ||
							LABEL_TO_FIELD[l.key] || l.key, message: r.note });
					}
					if (!r.ok) delete out[l.key];
				});
			});
		}, Promise.resolve()).then(function () {
			return { doc: out, notes: notes };
		});
	});
}

/* --------------------------------------------------------------- vocabulary */

/* Pulls the real Territory and Country lists so the standardising works against
   what the instance actually holds rather than a list frozen at build time. */
function refreshVocabulary() {
	var unreadable = [];
	function soft(doctype, fields) {
		return getList(doctype, null, fields, 0).catch(function (err) {
			if (err && err.status === 403) unreadable.push(doctype);
			return [];
		});
	}
	return Promise.all([
		soft("Territory", ["name", "is_group"]),
		soft("Country", ["name"])
	]).then(function (r) {
		var terr = r[0].filter(function (t) { return !t.is_group; })
			.map(function (t) { return t.name; });
		var ctry = r[1].map(function (c) { return c.name; });
		N.setLive(terr, ctry);
		return { territories: terr.length, countries: ctry.length, unreadable: unreadable };
	});
}

function testConnection() {
	var bad = ready();
	if (bad) return Promise.reject(new Error(bad));
	/* Same check the first versions made: read the Territory and Country lists.
	   Only when BOTH come back refused do we ask ERPNext who it thinks is calling,
	   to tell "key not recognised" apart from "user lacks read rights". */
	return login()
		.then(function () { return refreshVocabulary(); })
		.then(function (v) {
			if (cfg.mode !== "token" || !v.unreadable || v.unreadable.length < 2) return v;
			return request("GET", methodUrl("frappe.auth.get_logged_user"), authHeaders(false), "", 30)
				.then(function (r) {
					var who = "";
					try { who = (JSON.parse(r.body || "{}").message || ""); } catch (x) { who = ""; }
					var anon = !who || String(who).toLowerCase() === "guest" || r.status === 401 || r.status === 403;
					if (!anon) return v;
					var ge = new Error("ERPNext is not recognising the API key and secret this app sends " +
						"— it answers as if nobody were signed in (HTTP " + r.status + (who ? ", \u201c" + who + "\u201d" : "") +
						"). The app is sending a key of " + cfg.key.length + " characters (starts \u201c" +
						cfg.key.slice(0, 4) + "\u201d) and a secret of " + cfg.secret.length + " characters to " +
						cfg.url + ". Compare with ERPNext \u2192 User \u2192 API Access, and re-enter both in " +
						"this app\u2019s own Settings (they are not shared with the phone app).");
					ge.errors = [{ field: "", message: ge.message }];
					throw ge;
				}, function () { return v; });
		});
}

/* ------------------------------------------------------------- duplicates */

var ORG = {
	Customer:  { field: "customer_name", label: "Customer" },
	Supplier:  { field: "supplier_name", label: "Supplier" },
	Lead:      { field: "company_name",  label: "Lead" },
	Prospect:  { field: "company_name",  label: "Prospect" }
};

function findOrg(doctype, name) {
	var f = ORG[doctype];
	if (!f || !name) return Promise.resolve(null);
	return getList(doctype, [[f.field, "=", name]], ["name", f.field], 1)
		.then(function (rows) { return rows.length ? rows[0].name : null; });
}

/* A contact is the same person if the primary email matches; failing that, if
   both the first and the last name match and neither is empty. */
function findContact(f) {
	var byEmail = f.email
		? getList("Contact", [["email_id", "=", f.email]], ["name"], 1)
		: Promise.resolve([]);
	return byEmail.then(function (rows) {
		if (rows.length) return rows[0].name;
		if (!f.first_name || !f.last_name) return null;
		return getList("Contact", [["first_name", "=", f.first_name],
			["last_name", "=", f.last_name]], ["name"], 1)
			.then(function (r2) { return r2.length ? r2[0].name : null; });
	});
}

/* An address is the same place if line 1 and the city match. */
function findAddress(f) {
	if (!f.address_line1 || !f.city) return Promise.resolve(null);
	return getList("Address", [["address_line1", "=", f.address_line1],
		["city", "=", f.city]], ["name"], 1)
		.then(function (rows) { return rows.length ? rows[0].name : null; });
}

/* --------------------------------------------------------------- documents */

function orgDoc(doctype, f, territory) {
	var name = f.company_name || ((f.first_name + " " + f.last_name).trim());
	var d = {};
	if (doctype === "Customer") {
		d.customer_name = name;
		d.customer_type = f.company_name ? "Company" : "Individual";
		if (territory) d.territory = territory;
	} else if (doctype === "Supplier") {
		d.supplier_name = name;
		/* Supplier Type is a Link to this instance's own "Supplier Type" list
		   (not the stock Company/Individual pair), so there is no safe value
		   to guess from a business card — it has to come from Settings, and
		   is left out entirely (causing a clear MandatoryError) if unset,
		   rather than guessing a value ERPNext will reject anyway. */
		if (cfg.supplierType) d.supplier_type = cfg.supplierType;
		if (f.website) d.website = f.website;
		if (f.country_field || territory) d.country = f.country_field || territory;
	} else if (doctype === "Lead") {
		d.lead_name = (f.first_name + " " + f.last_name).trim() || name;
		d.first_name = f.first_name || "";
		d.last_name = f.last_name || "";
		if (f.company_name) { d.company_name = f.company_name; d.organization_lead = 1; }
		if (f.email) d.email_id = f.email;
		if (f.mobile_no) d.mobile_no = f.mobile_no;
		if (f.phone) d.phone = f.phone;
		if (f.designation) d.designation = f.designation;
		if (f.website) d.website = f.website;
		if (territory) d.territory = territory;
		if (f.city) d.city = f.city;
		if (f.country_field || territory) d.country = f.country_field || territory;
	} else if (doctype === "Prospect") {
		d.company_name = name;
		if (f.website) d.website = f.website;
		if (territory) d.territory = territory;
	}
	return d;
}

/* Contact status is a Select with exactly these three options. */
var CONTACT_STATUS = ["Passive", "Open", "Replied"];

function contactDoc(f, link) {
	var d = {
		first_name: f.first_name || "",
		last_name: f.last_name || "",
		salutation: f.salutation || undefined,
		designation: f.designation || undefined,
		department: f.department || undefined,
		company_name: f.company_name || undefined,
		unsubscribed: f.newsletter ? 0 : 1,
		status: CONTACT_STATUS.indexOf(f.status) >= 0 ? f.status : "Open",
		is_primary_contact: f.is_primary ? 1 : 0
	};
	if (f.linkedin) d.linkedin = f.linkedin;
	var emails = [];
	if (f.email) emails.push({ email_id: f.email, is_primary: 1 });
	if (f.email_secondary) emails.push({ email_id: f.email_secondary, is_primary: 0 });
	if (emails.length) d.email_ids = emails;
	var phones = [];
	if (f.mobile_no) phones.push({ phone: f.mobile_no, is_primary_mobile_no: 1 });
	if (f.phone) phones.push({ phone: f.phone, is_primary_phone: 1 });
	if (f.fax) phones.push({ phone: f.fax });
	if (phones.length) d.phone_nos = phones;
	if (link) d.links = [{ link_doctype: link.doctype, link_name: link.name }];
	return d;
}

function addressDoc(f, link, territory) {
	var title = f.company_name || ((f.first_name + " " + f.last_name).trim()) || f.city;
	var d = {
		address_title: title,
		address_type: f.address_type || "Office",
		address_line1: f.address_line1 || "",
		address_line2: f.address_line2 || undefined,
		city: f.city || "",
		county: f.state || undefined,
		state: f.state || undefined,
		pincode: f.pincode || undefined,
		country: f.country_field || territory || "",
		email_id: f.email || undefined,
		phone: f.phone || f.mobile_no || undefined,
		fax: f.fax || undefined,
		is_primary_address: f.is_primary ? 1 : 0
	};
	if (link) d.links = [{ link_doctype: link.doctype, link_name: link.name }];
	return d;
}

/* ------------------------------------------------------------- attachments */

/* Every scan is kept private: its address must start with /private/files/. When ERPNext has put a freshly
   created File into the public folder anyway (address /files/…, which then cannot be opened), the File is
   switched to private — the same thing the lock icon does in ERPNext: the server moves the file and rewrites
   the address, including the one in the document's Attach field. Resolves the File record as it is afterwards
   ({ name, file_url, file_size, … }) or rejects with a message. */
function ensurePrivate(fileName, fdoc) {
	if (fdoc && /^\/private\/files\//.test(fdoc.file_url || "")) return Promise.resolve(fdoc);
	if (!fdoc || !fdoc.file_url) return Promise.resolve(fdoc);
	return updateDoc("File", fileName, { is_private: 1 }).then(function () {
		return fetchDoc("File", fileName);
	}).then(function (again) {
		if (again && /^\/private\/files\//.test(again.file_url || "")) return again;
		var e = new Error("ERPNext stored the file in the public folder (" + fdoc.file_url + ") and did not move it to the private one.");
		throw e;
	}, function (err) {
		var why = err && err.errors && err.errors[0] && err.errors[0].message ? err.errors[0].message : (err && err.message) || "unknown error";
		throw new Error("ERPNext stored the file in the public folder (" + fdoc.file_url + ") and refused to make it private: " + why);
	});
}

/* ----------------------------------------------------------- file upload
   Two calls to Frappe's own /api/method/upload_file — the endpoint ERPNext's web page uses:

     1. upload: multipart/form-data with the file and is_private=1. The server stores the file and answers
        with its address (/private/files/<name>). Nothing is attached yet.
     2. attach: a plain form post with doctype, docname, file_url, filename and is_private=1, which creates
        the File record that links the stored file to the document.

   The address is then written into the Attach field of the document by the caller.

   The native HTTP bridges carry text only, so the multipart body of step 1 is assembled here as bytes,
   sent as base64 text, and flagged with the X-CS-Body-Encoding header; the native side (Android, iOS,
   the desktop shell) turns it back into the raw bytes before it goes on the wire and removes the header. */

function utf8Bytes(str) {
	var bin = unescape(encodeURIComponent(String(str)));
	var out = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function base64Bytes(b64) {
	var bin = atob(b64);
	var out = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesBase64(bytes) {
	var s = "";
	for (var i = 0; i < bytes.length; i += 0x8000) {
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}
	return btoa(s);
}

function guessMime(filename, dataUrl) {
	var m = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ""));
	if (m && m[1] && m[1] !== "application/octet-stream") return m[1];
	var ext = (/\.([A-Za-z0-9]+)$/.exec(String(filename || "")) || [])[1];
	ext = (ext || "").toLowerCase();
	return { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
		gif: "image/gif", webp: "image/webp", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[ext] || "application/octet-stream";
}

/* One multipart/form-data body. fields: { name: text }; the file goes in the part called "file".
   Resolves { contentType, base64 }. */
function multipartBody(fields, filename, mime, fileBytes) {
	var boundary = "----IODocScanner" + Date.now().toString(16) + Math.floor(Math.random() * 1e9).toString(16);
	var chunks = [];
	Object.keys(fields).forEach(function (k) {
		if (fields[k] === undefined || fields[k] === null || fields[k] === "") return;
		chunks.push(utf8Bytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" +
			String(fields[k]) + "\r\n"));
	});
	var safe = String(filename).replace(/[\r\n"\\]/g, "_");
	chunks.push(utf8Bytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + safe + "\"\r\n" +
		"Content-Type: " + mime + "\r\n\r\n"));
	chunks.push(fileBytes);
	chunks.push(utf8Bytes("\r\n--" + boundary + "--\r\n"));
	var total = 0;
	chunks.forEach(function (c) { total += c.length; });
	var all = new Uint8Array(total), at = 0;
	chunks.forEach(function (c) { all.set(c, at); at += c.length; });
	return { contentType: "multipart/form-data; boundary=" + boundary, base64: bytesBase64(all) };
}

/* Step 1. Uploads the file (private) and resolves the File record as the server has it
   ({ name, file_url, file_size, is_private … }) after making sure its address is under /private/files/. */
function uploadFile(dataUrl, filename) {
	var base64 = String(dataUrl).indexOf(",") >= 0
		? String(dataUrl).split(",").slice(1).join(",")
		: String(dataUrl);
	var bytes;
	try { bytes = base64Bytes(base64); } catch (e) { return Promise.reject(new Error("The file could not be read (not valid base64).")); }
	var body = multipartBody({ is_private: 1, folder: "Home/Attachments" }, filename,
		guessMime(filename, dataUrl), bytes);
	return login().then(function () {
		var h = authHeaders(false);
		h["Content-Type"] = body.contentType;
		h["X-CS-Body-Encoding"] = "base64";
		return request("POST", methodUrl("upload_file"), h, body.base64, 120);
	}).then(function (r) {
		if (r.status < 200 || r.status >= 300) {
			var e = new Error("ERPNext rejected the upload");
			e.errors = toErrors(r.status, r.body, "File");
			e.status = r.status;
			throw e;
		}
		var j = {};
		try { j = JSON.parse(r.body || "{}"); } catch (x) { /* not JSON */ }
		var m = j.message;
		if (!m || !m.name) throw new Error("ERPNext accepted the upload but did not say where it stored the file.");
		/* read the record back: the stored size and the final address are what matter */
		return fetchDoc("File", m.name).then(function (fdoc) { return fdoc || m; }, function () { return m; });
	}).then(function (fdoc) {
		return ensurePrivate(fdoc.name, fdoc);
	});
}

/* Step 2. Links an already stored file to a document: upload_file with file_url (no file part) creates
   the File record attached to doctype/docname. Resolves that record ({ name, file_url … }). */
function linkFile(doctype, docname, fileUrl, filename) {
	return login().then(function () {
		return request("POST", methodUrl("upload_file"), authHeaders(false), form({
			doctype: doctype, docname: docname, file_url: fileUrl,
			filename: filename, file_name: filename, is_private: 1
		}), 60);
	}).then(function (r) {
		if (r.status < 200 || r.status >= 300) {
			var e = new Error("ERPNext rejected attaching the file");
			e.errors = toErrors(r.status, r.body, doctype);
			e.status = r.status;
			throw e;
		}
		var j = {};
		try { j = JSON.parse(r.body || "{}"); } catch (x) { /* not JSON */ }
		return j.message || { file_url: fileUrl };
	});
}

/* Both steps. Resolves { up, linked }; a failure of step 2 carries the stored file's address. */
function uploadAndAttach(dataUrl, filename, doctype, docname) {
	return uploadFile(dataUrl, filename).then(function (up) {
		return linkFile(doctype, docname, up.file_url, filename).then(function (linked) {
			return { up: up, linked: linked };
		}, function (err) {
			var m = err && err.errors && err.errors[0] && err.errors[0].message ? err.errors[0].message : (err && err.message) || "unknown error";
			var e = new Error("The file was uploaded (" + up.file_url + "), but ERPNext could not attach it to " +
				doctype + " " + docname + ": " + m);
			e.uploaded = up;
			throw e;
		});
	});
}

/* Uploads the photo of the card and attaches it to a document — private, because a business card is
   personal data. */
function attachImage(doctype, name, dataUrl, label) {
	if (!dataUrl || !name) return Promise.resolve({ state: "off" });
	var base64 = String(dataUrl).indexOf(",") >= 0
		? String(dataUrl).split(",").slice(1).join(",")
		: String(dataUrl);
	if (!base64) return Promise.resolve({ state: "off" });
	var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	var safe = String(label || "card").replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "").slice(0, 40) || "card";
	return uploadAndAttach(dataUrl, "business-card-" + safe + "-" + stamp + ".jpg", doctype, name)
		.then(function (r) {
			return { state: "created", name: r.up.name, url: r.up.file_url || "" };
		}).catch(function (e) {
			return { state: "error", name: e.uploaded && e.uploaded.name,
				errors: e.errors || [{ field: "", message: e.message || String(e) }] };
		});
}

/* Updates fields on an existing document. Used to fill in a later section
   (Customs Declaration / CD Invoice / Shipping Invoice) of an Accounts
   Document that already exists, rather than creating a new record. */
function updateDoc(doctype, name, patch) {
	return login().then(function () {
		return request("PUT", apiUrl(doctype, name), authHeaders(true),
			JSON.stringify(patch), 60);
	}).then(function (r) {
		if (r.status >= 200 && r.status < 300) {
			var j = JSON.parse(r.body || "{}");
			return j.data || null;
		}
		var e = new Error("ERPNext rejected updating " + doctype);
		e.errors = toErrors(r.status, r.body, doctype);
		e.status = r.status;
		throw e;
	});
}

/* Uploads a file (a scanned PDF, typically), attaches it to a document and — when fieldname is given —
   writes the resulting file_url into that Attach field of the document. An Attach field stores a URL
   string on the document itself, so creating the File record alone is not enough for it to show in that
   field: the field has to be written too.

   Nothing is assumed to have worked: the File record is read back (it must have an address and the
   stored size must match what was sent), the address is requested from the server (a 404 here is the
   "attachment exists but the link is dead" case), and the field write is checked. Whatever fails is
   reported in plain words instead of being swallowed. Resolves { state: "created"|"error"|"off", name,
   url, size, errors }. */
function attachFile(doctype, name, dataUrl, filename, fieldname) {
	if (!dataUrl || !name) return Promise.resolve({ state: "off" });
	var base64 = String(dataUrl).indexOf(",") >= 0
		? String(dataUrl).split(",").slice(1).join(",")
		: String(dataUrl);
	if (!base64) return Promise.resolve({ state: "off" });
	var sent = Math.floor(base64.replace(/=+$/, "").length * 3 / 4);
	function fail(message, extra) {
		var out = { state: "error", errors: [{ field: fieldname || "", message: message }] };
		if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
		return out;
	}
	return uploadAndAttach(dataUrl, filename || ("document-" + Date.now() + ".pdf"), doctype, name)
		.then(function (r) {
			var fileName = r.up.name;
			var url = (r.linked && r.linked.file_url) || r.up.file_url || "";
			var size = r.up.file_size ? Number(r.up.file_size) : 0;
			var info = { name: fileName, url: url, size: size };
			if (!url) {
				return fail("ERPNext stored the file but gave it no file address, so it cannot be opened.", info);
			}
			if (size && sent && Math.abs(size - sent) > Math.max(16, sent * 0.02)) {
				return fail("ERPNext stored " + size + " bytes but " + sent + " were sent — the attachment " +
					"(" + url + ") is not the file that was scanned.", info);
			}
			/* is the file really there? ask for its first bytes */
			var h = authHeaders(false);
			h["Range"] = "bytes=0-15";
			return request("GET", cfg.url + encodeURI(url), h, "", 30).then(function (rr) {
				if (rr.status === 404) {
					return fail("ERPNext lists the attachment, but its file is missing on the server (404 for " + url + ").", info);
				}
				if (rr.status >= 400) {
					return fail("The attachment was uploaded, but the server refuses to serve it (" + rr.status + " for " + url + ").", info);
				}
				return null;
			}, function () { return null; /* could not check — do not claim a failure */ }).then(function (bad) {
				if (bad) return bad;
				if (!fieldname) return { state: "created", name: fileName, url: url, size: size };
				var patch = {};
				patch[fieldname] = url;
				return updateDoc(doctype, name, patch).then(function () {
					return { state: "created", name: fileName, url: url, size: size };
				}, function (e) {
					var m = e && e.errors && e.errors[0] && e.errors[0].message ? e.errors[0].message : (e && e.message) || "unknown error";
					return fail("The file is attached, but it could not be written into the \u201c" + fieldname + "\u201d field: " + m, info);
				});
			});
		}).catch(function (e) {
			var extra = e && e.uploaded ? { name: e.uploaded.name, url: e.uploaded.file_url } : null;
			var m = e && e.errors && e.errors[0] && e.errors[0].message ? e.errors[0].message : (e && e.message) || "unknown error";
			return fail(m, extra);
		});
}

/* ------------------------------------------------------------------- sync */

/* Pushes one card. `want` says which of the three toggles are on:
     { org: "Customer" | "Lead" | "Supplier" | "Prospect" | "", contact: bool,
       address: bool }
   Resolves with a report; it never rejects for a per-document problem, so one
   failure does not hide the outcome of the other two. Each part carries
   state ∈ off | created | duplicate | error, `ok` for the tick or the cross,
   `verified` once the record has been read back, and any notes about values
   that had to be changed to get it accepted. */
function syncCard(f, want, territory) {
	var report = {
		org: { state: "off", name: "", doctype: want.org || "", ok: null,
			verified: false, errors: [], notes: [] },
		contact: { state: "off", name: "", ok: null, verified: false,
			errors: [], notes: [] },
		address: { state: "off", name: "", ok: null, verified: false,
			errors: [], notes: [] },
		file: { state: "off", name: "", ok: null, errors: [] }
	};
	var bad = ready();
	if (bad) {
		report.fatal = bad;
		return Promise.resolve(report);
	}

	var link = null;

	function step(part, on, find, doctype, build) {
		var p = report[part];
		if (!on) return Promise.resolve();
		p.state = "working";
		return find().then(function (existing) {
			if (existing) {
				p.state = "duplicate";
				p.name = existing;
				p.ok = true;
				p.verified = true;
				if (part === "org") link = { doctype: doctype, name: existing };
				return;
			}
			return clean(doctype, build(), p.notes).then(function (c) {
				return createDoc(doctype, c.doc, p.notes);
			}).then(function (name) {
				p.state = "created";
				p.name = name;
				if (part === "org") link = { doctype: doctype, name: name };
				/* read it back, so a tick means the record is really there */
				return fetchDoc(doctype, name).then(function (d) {
					p.verified = !!d;
					p.ok = !!d;
					if (!d) {
						p.state = "error";
						p.errors = [{ field: "", message: "ERPNext accepted the " +
							doctype + " but it could not be read back — check it by hand." }];
					}
				}).catch(function () {
					/* the create succeeded; only the confirmation failed */
					p.verified = false;
					p.ok = true;
				});
			});
		}).catch(function (e) {
			p.state = "error";
			p.ok = false;
			p.errors = e.errors || [{ field: "", message: e.message || String(e) }];
		});
	}

	return login().catch(function (e) {
		report.fatal = (e.errors && e.errors[0] && e.errors[0].message) ||
			e.message || String(e);
	}).then(function () {
		if (report.fatal) return report;
		return step("org", !!want.org,
				function () { return findOrg(want.org, f.company_name); },
				want.org, function () { return orgDoc(want.org, f, territory); })
			.then(function () {
				return step("contact", !!want.contact,
					function () { return findContact(f); },
					"Contact", function () { return contactDoc(f, link); });
			})
			.then(function () {
				return step("address", !!want.address,
					function () { return findAddress(f); },
					"Address", function () { return addressDoc(f, link, territory); });
			})
			.then(function () {
				/* the photo goes on the contact, which is where you look for it */
				if (!cfg.attach || !f.card_image) return;
				if (report.contact.state !== "created") return;
				return attachImage("Contact", report.contact.name, f.card_image,
						(f.first_name + " " + f.last_name).trim() || f.company_name)
					.then(function (r) {
						report.file = { state: r.state, name: r.name || "",
							ok: r.state === "created" ? true : (r.state === "error" ? false : null),
							errors: r.errors || [] };
					});
			})
			.then(function () { return report; });
	});
}

return {
	configure: configure, ready: ready, login: login,
	testConnection: testConnection, refreshVocabulary: refreshVocabulary,
	syncCard: syncCard, ORG_DOCTYPES: Object.keys(ORG),
	/* Low-level ERPNext plumbing, exposed so other shared modules (accdoc.js,
	   for the purchase-invoice / customs / shipping-invoice workflow) can
	   reuse auth, doctype-metadata checks and error handling instead of
	   re-implementing them. */
	shared: {
		getList: getList, createDoc: createDoc, updateDoc: updateDoc,
		fetchDoc: fetchDoc, apiUrl: apiUrl, methodUrl: methodUrl, request: request,
		authHeaders: authHeaders, describe: describe, clean: clean,
		ensureLink: ensureLink, attachFile: attachFile, toErrors: toErrors,
		login: login, ready: ready
	},
	_internals: { readError: readError, tracebackTail: tracebackTail,
		splitException: splitException, fieldFromMessage: fieldFromMessage,
		culpritField: culpritField, orgDoc: orgDoc, contactDoc: contactDoc,
		addressDoc: addressDoc, toErrors: toErrors, clean: clean,
		describe: describe, ensureLink: ensureLink, attachImage: attachImage,
		attachFile: attachFile, updateDoc: updateDoc,
		fetchDoc: fetchDoc, CREATABLE: CREATABLE, FALLBACK_LINKS: FALLBACK_LINKS,
		CONTACT_STATUS: CONTACT_STATUS, EXPLAIN: EXPLAIN }
};
})();
