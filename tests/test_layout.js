/* test_layout.js — pdfview.layoutText: side-by-side seller / buyer columns are read column by column.
   Fixture: the pdf.js text items ([string, x, y, width]) of a real Lithuanian invoice (Nano Vita -> us)
   whose "Tiekėjas:" (seller) and "Pirkėjas:" (buyer) blocks are printed side by side. Private repo only. */
"use strict";
var fs = require("fs"), path = require("path");
global.window = global;
var A = path.join(__dirname, "../android/CardScanner/app/src/main/assets/");
require(A + "pdfview.js"); require(A + "docrules.js");
var fails = 0;
function check(l, c, x) { if (!c) fails++; console.log((c ? "ok   " : "FAIL ") + l + (c ? "" : "   " + (x || ""))); }
function items(file) { return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8")).map(function (a) { return { str: a[0], transform: [1, 0, 0, 1, a[1], a[2]], width: a[3] }; }); }
function n(s) { return s.replace(/\s+/g, " "); }

var flat = fs.readFileSync(path.join(__dirname, "fixtures/purchase-nanovita.flat.pdfjs.txt"), "utf8");
var text = n(window.CS_PDF.layoutText(items("purchase-nanovita.items.json")));
check("flat pdf.js text puts the buyer label right before the seller's name (the trap)", /Pirkėjas:\s+UAB "Nano Vita"/.test(flat));
check("after the fix each label stands before its own column", /Tiekėjas: UAB "Nano Vita"/.test(text) && /Pirkėjas: UAB "Integrated optics"/.test(text), text.slice(0, 600));
check("the seller's column comes whole, then the buyer's", text.indexOf("Sąskaitos Nr.: LT12 7044 0600 0654 2338 Pirkėjas:") > 0 && /Pirkėjas: UAB "Integrated optics" Adresas: Trinapolio g\. 11 Vilnius 08338 Lithuania Kodas: 302833442 PVM mok\. kodas LT100007179012/.test(text), text.slice(0, 700));
check("the item table keeps its row order", /1 Ultrasonic baths, SONOREX SUPER Analogous high power ultrasonic bath, with timer and heater, SUPER RK 514 H 207 1 2280\.00 2758\.80 2280\.00/.test(text), text);
check("label: amount pairs drawn far apart are put together", /Viso \(be PVM\): 2726\.00/.test(text) && /PVM \(21%\): 572\.46/.test(text) && /Viso \(su PVM\): 3,298\.46 €/.test(text), text);
check("nothing is lost or duplicated", ["Tiekėjas:", "Pirkėjas:", "Paulius Čyvas", "info@nanovita.lt"].every(function (w) { return text.split(w).length === 2; }));
check("a document without side-by-side blocks comes out exactly as pdf.js ordered it",
	window.CS_PDF.layoutText([{ str: "Hello", transform: [1, 0, 0, 1, 10, 100], width: 25 }, { str: " ", transform: [1, 0, 0, 1, 35, 100], width: 3 }, { str: "world", transform: [1, 0, 0, 1, 38, 100], width: 25 }]) === "Hello   world");

var r = window.CS_RULES.parse(text, "purchase_invoice");
check("built-in reader: supplier is Nano Vita, not us", r.supplier_name === "UAB Nano Vita" && r.issuer_is_ours === false, JSON.stringify(r));
check("built-in reader: supplier codes", r.supplier_reg_number === "301920531" && r.supplier_tax_id === "LT100004513210");
check("built-in reader: number, date, total", r.document_no === "2333" && r.document_date === "2026-09-07" && r.total_amount === 3298.46 && r.currency === "EUR", JSON.stringify(r));
var rf = window.CS_RULES.parse(flat, "purchase_invoice");
check("(on the flat text the reader was wrong — why the order matters)", rf.supplier_name !== "UAB Nano Vita");


/* a second two-column header: "Pirkėjas:" | "Pardavėjas:" with the companies indented under their labels (Skubios siuntos -> us) */
var sk = n(window.CS_PDF.layoutText(items("cd-invoice-skubios.items.json")));
check("indented columns: each label stands before its own company", /Pirkėjas: UAB INTEGRATED OPTICS/.test(sk) && /Pardavėjas: SKUBIOS SIUNTOS, UAB/.test(sk), sk.slice(0, 400));
var rs = window.CS_RULES.parse(sk, "purchase_invoice");
check("built-in reader: supplier is Skubios siuntos (no VAT code in the name), with its own codes", rs.supplier_name === "SKUBIOS SIUNTOS, UAB" && rs.supplier_reg_number === "134678891" && rs.supplier_tax_id === "LT346788917" && rs.issuer_is_ours === false, JSON.stringify(rs));
check("built-in reader: number, date, total", rs.document_no === "MTPA261000114" && rs.document_date === "2026-10-08" && rs.total_amount === 13 && rs.currency === "EUR", JSON.stringify(rs));
var rb = window.CS_RULES.parse("Pirkėjas: UAB INTEGRATED OPTICS Į/k: 302833442 , PVM m/k: LT100007179012 SKUBIOS SIUNTOS, UAB Inovacijų g. 3 Kauno r. Į/k: 134678891, PVM m/k: LT346788917 Pardavėjas:", "purchase_invoice");
check("a VAT code that precedes the name is not part of it", !/LT100007179012/.test(rb.supplier_name || ""), JSON.stringify(rb.supplier_name));

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
