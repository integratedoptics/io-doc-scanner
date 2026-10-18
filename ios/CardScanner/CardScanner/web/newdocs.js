/* newdocs.js — the NEW way of filing scanned documents, run next to the old Accounts Document flow.

   The old flow (accdoc.js) files everything as an "Accounts Document" on the live server. This flow files each
   document under the ERPNext doctype it really is, on the backup / test server (Settings → test server address,
   same login as the live server):

     purchase invoice, shipping / courier invoice, customs-broker invoice  →  Purchase Invoice (with its item lines)
     airwaybill (waybill)                                                  →  a Purchase Receipt made from the
                                                                              Purchase Order that carries the AWB number
     supplier quotation                                                    →  Supplier Quotation (with its item lines)

   Customs declarations have no doctype yet, and proforma / sales invoices stay on the old flow only.

   Item lines are matched to ERPNext Items by ITEM CODE only:
     100 %      green   the code exists
     90 – 99 %  orange  a close code (typo, separators) — "use" the closest item, or "create new"
     under 90   red     no such item — "create new" (the default) or "use" one of the closest
   "Create new" creates the Item first, then the document that uses it. Item Group and Stock UOM for new items come
   from Settings. Each line is also compared with the Purchase Orders printed on the document: ordered, already
   received, and what this document delivers.

   Documents are created as drafts. Nothing here is submitted.

   Everything talks to window.CS_ERP_TEST.shared (the second server instance of erp.js); a test can hand in its own
   with CS_NEW.useServer(shared). */
window.CS_NEW = (function () {
"use strict";

var server = null;
function T() { return server || window.CS_ERP_TEST.shared; }
function useServer(s) { server = s; cache.items = null; fieldCache = {}; }
function settings() { return (window.CS && window.CS.settings && window.CS.settings()) || {}; }

function has(v) { return v !== undefined && v !== null && v !== ""; }
function num(v) {
	if (typeof v === "number") return isFinite(v) ? v : null;
	var t = String(v === undefined || v === null ? "" : v).replace(/\s/g, "").replace(/[^\d,.\-]/g, "");
	if (!t) return null;
	if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
	else t = t.replace(/,/g, "");
	var n = parseFloat(t);
	return isFinite(n) ? n : null;
}
function round(n, d) { var f = Math.pow(10, d == null ? 2 : d); return Math.round(n * f) / f; }
function errText(e) {
	if (e && e.errors && e.errors.length) return e.errors.map(function (x) { return x.message; }).join(" ");
	return (e && e.message) || String(e);
}

/* -------------------------------------------------------------- settings */

function cfg() {
	var s = settings();
	return {
		enabled: !!String(s.erp_test_url || "").trim(),
		itemGroup: String(s.new_item_group || "").trim(),
		stockUom: String(s.new_stock_uom || "Nos").trim() || "Nos",
		serviceItem: String(s.new_service_item || "").trim(),
		company: String(s.new_company || "").trim(),
		taxes: String(s.new_taxes || "").trim(),
		vatAccount: String(s.new_vat_account || "").trim(),
		shippingAccount: String(s.new_shipping_account || "").trim(),
		otherAccount: String(s.new_other_account || "").trim(),
		chargeCategory: /^valuation/i.test(String(s.new_charge_category || "")) ? "Valuation and Total" : "Total",
		costCenter: String(s.new_cost_center || "").trim()
	};
}

/* ------------------------------------------------------- item similarity */

function norm(s) { return String(s || "").toUpperCase().replace(/\s+/g, " ").trim(); }
function squash(s) { return norm(s).replace(/[\s\-_.\/\\]/g, ""); }

function lev(a, b) {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	var prev = [], cur = [], i, j;
	for (j = 0; j <= b.length; j++) prev[j] = j;
	for (i = 1; i <= a.length; i++) {
		cur[0] = i;
		for (j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
		}
		var t = prev; prev = cur; cur = t;
	}
	return prev[b.length];
}

/* 0 – 100. 100 only for the same code (case and surrounding spaces ignored); a code that differs only in
   separators (spaces, dashes, dots, slashes) is 99; anything else is the edit-distance ratio, capped at 99. */
function similarity(a, b) {
	var x = norm(a), y = norm(b);
	if (!x || !y) return 0;
	if (x === y) return 100;
	var sx = squash(x), sy = squash(y);
	if (sx && sx === sy) return 99;
	var m = Math.max(sx.length, sy.length);
	if (!m) return 0;
	return Math.min(99, Math.floor((1 - lev(sx, sy) / m) * 100));
}

function levelOf(score) { return score >= 100 ? "green" : (score >= 90 ? "orange" : "red"); }

var cache = { items: null, at: 0 };
var ITEM_TTL = 5 * 60 * 1000;

/* every enabled Item: code and name (cached for five minutes; a new scan after creating items refreshes it) */
function loadItems(force) {
	if (!force && cache.items && Date.now() - cache.at < ITEM_TTL) return Promise.resolve(cache.items);
	return T().getList("Item", [["disabled", "=", 0]], ["name", "item_code", "item_name", "stock_uom"], 0).then(function (rows) {
		cache.items = rows.map(function (r) {
			var code = r.item_code || r.name;
			return { name: r.name, code: code, itemName: r.item_name || "", uom: r.stock_uom || "", sq: squash(code), up: norm(code) };
		});
		cache.at = Date.now();
		return cache.items;
	});
}
function forgetItems() { cache.items = null; }

/* the closest existing Items for a printed code, best first (at most `limit`, none under 50 %) */
function candidatesFor(code, items, limit) {
	var x = norm(code), sx = squash(code);
	if (!x) return [];
	var out = [];
	for (var i = 0; i < items.length; i++) {
		var it = items[i], score;
		if (it.up === x) score = 100;
		else if (sx && it.sq === sx) score = 99;
		else {
			var m = Math.max(sx.length, it.sq.length);
			if (!m || Math.abs(sx.length - it.sq.length) / m > 0.5) continue;
			score = Math.min(99, Math.floor((1 - lev(sx, it.sq) / m) * 100));
		}
		if (score >= 50) out.push({ code: it.name, name: it.itemName, score: score });
	}
	out.sort(function (a, b) { return b.score - a.score || a.code.length - b.code.length; });
	return out.slice(0, limit || 5);
}

/* A line as read off the document, in the shape the review screen and the creators use. */
function normalizeLine(l) {
	l = l || {};
	var qty = num(l.quantity != null ? l.quantity : l.qty);
	var rate = num(l.unit_price != null ? l.unit_price : l.rate);
	var amount = num(l.line_total != null ? l.line_total : l.amount);
	if (rate === null && amount !== null && qty) rate = round(amount / qty, 4);
	return {
		code: String(l.item_code || l.code || "").trim(),
		description: String(l.description || "").replace(/\s+/g, " ").trim(),
		qty: qty, rate: rate, amount: amount,
		unit: String(l.unit || l.uom || "").trim(),
		poReference: String(l.po_reference || l.poReference || "").trim()
	};
}

function codeFromDescription(d) {
	return String(d || "").replace(/\s+/g, " ").trim().slice(0, 40).toUpperCase();
}

/* Matches one line against the item list and sets the default decision. */
function matchLine(line, items) {
	var c = cfg();
	var m;
	if (!line.code) {
		if (c.serviceItem) {
			m = { score: 100, level: "green", candidates: [], kind: "default" };
			line.match = m;
			line.decision = { mode: "use", itemCode: c.serviceItem, newCode: "", newName: line.description };
			return line;
		}
		m = { score: 0, level: "red", candidates: [], kind: "nocode" };
		line.match = m;
		line.decision = { mode: "create", itemCode: "", newCode: codeFromDescription(line.description), newName: line.description };
		return line;
	}
	var cands = candidatesFor(line.code, items, 5);
	var best = cands[0];
	var score = best ? best.score : 0;
	line.match = { score: score, level: levelOf(score), candidates: cands, kind: "code" };
	if (score >= 100) {
		line.decision = { mode: "use", itemCode: best.code, newCode: line.code, newName: line.description };
	} else if (score >= 90) {
		line.decision = { mode: "use", itemCode: best.code, newCode: line.code, newName: line.description };
	} else {
		line.decision = { mode: "create", itemCode: best ? best.code : "", newCode: line.code, newName: line.description };
	}
	return line;
}

function matchLines(lines) {
	return loadItems().then(function (items) {
		return lines.map(function (l) { return matchLine(l, items); });
	});
}

/* the Item a line will end up with ("" while a new item has no code yet) */
function finalCode(line) {
	var d = line.decision || {};
	return d.mode === "create" ? String(d.newCode || "").trim() : String(d.itemCode || "").trim();
}

/* ------------------------------------------------------ Purchase Orders */

function uniq(list) {
	var out = [];
	list.forEach(function (v) {
		v = String(v || "").trim();
		if (v && out.indexOf(v) < 0) out.push(v);
	});
	return out;
}

function loadPurchaseOrders(names) {
	names = uniq(names);
	return Promise.all(names.map(function (n) {
		return T().fetchDoc("Purchase Order", n).then(function (d) { return d; }, function () { return null; });
	})).then(function (docs) {
		var out = { docs: {}, missing: [] };
		docs.forEach(function (d, i) { if (d) out.docs[names[i]] = d; else out.missing.push(names[i]); });
		return out;
	});
}

/* For every line: the Purchase Order line with the same Item — ordered, received so far, still open — and how
   the quantity on this document compares. A Purchase Order line is only used once. */
function annotatePo(lines, pos) {
	var used = {};
	lines.forEach(function (line) {
		line.po = null; line.poNote = "";
		var code = finalCode(line);
		if (!code) return;
		var names = Object.keys(pos.docs);
		if (line.poReference && pos.docs[line.poReference]) {
			names = [line.poReference].concat(names.filter(function (n) { return n !== line.poReference; }));
		}
		var pick = null;
		names.forEach(function (n) {
			((pos.docs[n].items) || []).forEach(function (it) {
				if (it.item_code !== code) return;
				var ordered = num(it.qty) || 0, received = num(it.received_qty) || 0;
				var open = Math.max(0, ordered - received - (used[it.name] || 0));
				var cand = { po: n, detail: it.name, ordered: ordered, received: received, open: open, rate: num(it.rate), uom: it.uom || "" };
				if (!pick || (pick.open <= 0 && cand.open > 0)) pick = cand;
			});
		});
		if (!pick) {
			if (Object.keys(pos.docs).length) line.poNote = "Not on " + Object.keys(pos.docs).join(", ") + ".";
			return;
		}
		line.po = pick;
		used[pick.detail] = (used[pick.detail] || 0) + (line.qty || 0);
		var q = line.qty || 0;
		line.poNote = pick.po + ": ordered " + pick.ordered + ", received so far " + pick.received + ", this document " + q +
			(q > pick.open ? " — more than the " + pick.open + " still open" : "");
		line.poWarn = q > pick.open;
		if (pick.rate !== null && line.rate !== null && Math.abs(pick.rate - line.rate) > 0.005 * Math.max(1, Math.abs(pick.rate))) {
			line.poNote += "; price " + line.rate + " vs " + pick.rate + " on the order";
			line.poWarn = true;
		}
	});
	return lines;
}

/* -------------------------------------------------------- field names */

var fieldCache = {};

/* A field's real name when only the start of it is known (the customize form shows "tracking_awb_…"):
   look it up in the doctype's own field list; when that list is not readable, use the first guess. */
function resolveField(doctype, prefixes, guess) {
	var k = doctype + "\u0000" + prefixes.join(",");
	if (fieldCache[k] !== undefined) return Promise.resolve(fieldCache[k]);
	return T().describe(doctype).then(function (m) {
		var found = "";
		if (m && m.fields) {
			var names = Object.keys(m.fields);
			for (var i = 0; i < prefixes.length && !found; i++) {
				if (names.indexOf(prefixes[i]) >= 0) found = prefixes[i];
				else {
					for (var j = 0; j < names.length; j++) {
						if (names[j].indexOf(prefixes[i]) === 0) { found = names[j]; break; }
					}
				}
			}
			if (!found && m.complete) found = "";   /* the field does not exist on this server */
			else if (!found) found = guess || "";
		} else {
			found = guess || "";
		}
		fieldCache[k] = found;
		return found;
	}, function () { fieldCache[k] = guess || ""; return guess || ""; });
}

/* --------------------------------------------------------- supplier */

/* The Supplier on the test server: exact name, the same registration / tax ID, or the same name apart from case,
   punctuation and legal form. Resolves { name, how, candidates }. */
function resolveSupplier(name, code, link) {
	name = String(name || "").trim();
	link = String(link || "").trim();
	if (!name) return Promise.resolve({ name: "", how: "", candidates: [] });
	var ACC = window.CS_ACC;
	return T().getList("Supplier", null, ["name", "supplier_name", "reg_number", "tax_id"], 0).catch(function () {
		return T().getList("Supplier", null, ["name", "supplier_name"], 0);
	}).then(function (rows) {
		var lower = name.toLowerCase();
		/* the Supplier the employee picked with "Use this" (it exists on the live server; take it if the test server has it too) */
		if (link) {
			var ll = link.toLowerCase();
			for (var j = 0; j < rows.length; j++) {
				if (String(rows[j].name).toLowerCase() === ll || String(rows[j].supplier_name || "").toLowerCase() === ll) {
					return { name: rows[j].name, how: "chosen by you", candidates: [] };
				}
			}
		}
		for (var i = 0; i < rows.length; i++) {
			if (String(rows[i].supplier_name || "").toLowerCase() === lower || String(rows[i].name).toLowerCase() === lower) {
				return { name: rows[i].name, how: "same name", candidates: [] };
			}
		}
		var ns = ACC._internals.nameScore;
		var scored = rows.map(function (s) { return ns(name, code, s); })
			.filter(function (r) { return r.score >= 0.55; })
			.sort(function (a, b) { return b.score - a.score; }).slice(0, 5);
		var sure = ACC.confidentSupplier(scored);
		var hit = sure ? scored.filter(function (r) { return r.supplier.name === sure; })[0] : null;
		return {
			name: sure || "",
			how: hit ? (hit.codeMatch ? "same registration / tax ID" : "same name apart from spelling or legal form") : "",
			candidates: scored.map(function (r) { return { name: r.supplier.name, score: Math.round(r.score * 100), codeMatch: r.codeMatch }; })
		};
	});
}

/* --------------------------------------------------------- new Items */

function itemDoc(code, name, description) {
	var c = cfg();
	var d = {
		item_code: code,
		item_name: String(name || code).slice(0, 140),
		description: description || name || code,
		item_group: c.itemGroup,
		stock_uom: c.stockUom,
		is_purchase_item: 1,
		/* the code as printed is kept even when this ERPNext names items by series */
		original_item_code: code
	};
	return d;
}

/* Creates the Items the review screen marked "create new" (once per code) and resolves a map
   code-as-typed -> the real Item name. Rejects with the reason for the first Item ERPNext refuses. */
function ensureItems(lines, notes) {
	var c = cfg();
	var made = {}, order = [];
	lines.forEach(function (l) {
		if (l.decision && l.decision.mode === "create") {
			var code = String(l.decision.newCode || "").trim();
			if (code && !made[code]) { made[code] = { name: l.decision.newName || l.description, description: l.description }; order.push(code); }
		}
	});
	if (order.length && !c.itemGroup) {
		return Promise.reject(new Error("New items need an Item Group: set “Item group for new items” in Settings."));
	}
	var result = {};
	return order.reduce(function (chain, code) {
		return chain.then(function () {
			return T().fetchDoc("Item", code).then(function (there) {
				if (there) { result[code] = { name: there.name, created: false }; return; }
				return T().clean("Item", itemDoc(code, made[code].name, made[code].description), notes).then(function (cl) {
					return T().createDoc("Item", cl.doc, notes).then(function (name) {
						result[code] = { name: name, created: true };
					});
				});
			}).catch(function (e) {
				var err = new Error("The new item “" + code + "” could not be created: " + errText(e));
				err.errors = e && e.errors;
				throw err;
			});
		});
	}, Promise.resolve()).then(function () { forgetItems(); return result; });
}

/* ------------------------------------------------- exchange rate, company */

function companyInfo() {
	var c = cfg();
	var q = c.company
		? T().getList("Company", [["name", "=", c.company]], ["name", "default_currency"], 1)
		: T().getList("Company", null, ["name", "default_currency"], 2);
	return q.then(function (rows) {
		if (rows.length === 1) return { name: rows[0].name, currency: rows[0].default_currency || "" };
		return { name: c.company, currency: "" };
	}, function () { return { name: c.company, currency: "" }; });
}

function exchangeRate(from, to, date) {
	if (!from || !to || from === to) return Promise.resolve(null);
	return T().callMethod("erpnext.setup.utils.get_exchange_rate", { from_currency: from, to_currency: to, transaction_date: date })
		.then(function (r) { return num(r); }, function () { return null; });
}

/* ------------------------------------------- taxes and charges (Purchase Taxes and Charges) */

/* What the document prints besides its item lines — VAT per rate, shipping, handling, insurance, duties, discounts,
   other fees — becomes the rows of the document's "Purchase Taxes and Charges" table: charge type "Actual" with the
   printed amount, so ERPNext's total equals the document's. A discount (or any negative amount) is a "Deduct" row. */
var CHARGE_KINDS = ["vat", "shipping", "handling", "insurance", "duty", "discount", "other"];
var CHARGE_LABELS = { vat: "VAT", shipping: "Shipping", handling: "Handling", insurance: "Insurance", duty: "Customs duty", discount: "Discount", other: "Other charge" };

/* one charge as read by the AI or typed in the review list */
function normalizeCharge(c) {
	c = c || {};
	var kind = String(c.kind || "").toLowerCase().trim();
	if (CHARGE_KINDS.indexOf(kind) < 0) kind = "other";
	var amount = num(c.amount != null ? c.amount : c.tax_amount);
	if (amount !== null && kind === "discount" && amount > 0) amount = -amount;
	return {
		kind: kind,
		description: String(c.description || "").replace(/\s+/g, " ").trim(),
		rate: num(c.rate),
		amount: amount === null ? null : round(amount, 2)
	};
}

/* the charges that have an amount (a row with no amount, or 0, is dropped) */
function normalizeCharges(list) {
	return (Array.isArray(list) ? list : []).map(normalizeCharge).filter(function (c) { return c.amount !== null && c.amount !== 0; });
}

function chargesSum(charges) {
	return round((charges || []).reduce(function (t, c) { return t + (c.amount || 0); }, 0), 2);
}

function linesSum(lines) {
	return round((lines || []).reduce(function (t, l) {
		var a = l.qty > 0 && l.rate !== null && l.rate !== undefined ? l.qty * l.rate : (l.amount || 0);
		return t + (isFinite(a) ? a : 0);
	}, 0), 2);
}

/* Do lines + charges add up to the document's total? { lines, charges, sum, total, diff, ok }; ok is null when no total is known */
function totalCheck(lines, charges, total) {
	var l = linesSum(lines), c = chargesSum(charges), sum = round(l + c, 2);
	var t = total === undefined || total === null || total === "" ? null : num(total);
	var diff = t === null ? null : round(sum - t, 2);
	return { lines: l, charges: c, sum: sum, total: t, diff: diff, ok: diff === null ? null : Math.abs(diff) <= 0.02 };
}

var KIND_WORDS = {
	vat: /vat|pvm|mwst|tax/i,
	shipping: /freight|shipping|transport|deliver|carriage|courier|postage|pervež|siunt|vežim|fracht|versand/i,
	handling: /handling|packag|pakav|apdorojim|bearbeit/i,
	insurance: /insur|draud|versicher/i,
	duty: /duty|duties|customs|muit|zoll/i
};

var accountCache = {};

/* The company's accounts and the rows of the configured tax template, read once per company. */
function accountInfo(company) {
	var c = cfg(), key = company + "\u0000" + c.taxes;
	if (accountCache[key]) return accountCache[key];
	var filters = [["is_group", "=", 0]];
	if (company) filters.push(["company", "=", company]);
	var accounts = T().getList("Account", filters, ["name", "account_type", "root_type"], 0).catch(function () { return []; });
	var tpl = c.taxes
		? T().fetchDoc("Purchase Taxes and Charges Template", c.taxes).then(function (d) { return (d && d.taxes) || []; }, function () { return []; })
		: Promise.resolve([]);
	var p = Promise.all([accounts, tpl]).then(function (r) { return { accounts: r[0] || [], template: r[1] || [] }; });
	accountCache[key] = p;
	return p;
}

function forgetAccounts() { accountCache = {}; }

/* The Account for a charge: the one set in Settings; else the row of the tax template that looks like it; else an
   account of the company whose name says so. "" when nothing fits (the row is then left out, with a note). */
function chargeAccount(kind, info) {
	var c = cfg();
	var set = kind === "vat" ? c.vatAccount
		: (kind === "shipping" || kind === "handling") ? (c.shippingAccount || c.otherAccount)
		: (c.otherAccount || c.shippingAccount);
	if (set) return set;
	var words = KIND_WORDS[kind];
	if (!words) return "";
	var tpl = info.template || [], i;
	if (kind === "vat") {
		for (i = 0; i < tpl.length; i++) if (num(tpl[i].rate) > 0 && tpl[i].account_head) return tpl[i].account_head;
	}
	for (i = 0; i < tpl.length; i++) if (tpl[i].account_head && words.test(tpl[i].account_head)) return tpl[i].account_head;
	var acc = (info.accounts || []).filter(function (a) { return words.test(a.name) && a.root_type !== "Income" && a.root_type !== "Equity"; });
	if (kind === "vat") {
		var tax = acc.filter(function (a) { return a.account_type === "Tax"; });
		if (tax.length) acc = tax;
		var input = acc.filter(function (a) { return /input|pirk|receiv|ties|vorsteuer/i.test(a.name); });
		if (input.length) acc = input;
	}
	return acc.length ? acc[0].name : "";
}

/* The rows for the "taxes" table. Charges with no account are left out and reported in `notes`. Resolves [rows]. */
function taxRows(charges, company, notes) {
	charges = normalizeCharges(charges);
	if (!charges.length) return Promise.resolve([]);
	var c = cfg();
	return accountInfo(company).then(function (info) {
		var rows = [];
		charges.forEach(function (ch) {
			var acct = chargeAccount(ch.kind, info);
			var label = ch.description || CHARGE_LABELS[ch.kind];
			if (!acct) {
				notes.push({ field: "taxes", message: "No account for “" + label + "” (" + ch.amount + ") — set the " +
					(ch.kind === "vat" ? "VAT account" : "shipping / other charges account") + " in Settings (test server). This row was left out." });
				return;
			}
			if (ch.kind === "vat" && ch.rate && label.indexOf("%") < 0) label += " " + ch.rate + "%";
			var row = {
				category: ch.kind === "vat" ? "Total" : c.chargeCategory,
				add_deduct_tax: ch.amount < 0 ? "Deduct" : "Add",
				charge_type: "Actual",
				account_head: acct,
				description: label,
				tax_amount: Math.abs(ch.amount)
			};
			if (c.costCenter) row.cost_center = c.costCenter;
			rows.push(row);
		});
		return rows;
	});
}

/* ------------------------------------------------ Purchase Invoice */

function today() { return new Date().toISOString().slice(0, 10); }

function itemRows(lines, extra) {
	return lines.map(function (l) {
		var row = {
			item_code: l.finalName,
			description: l.description || undefined,
			qty: l.qty,
			rate: l.rate
		};
		if (l.finalUom) { row.uom = l.finalUom; row.stock_uom = l.finalUom; row.conversion_factor = 1; }
		if (l.po) { row.purchase_order = l.po.po; row.po_detail = l.po.detail; }
		if (extra) extra(row, l);
		Object.keys(row).forEach(function (k) { if (row[k] === undefined) delete row[k]; });
		return row;
	});
}

function checkLines(lines) {
	if (!lines.length) return "There are no item lines. Add the lines of the document first.";
	for (var i = 0; i < lines.length; i++) {
		var l = lines[i], n = i + 1;
		if (!(l.qty > 0)) return "Line " + n + ": enter the quantity.";
		if (l.rate === null || l.rate === undefined || !isFinite(l.rate)) return "Line " + n + ": enter the unit price.";
		if (!finalCode(l)) return "Line " + n + ": choose an existing item or enter a code for the new one.";
	}
	return "";
}

function applyFinal(lines, made) {
	var byName = {};
	((cache.items) || []).forEach(function (it) { byName[it.name] = it.uom; });
	lines.forEach(function (l) {
		if (l.decision.mode === "create") {
			l.finalName = (made[String(l.decision.newCode || "").trim()] || {}).name;
			l.finalUom = cfg().stockUom;
		} else {
			l.finalName = String(l.decision.itemCode || "").trim();
			l.finalUom = byName[l.finalName] || "";
		}
	});
}

/* fields: { documentNo, documentDate, paymentDueDate, supplierName, supplierCode, currency, totalAmount, trackingNumber }
   lines: reviewed lines (matchLine / the review screen). charges: the VAT / shipping / other rows (see taxRows).
   file: { dataUrl, name }.
   Resolves { name, notes, file, created: [item names], note } */
function createPurchaseInvoice(fields, lines, file, charges) {
	var notes = [];
	var bad = checkLines(lines);
	if (bad) return Promise.reject(new Error(bad));
	var c = cfg();
	var supplier, made, comp;
	return resolveSupplier(fields.supplierName, fields.supplierCode, fields.supplierLink).then(function (s) {
		if (!s.name) {
			throw new Error("The test server has no Supplier like “" + fields.supplierName + "”. Add it there first " +
				(s.candidates.length ? "(closest: " + s.candidates[0].name + " — " + s.candidates[0].score + " %)." : "."));
		}
		supplier = s.name;
		return ensureItems(lines, notes);
	}).then(function (m) {
		made = m;
		applyFinal(lines, made);
		return companyInfo();
	}).then(function (ci) {
		comp = ci;
		var posting = fields.documentDate || today();
		return exchangeRate(fields.currency, ci.currency, posting).then(function (rate) {
			return Promise.all([
				resolveField("Purchase Invoice", ["tracking_awb"], "tracking_awb_no"),
				resolveField("Purchase Invoice", ["scanned_invoice"], "scanned_invoice"),
				taxRows(charges, ci.name, notes),
				fields.reviewNote ? resolveField("Purchase Invoice", ["remarks"], "remarks") : Promise.resolve("")
			]).then(function (names) {
				var taxes = names[2];
				var doc = {
					supplier: supplier,
					bill_no: fields.documentNo,
					bill_date: fields.documentDate,
					posting_date: posting,
					set_posting_time: 1,
					currency: fields.currency || undefined,
					conversion_rate: rate || undefined,
					company: ci.name || undefined,
					taxes_and_charges: taxes.length ? undefined : (c.taxes || undefined),
					taxes: taxes.length ? taxes : undefined,
					items: itemRows(lines)
				};
				if (fields.paymentDueDate && fields.paymentDueDate >= posting) doc.due_date = fields.paymentDueDate;
				if (fields.trackingNumber && names[0]) doc[names[0]] = fields.trackingNumber;
				if (fields.reviewNote && names[3]) doc[names[3]] = fields.reviewNote;
				return T().clean("Purchase Invoice", doc, notes).then(function (cl) {
					return T().createDoc("Purchase Invoice", cl.doc, notes).then(function (name) {
						var out = { name: name, notes: notes, created: [], supplier: supplier };
						Object.keys(made).forEach(function (k) { if (made[k].created) out.created.push(made[k].name); });
						var attach = file && file.dataUrl
							? T().attachFile("Purchase Invoice", name, file.dataUrl, file.name, names[1] || undefined)
							: Promise.resolve({ state: "off" });
						return attach.then(function (fr) {
							out.file = fr;
							if (!names[1]) notes.push({ field: "", message: "This server has no “Scanned Invoice” field on the Purchase Invoice; the file is attached to it only." });
							return T().fetchDoc("Purchase Invoice", name).then(function (d) {
								var tot = fields.totalAmount === undefined || fields.totalAmount === null ? null : num(fields.totalAmount);
								if (d && tot !== null && isFinite(tot)) {
									var gt = num(d.grand_total);
									if (gt !== null && Math.abs(gt - tot) > 0.02) {
										out.note = "ERPNext total " + gt + " differs from the document's " + tot + " — check the taxes before submitting.";
									}
								}
								return out;
							}, function () { return out; });
						});
					});
				});
			});
		});
	});
}

/* ------------------------------------------------ Supplier Quotation */

/* The Supplier Quotation's naming series ("SQTN-", not the server's first/default one) and its validity field ("valid_till").
   The server's field list is read afresh each time, so a field or series added meanwhile is used at once.
   Resolves { series, validField, notes: [message] }. */
var QUOTATION_SERIES = "SQTN-";
function quotationSetup() {
	if (T().forgetMeta) T().forgetMeta("Supplier Quotation");
	Object.keys(fieldCache).forEach(function (k) { if (k.indexOf("Supplier Quotation\u0000") === 0) delete fieldCache[k]; });
	return T().describe("Supplier Quotation").then(function (m) {
		var out = { series: "", validField: "valid_till", notes: [] };
		if (!m || !m.fields) { out.series = QUOTATION_SERIES; return out; }   /* field list unreadable: send the wanted series as is */
		var f = m.fields;
		var vf = ["valid_till", "valid_upto", "valid_until"].filter(function (n) { return f[n]; })[0];
		if (vf) out.validField = vf;
		else if (m.complete) {
			out.validField = "";
			out.notes.push("This server's Supplier Quotation has no valid_till field, so the validity date was not saved.");
		}
		var ns = f.naming_series;
		if (!ns) { out.series = m.complete ? "" : QUOTATION_SERIES; return out; }
		var opts = String(ns.options || "").split("\n").map(function (o) { return o.trim(); }).filter(Boolean);
		if (!opts.length) { out.series = QUOTATION_SERIES; return out; }
		var pick = opts.filter(function (o) { return o === QUOTATION_SERIES; })[0] ||
			opts.filter(function (o) { return /SQTN/i.test(o); })[0] || "";
		out.series = pick;
		if (!pick) out.notes.push("This server has no \u201cSQTN-\u201d naming series for Supplier Quotations (it offers " + opts.join(", ") + "), so its default was used.");
		return out;
	});
}

/* fields: { documentNo (the supplier's quotation number), documentDate, supplierName, supplierCode, currency, validUntil }.
   Several lines of the same item (quantity price breaks) become several rows, each with its quantity and price. */
function createSupplierQuotation(fields, lines, file, charges) {
	var notes = [];
	var bad = checkLines(lines);
	if (bad) return Promise.reject(new Error(bad));
	var c = cfg();
	var supplier, made, setup;
	return resolveSupplier(fields.supplierName, fields.supplierCode, fields.supplierLink).then(function (s) {
		if (!s.name) {
			throw new Error("The test server has no Supplier like “" + fields.supplierName + "”. Add it there first " +
				(s.candidates.length ? "(closest: " + s.candidates[0].name + " — " + s.candidates[0].score + " %)." : "."));
		}
		supplier = s.name;
		return quotationSetup();
	}).then(function (su) {
		setup = su;
		su.notes.forEach(function (m) { notes.push({ field: "", message: m }); });
		return ensureItems(lines, notes);
	}).then(function (m) {
		made = m;
		applyFinal(lines, made);
		return companyInfo();
	}).then(function (ci) {
		var date = fields.documentDate || today();
		return Promise.all([exchangeRate(fields.currency, ci.currency, date), taxRows(charges, ci.name, notes),
			fields.reviewNote ? resolveField("Supplier Quotation", ["remarks", "comment"], "") : Promise.resolve("")]).then(function (rt) {
			var rate = rt[0], taxes = rt[1];
			var doc = {
				naming_series: setup.series || undefined,
				supplier: supplier,
				transaction_date: date,
				quotation_no: fields.documentNo || undefined,
				currency: fields.currency || undefined,
				conversion_rate: rate || undefined,
				company: ci.name || undefined,
				taxes_and_charges: taxes.length ? undefined : (c.taxes || undefined),
				taxes: taxes.length ? taxes : undefined,
				items: itemRows(lines, function (row, l) { if (l.code) row.supplier_part_no = l.code; })
			};
			if (fields.validUntil && setup.validField) doc[setup.validField] = fields.validUntil;
			if (fields.reviewNote) {
				if (rt[2]) doc[rt[2]] = fields.reviewNote;
				else notes.push({ field: "", message: "The Supplier Quotation has no remarks field on this server, so the review note was not saved with it (it is in the upload history)." });
			}
			return T().clean("Supplier Quotation", doc, notes).then(function (cl) {
				return T().createDoc("Supplier Quotation", cl.doc, notes).then(function (name) {
					var out = { name: name, notes: notes, created: [], supplier: supplier };
					Object.keys(made).forEach(function (k) { if (made[k].created) out.created.push(made[k].name); });
					var attach = file && file.dataUrl
						? T().attachFile("Supplier Quotation", name, file.dataUrl, file.name)
						: Promise.resolve({ state: "off" });
					return attach.then(function (fr) { out.file = fr; return out; });
				});
			});
		});
	});
}

/* ------------------------------------------------- waybill → Receipt */

function digits(s) { return String(s || "").replace(/\D/g, ""); }

/* Purchase Orders whose AWB field holds this tracking number (submitted ones first), and the Purchase Receipts that
   already carry it. Resolves { orders: [{name, supplier, date, status, perReceived, submitted}], receipts: [names] } */
function findByAwb(awb) {
	var key = digits(awb) || String(awb || "").trim();
	if (!key) return Promise.resolve({ orders: [], receipts: [] });
	var tail = key.slice(-6);
	return Promise.all([
		resolveField("Purchase Order", ["tracking_awb"], "tracking_awb_no"),
		resolveField("Purchase Receipt", ["tracking_awb"], "tracking_awb_no")
	]).then(function (f) {
		var po = f[0] ? T().getList("Purchase Order", [[f[0], "like", "%" + tail + "%"], ["docstatus", "<", 2]],
			["name", "supplier", "transaction_date", "status", "per_received", "docstatus", f[0]], 0) : Promise.resolve([]);
		var pr = f[1] ? T().getList("Purchase Receipt", [[f[1], "like", "%" + tail + "%"], ["docstatus", "<", 2]],
			["name", "supplier", f[1]], 0) : Promise.resolve([]);
		return Promise.all([po, pr]).then(function (r) {
			function holds(row, field) { return digits(row[field]).indexOf(digits(key)) >= 0 || String(row[field] || "").indexOf(key) >= 0; }
			return {
				orders: r[0].filter(function (x) { return holds(x, f[0]); }).map(function (x) {
					return { name: x.name, supplier: x.supplier, date: x.transaction_date, status: x.status,
						perReceived: num(x.per_received) || 0, submitted: x.docstatus === 1 };
				}),
				receipts: r[1].filter(function (x) { return holds(x, f[1]); }).map(function (x) { return x.name; })
			};
		});
	});
}

/* A Purchase Order the employee names by hand (or one found by AWB), checked and summarised. */
function describeOrder(name) {
	return T().fetchDoc("Purchase Order", name).then(function (d) {
		if (!d) return null;
		return { name: d.name, supplier: d.supplier, date: d.transaction_date, status: d.status,
			perReceived: num(d.per_received) || 0, submitted: d.docstatus === 1 };
	});
}

function stripLocal(v) {
	if (Array.isArray(v)) return v.map(stripLocal);
	if (v && typeof v === "object") {
		var o = {};
		Object.keys(v).forEach(function (k) { if (k.indexOf("__") !== 0) o[k] = stripLocal(v[k]); });
		return o;
	}
	return v;
}

/* One Purchase Receipt per order, made with ERPNext's own "Create > Purchase Receipt" (so every line, the quantities
   still open and the links back to the order come out exactly as when it is done by hand), the AWB written in, and the
   waybill attached. Draft, not submitted. Resolves [{ order, name, file, notes, error }] — one failure does not stop
   the others. */
function createReceipts(orders, awb, file, remark) {
	var out = [];
	return orders.reduce(function (chain, order) {
		return chain.then(function () {
			var notes = [];
			var item = { order: order, notes: notes };
			return T().callMethod("erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_receipt", { source_name: order })
				.then(function (doc) {
					if (!doc || typeof doc !== "object") throw new Error("ERPNext did not return a receipt for " + order + ".");
					doc = stripLocal(doc);
					delete doc.name; delete doc.creation; delete doc.modified; delete doc.owner; delete doc.modified_by;
					doc.docstatus = 0;
					return Promise.all([resolveField("Purchase Receipt", ["tracking_awb"], "tracking_awb_no"),
						remark ? resolveField("Purchase Receipt", ["remarks"], "remarks") : Promise.resolve("")]).then(function (fs) {
						if (awb && fs[0]) doc[fs[0]] = awb;
						if (remark && fs[1]) doc[fs[1]] = doc[fs[1]] ? doc[fs[1]] + "\n" + remark : remark;
						return T().createDoc("Purchase Receipt", doc, notes);
					});
				}).then(function (name) {
					item.name = name;
					return file && file.dataUrl ? T().attachFile("Purchase Receipt", name, file.dataUrl, file.name) : { state: "off" };
				}).then(function (fr) { item.file = fr; out.push(item); }, function (e) {
					item.error = errText(e); out.push(item);
				});
		});
	}, Promise.resolve()).then(function () { return out; });
}

/* Attaches the waybill to Purchase Receipts that already exist for this AWB (nothing new is created). */
function attachToReceipts(names, file) {
	return Promise.all(names.map(function (n) {
		return T().attachFile("Purchase Receipt", n, file.dataUrl, file.name).then(function (fr) { return { name: n, file: fr }; });
	}));
}

/* A quick check that the test server answers and can read what the new flow needs. */
function testServer() {
	return T().getList("Item", null, ["name"], 1).then(function () {
		return T().getList("Purchase Invoice", null, ["name"], 1);
	}).then(function () { return T().getList("Supplier Quotation", null, ["name"], 1); });
}

return {
	useServer: useServer, cfg: cfg,
	similarity: similarity, levelOf: levelOf, candidatesFor: candidatesFor,
	loadItems: loadItems, forgetItems: forgetItems, normalizeLine: normalizeLine,
	matchLine: matchLine, matchLines: matchLines, finalCode: finalCode,
	loadPurchaseOrders: loadPurchaseOrders, annotatePo: annotatePo,
	resolveField: resolveField, resolveSupplier: resolveSupplier, ensureItems: ensureItems,
	checkLines: checkLines, createPurchaseInvoice: createPurchaseInvoice,
	createSupplierQuotation: createSupplierQuotation,
	findByAwb: findByAwb, describeOrder: describeOrder, createReceipts: createReceipts,
	attachToReceipts: attachToReceipts, testServer: testServer, errText: errText,
	CHARGE_KINDS: CHARGE_KINDS, CHARGE_LABELS: CHARGE_LABELS, normalizeCharge: normalizeCharge, normalizeCharges: normalizeCharges,
	chargesSum: chargesSum, linesSum: linesSum, totalCheck: totalCheck, taxRows: taxRows, forgetAccounts: forgetAccounts,
	_internals: { lev: lev, squash: squash, num: num, itemRows: itemRows, stripLocal: stripLocal, applyFinal: applyFinal }
};
})();
