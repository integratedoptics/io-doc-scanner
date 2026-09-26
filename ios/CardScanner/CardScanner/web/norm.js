/* norm.js — turns what the OCR read into what ERPNext will accept.

   Three jobs:
     normCountry   a printed country name, in any language or as a code, becomes
                   the exact Territory spelling used in the ERPNext instance
     normRegion    a subdivision abbreviation becomes its full name, but only
                   when the country agrees, so "CA" on a Canadian card is never
                   turned into California
     normPhone     a local number gains its international calling code

   Every function returns { value, ok, note }:
     ok    true when the result can be trusted
     note  a short human sentence when it cannot, shown next to the field so the
           person fixes it by hand instead of the app guessing

   Nothing here touches the network. */
window.CS_NORM = (function () {
"use strict";

var G = window.CS_GEO;

/* ------------------------------------------------------------------ helpers */

/* Lower case, strip accents, collapse punctuation and spacing, so "Österreich",
   "OESTERREICH" and "osterreich" all land on the same key. */
function key(s) {
	if (!s) return "";
	var t = String(s).normalize ? String(s).normalize("NFD") : String(s);
	t = t.replace(/[\u0300-\u036f]/g, "");        // combining accents
	t = t.replace(/ß/g, "ss").replace(/ø/gi, "o").replace(/æ/gi, "ae")
	     .replace(/đ/gi, "d").replace(/ł/gi, "l").replace(/[’']/g, "");
	t = t.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
	return t;
}

function res(value, ok, note) { return { value: value, ok: ok !== false, note: note || "" }; }

/* ------------------------------------------------------------------ country */

/* Live lists fetched from the instance override the bundled ones once the app
   has talked to ERPNext, so a territory added in ERPNext works without a new
   build. See CS_ERP.refreshVocabulary(). */
var live = { territories: null, countries: null };

function setLive(territories, countries) {
	live.territories = (territories && territories.length) ? territories.slice() : null;
	live.countries = (countries && countries.length) ? countries.slice() : null;
}

function territoryList() { return live.territories || G.COUNTRIES; }

/* The Country doctype in ERPNext is a separate list from Territory and it
   spells things properly. When the app has that list, an exact-or-close match
   is used for the Address country field; otherwise the territory name is
   reused, which is right for all but the three odd spellings. */
function countryFieldValue(territory) {
	if (!territory) return "";
	if (!live.countries) {
		return G.SUSPECT[territory] || territory;
	}
	var want = key(G.SUSPECT[territory] || territory);
	for (var i = 0; i < live.countries.length; i++) {
		if (key(live.countries[i]) === want) return live.countries[i];
	}
	// fall back to the territory spelling; the sync will report it if rejected
	return G.SUSPECT[territory] || territory;
}

/* text -> exact territory name */
/* The alias table is baked from the Territory.xlsx that was supplied, typos and
   all. Once the real instance has been read, its own spelling wins: if it lists
   "United States" the app must not keep sending "United Sates", and the other way
   round, because a Link field only accepts an exact match. */
/* The baked tables (calling codes, digit counts, region lists) are keyed by the
   names in the supplied Territory.xlsx. A live instance may spell a country
   differently, so map back to the baked key before any table lookup. */
function toBaked(name) {
	if (!name) return name;
	if (G.CALLING[name] || G.REGIONS[name] || G.NSN_LEN[name]) return name;
	var k = key(name), fixed = G.SUSPECT[name], fk = fixed ? key(fixed) : "";
	for (var n in G.SUSPECT) {
		if (key(n) === k || key(G.SUSPECT[n]) === k || (fk && key(n) === fk)) return n;
	}
	for (var i = 0; i < G.TERRITORIES.length; i++) {
		if (key(G.TERRITORIES[i]) === k) return G.TERRITORIES[i];
	}
	return name;
}

function toLive(name) {
	var list = live.territories;
	if (!name || !list) return name;
	var k = key(name), i;
	for (i = 0; i < list.length; i++) if (key(list[i]) === k) return list[i];
	var fixed = G.SUSPECT[name];
	if (fixed) {
		var fk = key(fixed);
		for (i = 0; i < list.length; i++) if (key(list[i]) === fk) return list[i];
	}
	for (i = 0; i < list.length; i++) {
		var c = G.SUSPECT[list[i]];
		if (c && key(c) === k) return list[i];
	}
	return name;
}

function normCountry(text) {
	var r = matchCountry(text);
	if (r.ok) r.value = toLive(r.value);
	return r;
}

function matchCountry(text) {
	var raw = String(text || "").trim();
	if (!raw) return res("", true);

	var list = territoryList();
	var k = key(raw);

	// 1. exact match against the instance's own territory names
	for (var i = 0; i < list.length; i++) {
		if (key(list[i]) === k) return res(list[i], true);
	}

	// 2. a known alias, native name or ISO code
	if (G.ALIAS[k]) return res(G.ALIAS[k], true);

	// 3. the country may be the tail of an address line: "… Vilnius, Lithuania"
	var parts = raw.split(/[,;/|]/);
	if (parts.length > 1) {
		for (var p = parts.length - 1; p >= 0; p--) {
			var sub = key(parts[p]);
			if (!sub) continue;
			if (G.ALIAS[sub]) return res(G.ALIAS[sub], true);
			for (var j = 0; j < list.length; j++) {
				if (key(list[j]) === sub) return res(list[j], true);
			}
		}
	}

	// 4. a single word inside the string, longest first so "Great Britain" wins
	//    over "Britain". Two-letter codes are skipped here: too many false hits.
	var keys = Object.keys(G.ALIAS).sort(function (a, b) { return b.length - a.length; });
	for (var m = 0; m < keys.length; m++) {
		if (keys[m].length < 4) continue;
		if (new RegExp("(^|[^a-z])" + keys[m].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
				"([^a-z]|$)").test(k)) {
			return res(G.ALIAS[keys[m]], true);
		}
	}

	// 5. give up, but keep what was printed so nothing is silently lost
	return res(raw, false,
		"“" + raw + "” is not one of your ERPNext territories — pick the right one.");
}

/* ------------------------------------------------------------------- region */

/* The region tables are keyed by the baked territory names, so they still have to
   be found when the live instance spells the country differently. */
function regionTable(territory) {
	if (!territory) return null;
	return G.REGIONS[toBaked(territory)] || null;
}

function normRegion(text, territory) {
	var raw = String(text || "").trim();
	if (!raw) return res("", true);

	var table = regionTable(territory);
	var abbr = raw.replace(/[.\s]/g, "").toUpperCase();

	if (table) {
		if (table[abbr]) return res(table[abbr], true);
		// already spelled out?
		for (var a in table) {
			if (key(table[a]) === key(raw)) return res(table[a], true);
		}
		// looks like an abbreviation but is not in this country's table
		if (/^[A-Z]{2,4}$/.test(abbr)) {
			return res(raw, false,
				"“" + raw + "” is not a known " + territory + " region — check it.");
		}
		return res(raw, true);
	}

	/* No table for this country. A short all-caps token is probably an
	   abbreviation, so say so rather than shipping "CA" to ERPNext. Without a
	   country there is nothing to resolve it against: "CA" is California,
	   Cataluña or Campania depending on where the card is from, so it is left
	   as printed and flagged instead of being guessed. */
	if (/^[A-Z]{2,4}$/.test(abbr)) {
		if (!territory) {
			var hits = [];
			for (var c in G.REGIONS) {
				if (G.REGIONS[c][abbr]) hits.push(G.REGIONS[c][abbr] + " (" + c + ")");
			}
			return res(raw, false, hits.length
				? "“" + raw + "” could be " + hits.join(", ") + " — set the country first."
				: "“" + raw + "” looks abbreviated, and there is no country to resolve it against.");
		}
		return res(raw, false, "“" + raw + "” looks abbreviated — write it out in full.");
	}
	return res(raw, true);
}

/* -------------------------------------------------------------------- phone */

/* Longest calling codes first, so +1 never shadows +1... nothing, but +7 does
   not shadow +7xx and +35 does not shadow +351. */
var CODES = (function () {
	var seen = {}, out = [];
	for (var t in G.CALLING) {
		var c = G.CALLING[t];
		if (!seen[c]) { seen[c] = [t]; out.push(c); } else { seen[c].push(t); }
	}
	out.sort(function (a, b) { return b.length - a.length; });
	return { list: out, owners: seen };
})();

function digitsOnly(s) { return String(s || "").replace(/[^\d]/g, ""); }

function lengthOk(territory, nsn) {
	var want = G.NSN_LEN[territory];
	if (!want) return true;                       // no expectation recorded
	return want.indexOf(nsn.length) >= 0;
}

function pretty(code, nsn) { return "+" + code + " " + nsn; }

/* raw number + the card's country -> +<code> <national number> */
function normPhone(text, territory) {
	territory = toBaked(territory);
	var raw = String(text || "").trim();
	if (!raw) return res("", true);

	// Strip the label a card often prints: "mob.", "tel:", "T", "Fax"
	raw = raw.replace(/^\s*(mob(ile)?|tel|phone|ph|fax|f|t|m|p)\s*[.:]*\s*/i, "").trim();

	// An extension is kept aside so it does not confuse the length check.
	var ext = "";
	var em = raw.match(/(?:\s|,|;)(?:ext|x|int)\.?\s*(\d{1,6})\s*$/i);
	if (em) { ext = em[1]; raw = raw.slice(0, em.index).trim(); }

	/* What was printed on the card, kept so that a number we cannot vouch for is
	   handed back untouched instead of being rewritten into something wrong. */
	var asPrinted = raw + (ext ? " ext. " + ext : "");

	var hasPlus = /^\s*\+/.test(raw);
	var d = digitsOnly(raw);
	if (!d) return res(raw, false, "No digits in this number.");

	// 00 is the international prefix used across most of Europe
	if (!hasPlus && /^00\d/.test(d)) { d = d.slice(2); hasPlus = true; }

	function finish(code, nsn, ok, note) {
		var v = pretty(code, nsn) + (ext ? " ext. " + ext : "");
		return res(v, ok, note);
	}

	/* Already international. */
	if (hasPlus) {
		for (var i = 0; i < CODES.list.length; i++) {
			var code = CODES.list[i];
			if (d.indexOf(code) === 0) {
				var nsn = d.slice(code.length);
				if (!nsn) return res("+" + d, false, "Only a country code, no number.");
				var owners = CODES.owners[code];
				var owner = owners.length === 1 ? owners[0] : territory;
				if (owners.length > 1 && owners.indexOf(territory) < 0) owner = null;
				if (owner && !lengthOk(owner, nsn)) {
					return res(asPrinted, false,
						"+" + code + " numbers usually have " +
						G.NSN_LEN[owner].join(" or ") + " digits, this one has " +
						nsn.length + " — check it.");
				}
				return finish(code, nsn, true);
			}
		}
		// a plus, but not a code this instance trades with
		return res("+" + d, false,
			"+" + d.slice(0, 4) + "… is not a calling code from your territory list — check it.");
	}

	/* Local number and no country to hang it on: leave it exactly as printed
	   and ask, which is what you chose over guessing. */
	if (!territory || !G.CALLING[territory]) {
		return res(asPrinted, false,
			"No country on the card, so the international code could not be added.");
	}

	var cc = G.CALLING[territory];

	/* The number may already carry its own code without a plus, e.g.
	   "370 612 34567" or "1 415 555 0132". Only believe that when dropping the
	   code leaves a plausible national number. */
	if (d.indexOf(cc) === 0) {
		var tail = d.slice(cc.length);
		if (tail && lengthOk(territory, tail)) return finish(cc, tail, true);
	}

	/* Otherwise drop the national trunk prefix and prepend the code. */
	var trunk = Object.prototype.hasOwnProperty.call(G.TRUNK, territory)
		? G.TRUNK[territory] : G.DEFAULT_TRUNK;
	var keepZero = G.KEEP_ZERO.indexOf(territory) >= 0;
	var nsn2 = d;
	if (trunk && !keepZero && nsn2.indexOf(trunk) === 0 && nsn2.length > trunk.length) {
		nsn2 = nsn2.slice(trunk.length);
	}

	/* A leading zero is how a national number is written almost everywhere, so
	   drop it even in the countries whose own trunk digit is something else
	   (Lithuania prints 8, but cards still show 0 for foreign readers). Italy and
	   the other keep-the-zero countries are left alone. */
	if (!keepZero && nsn2.charAt(0) === "0" && nsn2.length > 1 && !lengthOk(territory, nsn2)) {
		var noZero = nsn2.replace(/^0+/, "");
		if (noZero && lengthOk(territory, noZero)) nsn2 = noZero;
	}

	if (!lengthOk(territory, nsn2)) {
		return res(asPrinted, false,
			territory + " numbers usually have " + G.NSN_LEN[territory].join(" or ") +
			" digits, this one has " + nsn2.length + " — check it.");
	}
	return finish(cc, nsn2, true);
}

/* ------------------------------------------------------------- whole record */

/* Runs all three over a card and returns the fields it changed plus the notes
   for anything a person has to settle. Never throws away the original text. */
function normalizeCard(f) {
	var notes = {}, changed = {};

	var c = normCountry(f.country);
	if (c.value !== (f.country || "")) changed.country = c.value;
	if (!c.ok) notes.country = c.note;
	var terr = c.ok ? c.value : "";

	var s = normRegion(f.state, terr);
	if (s.value !== (f.state || "")) changed.state = s.value;
	if (!s.ok) notes.state = s.note;

	["mobile_no", "phone", "fax"].forEach(function (k2) {
		var p = normPhone(f[k2], terr);
		if (p.value !== (f[k2] || "")) changed[k2] = p.value;
		if (!p.ok) notes[k2] = p.note;
	});

	return { changed: changed, notes: notes, territory: terr,
		country_field: countryFieldValue(terr) };
}

return {
	normCountry: normCountry, normRegion: normRegion, normPhone: normPhone,
	normalizeCard: normalizeCard, countryFieldValue: countryFieldValue,
	regionTable: regionTable,
	setLive: setLive, key: key
};
})();
