/* test_accdoc_matching.js — unit tests for the pure matching/scoring logic in
   accdoc.js (supplier fuzzy-match, parent-document date scoring). No DOM, no
   network: stubs `window` just enough to load the module and exercises its
   _internals directly, so this runs under plain Node with no browser/mock
   ERPNext needed. Run with: node test_accdoc_matching.js */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var file = process.argv[2] ||
	path.join(__dirname, "../android/CardScanner/app/src/main/assets/accdoc.js");
var src = fs.readFileSync(file, "utf8");

var sandbox = { window: {}, console: console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: file });

var ACC = sandbox.window.CS_ACC;
if (!ACC) throw new Error("window.CS_ACC was not defined by " + file);

var failures = 0, passed = 0;

function check(label, cond) {
	if (cond) { passed++; }
	else { failures++; console.log("FAIL: " + label); }
}

function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 0.001); }

/* --- normalizeName: legal-form suffixes and punctuation shouldn't matter --- */
check("normalizeName strips UAB prefix",
	ACC.normalizeName("UAB Šviesa") === ACC.normalizeName("Šviesa"));
check("normalizeName strips trailing UAB + comma",
	ACC.normalizeName("Šviesa, UAB") === ACC.normalizeName("UAB Šviesa"));
check("normalizeName is case-insensitive",
	ACC.normalizeName("Acme Ltd") === ACC.normalizeName("ACME LTD"));

/* --- diceCoefficient: identical vs near vs unrelated --- */
check("diceCoefficient identical strings = 1",
	ACC.diceCoefficient("acme optics", "acme optics") === 1);
check("diceCoefficient near-identical strings scores high",
	ACC.diceCoefficient("integrated optics", "integratd optics") > 0.85);
check("diceCoefficient unrelated strings scores low",
	ACC.diceCoefficient("integrated optics", "north sea shipping") < 0.3);

/* --- nameScore: a shared code floors the score even with a rough name --- */
var nameScore = ACC._internals.nameScore;

var sameCodeDifferentSpelling = nameScore(
	"Integrated Optics", "LT123456789",
	{ supplier_name: "UAB Integruota Optika", supplier_code: "LT123456789" });
check("nameScore: matching code floors score >= 0.97 despite differing name",
	sameCodeDifferentSpelling.score >= 0.97 && sameCodeDifferentSpelling.codeMatch);

var closeNameNoCode = nameScore(
	"Integrated Optics UAB", null,
	{ supplier_name: "Integrated Optics", supplier_code: "" });
check("nameScore: close name alone scores high without a code",
	closeNameNoCode.score > 0.8 && !closeNameNoCode.codeMatch);

var unrelated = nameScore(
	"Integrated Optics", "LT123456789",
	{ supplier_name: "Northern Freight Ltd", supplier_code: "DE999999999" });
check("nameScore: different name AND different code scores low",
	unrelated.score < 0.3 && !unrelated.codeMatch);

/* --- daysBetween: used to weight parent-document date proximity --- */
var daysBetween = ACC._internals.daysBetween;
check("daysBetween same day = 0",
	daysBetween("2026-09-01", "2026-09-01") === 0);
check("daysBetween 10 days apart = 10",
	approx(daysBetween("2026-09-01", "2026-09-11"), 10));
check("daysBetween invalid dates falls back to a large number (never matches)",
	daysBetween("not-a-date", "2026-09-01") > 1000);

/* --- sectionPatch: the received-flag and field names line up per section --- */
var mainPatch = ACC.sectionPatch("main", {
	documentNo: "INV-1", documentDate: "2026-09-01",
	supplierName: "Acme", supplierCode: "LT1"
});
check("sectionPatch(main) sets purchase_invoice_received",
	mainPatch.purchase_invoice_received === 1);
check("sectionPatch(main) maps supplier fields onto supplier/supplier_code",
	mainPatch.supplier === "Acme" && mainPatch.supplier_code === "LT1");

var cdPatch = ACC.sectionPatch("cd", {
	documentNo: "CD-1", documentDate: "2026-09-02",
	supplierName: "Customs Agency", supplierCode: "LT2"
});
check("sectionPatch(cd) sets customs_declaration_cd_received",
	cdPatch.customs_declaration_cd_received === 1);
check("sectionPatch(cd) writes to cd_supplier, not supplier",
	cdPatch.cd_supplier === "Customs Agency" && !("supplier" in cdPatch));

console.log("\n" + passed + " passed, " + failures + " failed");
process.exit(failures ? 1 : 0);
