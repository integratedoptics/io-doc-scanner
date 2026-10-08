/* Card Scanner — offline business card capture with ERPNext Excel export.
   The native side (MainActivity.java) exposes window.Android; when it is
   missing we fall back to a browser shim so the same UI can be tested in a
   desktop browser. */
(function () {
"use strict";

// ---------------------------------------------------------------- bridge shim
var A = window.Android || (window.Android = {
	_d: {},
	appVersion: function () { return "1.0-web"; },
	toast: function (m) { console.log("[toast]", m); },
	takePhoto: function () { window.onScan({ ok: false, error: "No camera in this browser." }); },
	pickPhoto: function () { window.onScan({ ok: false, error: "No camera in this browser." }); },
	/* No native document picker in a plain browser (or in Electron, which has
	   no bridge object at all) — a hidden file input does the same job and
	   needs no native/Electron code of its own. */
	pickDocument: function () {
		var inp = document.getElementById("doc-file-fallback");
		if (!inp) {
			inp = document.createElement("input");
			inp.type = "file";
			inp.accept = "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png";
			inp.style.display = "none";
			inp.id = "doc-file-fallback";
			document.body.appendChild(inp);
			inp.addEventListener("change", function () {
				var file = inp.files && inp.files[0];
				inp.value = "";
				if (!file) { window.onDocPicked({ ok: false, error: "No file chosen." }); return; }
				var r = new FileReader();
				r.onload = function () {
					window.onDocPicked({ ok: true, name: file.name, dataUrl: r.result });
				};
				r.onerror = function () {
					window.onDocPicked({ ok: false, error: "Could not read that file." });
				};
				r.readAsDataURL(file);
			});
		}
		inp.click();
	},
	reOcr: function () { window.onScan({ ok: false, error: "Not available in this browser." }); },
	readData: function (n) { return localStorage.getItem("cs:" + n) || ""; },
	writeData: function (n, c) { localStorage.setItem("cs:" + n, c); return true; },
	readAsset: function (n) { return (window.CS_ASSETS || {})[n] || ""; },
	readCardImage: function () { return ""; },
	deleteCardImage: function () { return true; },
	saveToDocuments: function (name, b64) {
		(window.CS_SAVED = window.CS_SAVED || {})[name] = b64;
		return JSON.stringify({ ok: true, path: "Documents/CardScanner/" + name, uri: "mem://" + name });
	},
	shareFiles: function () {},
	httpPostJson: function (u, h, b, t, id) {
		setTimeout(function () { window.onHttp(id, "ERR:no network bridge in this browser"); }, 10);
	},
	httpRequest: function (m, u, h, b, t, id) {
		setTimeout(function () { window.onHttp(id, "ERR:no network bridge in this browser"); }, 10);
	}
});

var NORM = window.CS_NORM;
var ERP = window.CS_ERP;
var GEO = window.CS_GEO;

// ------------------------------------------------------------------- constants
var FIELDS = ["salutation", "first_name", "middle_name", "last_name", "designation", "department",
	"company_name", "email", "email_secondary", "mobile_no", "phone", "fax", "website", "linkedin",
	"address_line1", "address_line2", "city", "state", "pincode", "country",
	"link_doctype", "link_name", "notes", "raw_text"];

/* Text fields the long-press + swipe gesture may move values between. */
var MOVABLE = ["salutation", "first_name", "middle_name", "last_name", "designation", "department",
	"company_name", "email", "email_secondary", "mobile_no", "phone", "fax", "website", "linkedin",
	"address_line1", "address_line2", "city", "state", "pincode", "country", "link_name", "notes"];

var DEFAULTS = {
	country: "Lithuania", atype: "Office", status: "Open", lang: "",
	primary: true, news: false, ai: false, li: true, prov: "openai",
	url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", key: "",
	/* standardising */
	norm: true,
	/* ERPNext connection */
	erp_url: "", erp_mode: "token", erp_key: "", erp_secret: "",
	erp_usr: "", erp_pwd: "", erp_org: "Customer", erp_supplier_type: "",
	extract_key: "", extract_workspace: "",
	/* attach the photo of the card, and let the app fill small ERPNext lists */
	erp_attach: true, erp_masters: true,
	/* which of the three switches a new card starts with */
	sync_org: false, sync_contact: true, sync_address: true
};

var EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;
var URLRE = /\b(?:https?:\/\/)?(?:www\.)?([\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|ai|eu|lt|de|uk|us|fr|pl|lv|ee|se|fi|dk|no|nl|be|ch|at|it|es|cz|jp|cn|tech|dev|co))\b/i;
var PHONE = /\+?\d[\d\s().-]{6,}\d/;
var PHONEY = /\+?\d[\d\s().-]{7,}/;
var POST = /\b([A-Z]{2}[- ]?\d{4,6}|\d{4,6})\b/;
var STREET = /(str\.?|street|g\.|gatv\w*|pr\.|al\.|ave\.?|avenue|road|rd\.|blvd|lane|strasse|straße|weg|platz|via|ul\.|kelias)\s*\.?\s*\d+|^\d+[a-z]?\s+[A-Za-z]/i;
var LEGAL = /(^|\W)(uab|mb|ab|všį|gmbh|ag|ltd\.?|limited|llc|inc\.?|corp\.?|co\.|s\.a\.|oy|oyj|bv|nv|srl|spa|kft|aps|plc|pte)(\W|$)/i;
var BIZ = /\b(technologies|technology|solutions|systems|group|holding|labs|laboratories|photonics|optics|instruments|industries|engineering|consulting|partners|works|studio|software)\b/i;
/* The names a card might print, used to spot a country line in the OCR text.
   The keys of the alias table already cover every spelling we recognise, so the
   parser searches those and hands the hit to CS_NORM for the exact ERPNext
   spelling. Very short keys (ISO codes) are excluded: "in", "is" and "at" would
   match ordinary English words. */
var COUNTRY_WORDS = Object.keys(GEO.ALIAS)
	.filter(function (k) { return k.length >= 4; })
	.sort(function (a, b) { return b.length - a.length; });
var FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|aol|gmx|web|mail|inbox|protonmail|proton|zoho|yandex)\./i;

// A letter test that also accepts ą, ü, ž… where the engine supports it.
var LETTERWORD;
try { LETTERWORD = new RegExp("^\\p{L}[\\p{L}\\p{M}'\u2019.-]*$", "u"); }
catch (e) { LETTERWORD = /^[^\W\d_][\w'’.-]*$/; }

var TITLE = /(ceo|cto|coo|cfo|cmo|chief\s+\w+|officer|founder|co-founder|owner|president|vice\s+president|\bvp\b|director|manager|\bhead\b|team\s+lead|engineer|scientist|specialist|researcher|analyst|architect|developer|consultant|partner|advisor|coordinator|supervisor|technician|sales|marketing|business\s+develop\w*|r&d|vadovas|direktor\w*|inžinier\w*|savinink\w*)/i;

// --------------------------------------------------------------------- parser
function parseCard(text) {
	var out = {};
	FIELDS.forEach(function (f) { out[f] = ""; });
	if (!text) return out;
	var lines = text.split("\n").map(function (l) {
		return l.replace(/\s{2,}/g, " ").trim().replace(/^[|•·,;]+|[|•·,;]+$/g, "");
	}).filter(function (l) { return l.length > 1; });

	var mails = text.match(EMAIL) || [];
	if (mails[0]) out.email = mails[0].toLowerCase();
	if (mails[1]) out.email_secondary = mails[1].toLowerCase();

	lines.forEach(function (ln) {
		var m = ln.match(PHONE);
		if (!m) return;
		var num = m[0].replace(/[^\d+]/g, "");
		if (num.length < 7) return;
		var low = ln.toLowerCase();
		if (/mob|cell|gsm|m:|m\./.test(low) && !out.mobile_no) out.mobile_no = num;
		else if (low.indexOf("fax") >= 0 && !out.fax) out.fax = num;
		else if (!out.phone) out.phone = num;
		else if (!out.mobile_no) out.mobile_no = num;
	});

	var li = text.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub|company)\/[A-Za-z0-9\-_%]{3,}/i);
	if (li) out.linkedin = normLinkedIn(li[0]);

	var u = text.replace(EMAIL, " ").match(URLRE);
	if (u && !/^(gmail|outlook|yahoo|hotmail)/i.test(u[1])) {
		out.website = u[1].toLowerCase().replace(/[./]+$/, "");
	}

	var t = lines.filter(function (ln) { return ln.length < 60 && TITLE.test(ln) && ln.indexOf("@") < 0; })[0];
	if (t) out.designation = t;

	var pool = lines.filter(function (ln) {
		return ln !== out.designation && ln.indexOf("@") < 0 && !PHONEY.test(ln) && !STREET.test(ln);
	});
	out.company_name = pool.filter(function (l) { return LEGAL.test(l); })[0]
		|| pool.filter(function (l) { return BIZ.test(l); })[0] || "";

	for (var i = 0; i < Math.min(6, lines.length); i++) {
		var ln = lines[i];
		if (ln === out.company_name || ln === out.designation) continue;
		if (ln.indexOf("@") >= 0 || PHONE.test(ln)) continue;
		var words = ln.split(/\s+/);
		if (words.length > 1 && words.length <= 4 &&
			words.every(function (w) { return LETTERWORD.test(w); })) {
			var parts = words.map(function (w) { return w.replace(/[.,]$/, ""); });
			if (/^(mr|mrs|ms|dr|prof)\.?$/i.test(parts[0])) out.salutation = parts.shift().replace(".", "");
			out.first_name = parts[0] || "";
			if (parts.length === 3) { out.middle_name = parts[1]; out.last_name = parts[2]; }
			else if (parts.length > 1) out.last_name = parts.slice(1).join(" ");
			break;
		}
	}

	var cands = lines.filter(function (ln) { return ln.indexOf("@") < 0 && !PHONEY.test(ln); });
	var addr = cands.filter(function (ln) { return STREET.test(ln) || POST.test(ln); });
	if (addr.length) {
		var segs = [];
		addr.forEach(function (ln) {
			ln.split(",").forEach(function (s) {
				s = s.trim().replace(/^[.,;|\s]+|[.,;|\s]+$/g, "");
				if (s) segs.push(s);
			});
		});
		var street = segs.filter(function (s) { return STREET.test(s); })[0];
		if (street) out.address_line1 = street;
		var pseg = segs.filter(function (s) { return POST.test(s) && s !== street; })[0];
		if (pseg) {
			out.pincode = pseg.match(POST)[1].replace(/\s/g, "");
			var city = pseg.replace(POST, "").trim().replace(/^[-,.\s]+|[-,.\s]+$/g, "");
			if (city.length > 1) out.city = city;
		}
		if (!out.city) {
			out.city = segs.filter(function (s) {
				return s !== street && /^[A-Za-z\s]{3,29}$/.test(s);
			})[0] || "";
		}
		var last = segs[segs.length - 1];
		if (last && last !== street && last !== out.city && /^[A-Za-z\s]{4,29}$/.test(last)) out.country = last;
		if (!out.address_line1) out.address_line1 = segs[0];
	}
	// A card almost always carries the company domain in the email address, and
	// OCR gets an email right far more often than a bare URL (elmotech.lt vs
	// elmotech.it). Trust the email domain when the two disagree.
	if (out.email) {
		var dom = out.email.split("@")[1] || "";
		if (dom && !FREEMAIL.test(dom + ".")) {
			var label = dom.split(".")[0];
			if (!out.website || out.website.split(".")[0] === label) out.website = dom;
		}
	}

	/* Look for a country name anywhere in the text, longest spelling first so
	   "United Kingdom" beats "Kingdom". Whatever is found goes through CS_NORM,
	   which turns it into the exact spelling this ERPNext instance uses. */
	if (!out.country) {
		for (var ci = 0; ci < COUNTRY_WORDS.length; ci++) {
			var cn = COUNTRY_WORDS[ci];
			var rx = new RegExp("(^|[\\s,.])" +
				cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([\\s,.]|$)", "i");
			var hit = lines.filter(function (ln) {
				return ln.length < 40 && rx.test(ln);
			})[0];
			if (hit) {
				var c = NORM.normCountry(cn);
				out.country = c.ok ? c.value : cn;
				break;
			}
		}
	}

	if (!out.company_name && out.website) {
		out.company_name = out.website.split(".")[0].replace(/^./, function (c) { return c.toUpperCase(); });
	}
	out.raw_text = text;
	return out;
}

// -------------------------------------------------------------------- storage
var S = {};    // settings
var cards = [];
var draft = null;

function loadState() {
	var raw = A.readData("settings.json");
	S = {};
	Object.keys(DEFAULTS).forEach(function (k) { S[k] = DEFAULTS[k]; });
	if (raw) { try { var o = JSON.parse(raw); Object.keys(o).forEach(function (k) { S[k] = o[k]; }); } catch (e) {} }
	var c = A.readData("cards.json");
	cards = [];
	if (c) { try { cards = JSON.parse(c) || []; } catch (e) { cards = []; } }
}
function saveCards() { A.writeData("cards.json", JSON.stringify(cards)); paintCount(); }
function saveSettings() { A.writeData("settings.json", JSON.stringify(S)); }

// ------------------------------------------------------------------------- ui
function $(id) { return document.getElementById(id); }
function toast(msg, kind) {
	var t = $("toast");
	t.textContent = msg;
	t.className = "on" + (kind ? " " + kind : "");
	clearTimeout(toast._t);
	toast._t = setTimeout(function () { t.className = ""; }, kind === "err" ? 5200 : 2600);
}
var TITLES = { scan: "Scan card", cards: "Saved cards", docs: "Documents", export: "Export", set: "Settings" };
function show(v) {
	["scan", "cards", "docs", "export", "set"].forEach(function (n) {
		$("v-" + n).classList.toggle("on", n === v);
	});
	Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
		b.classList.toggle("on", b.dataset.v === v);
	});
	$("ttl").textContent = TITLES[v];
	if (v === "cards") paintList();
	if (v === "docs" && window.CS_DOCSCAN) window.CS_DOCSCAN.onShow();
	document.querySelector("main").scrollTop = 0;
}
function paintCount() {
	$("cnt").textContent = cards.length + (cards.length === 1 ? " card" : " cards");
}

function cardTitle(c) {
	var n = [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(" ");
	return n || c.company_name || c.email || "Untitled card";
}
function cardSub(c) {
	return [c.company_name, c.email || c.mobile_no || c.phone].filter(Boolean).join(" · ") || "no details";
}

function paintList() {
	var box = $("list");
	if (!cards.length) {
		box.innerHTML = '<div class="empty">No cards yet.<br>Go to Scan and photograph one.</div>';
		$("sel-info").textContent = "Ticked cards are the ones that get exported.";
		return;
	}
	box.innerHTML = "";
	cards.forEach(function (c, i) {
		var d = document.createElement("div");
		d.className = "item";
		var img = document.createElement("img");
		if (c.thumb) img.src = c.thumb;
		var t = document.createElement("div");
		t.className = "t";
		t.innerHTML = "<b></b><span></span>";
		t.querySelector("b").textContent = cardTitle(c);
		t.querySelector("span").textContent = cardSub(c) +
			(c.exported ? " · exported" : "") + (c.synced ? " · in ERPNext" : "");
		var chk = document.createElement("input");
		chk.type = "checkbox"; chk.className = "chk"; chk.checked = c.sel !== false;
		chk.onclick = function (e) { e.stopPropagation(); c.sel = chk.checked; saveCards(); selInfo(); };
		d.appendChild(img); d.appendChild(t); d.appendChild(chk);
		d.onclick = function () { editCard(i); };
		box.appendChild(d);
	});
	selInfo();
}
function selInfo() {
	var n = cards.filter(function (c) { return c.sel !== false; }).length;
	$("sel-info").textContent = n + " of " + cards.length + " selected for export.";
}

// -------------------------------------------------------------------- editing
function fillForm(f) {
	FIELDS.forEach(function (k) {
		var el = $("f-" + k);
		if (el) el.value = f[k] || "";
	});
	$("f-newsletter").checked = f.newsletter === undefined ? !!S.news : !!f.newsletter;
	var pref = syncPrefs(f);
	$("f-sync_doctype").value = pref.doctype;
	$("f-sync_org").checked = pref.org;
	$("f-sync_contact").checked = pref.contact;
	$("f-sync_address").checked = pref.address;
	$("sync-stat").innerHTML = "";
	liNote(f.linkedin_guess ? "guess" : "");
	$("box-form").style.display = "";
	var p = $("prev");
	if (f.thumb) { p.src = f.thumb; p.style.display = ""; } else { p.style.display = "none"; }
	$("btn-save").textContent = draft && draft.index >= 0 ? "Update card" : "Save card";
	$("btn-cancel").textContent = draft && draft.index >= 0 ? "Close without saving" : "Discard";
}
function readForm() {
	var f = {};
	FIELDS.forEach(function (k) {
		var el = $("f-" + k);
		f[k] = el ? el.value.trim() : "";
	});
	f.newsletter = $("f-newsletter").checked;
	f.sync_doctype = $("f-sync_doctype").value;
	f.sync_org = $("f-sync_org").checked;
	f.sync_contact = $("f-sync_contact").checked;
	f.sync_address = $("f-sync_address").checked;
	f.linkedin_guess = !!liNote.on;
	return f;
}

/* Small caption under the LinkedIn box telling the user the value is a
   model suggestion that nobody has verified. */
function liNote(state) {
	var p = $("li-note");
	liNote.on = state === "guess";
	if (!p) return;
	if (liNote.on) {
		p.style.display = "";
		p.style.color = "var(--violet)";
		p.textContent = "Suggested by the model and not verified — open it once before you export.";
	} else {
		p.style.display = "none";
	}
}
function newDraft(fields, image, thumb) {
	draft = { index: -1, image: image || "", thumb: thumb || "" };
	fields.thumb = draft.thumb;
	clearNotes();
	fillForm(fields);
	warnBox([]);
	if (S.norm !== false) applyNormalisation(true);
	show("scan");
}
function editCard(i) {
	var c = cards[i];
	draft = { index: i, image: c.image || "", thumb: c.thumb || "" };
	var f = {};
	FIELDS.forEach(function (k) { f[k] = c[k] || ""; });
	f.newsletter = !!c.newsletter;
	f.sync_doctype = c.sync_doctype;
	f.sync_org = c.sync_org;
	f.sync_contact = c.sync_contact;
	f.sync_address = c.sync_address;
	f.linkedin_guess = !!c.linkedin_guess;
	f.thumb = c.thumb || "";
	if (!f.thumb && c.image) { f.thumb = A.readCardImage(c.image) || ""; }
	clearNotes();
	fillForm(f);
	warnBox([]);
	if (S.norm !== false) applyNormalisation(true); else paintRegionList(f.country);
	show("scan");
}
function warnBox(msgs) {
	$("warn").innerHTML = msgs.map(function (m) {
		return '<p class="hint" style="color:var(--err)">' + m.replace(/</g, "&lt;") + "</p>";
	}).join("");
}
function closeForm() {
	draft = null;
	$("box-form").style.display = "none";
	$("prev").style.display = "none";
}

// ----------------------------------------------------------- capture callback
window.onScan = function (r) {
	busy($("btn-cam"), false, "Take a photo of a card");
	busy($("btn-pick"), false, "Choose an existing picture");
	if (!r || !r.ok) {
		toast((r && r.error) || "Capture failed.", "err");
		return;
	}
	var f = parseCard(r.text || "");
	if (!f.country) f.country = S.country;
	if (draft && draft.index >= 0) {
		// re-OCR of an existing card: only refresh the raw text
		$("f-raw_text").value = r.text || "";
		toast("Text recognised again — press Parse to apply.", "good");
		return;
	}
	newDraft(f, r.image, r.thumb);
	var w = [];
	if (!r.lines) w.push("No text was recognised. Try again with more light and the card filling the frame.");
	if (!f.first_name) w.push("No personal name found — first name is mandatory for the Contact import.");
	if (!f.email && !f.mobile_no && !f.phone) w.push("No email or phone number found.");
	warnBox(w);
	toast(r.lines + " lines recognised", "good");
	if (S.ai && S.key) aiCleanup(true);
};
window.onScanCancelled = function () {
	busy($("btn-cam"), false, "Take a photo of a card");
	busy($("btn-pick"), false, "Choose an existing picture");
};
window.onAndroidBack = function () {
	if ($("box-form").style.display !== "none" && $("v-scan").classList.contains("on")) {
		closeForm();
	} else if (!$("v-scan").classList.contains("on")) {
		show("scan");
	}
};

function busy(btn, on, label) {
	if (!btn) return;
	btn.disabled = on;
	btn.innerHTML = on ? '<span class="spin"></span>' + label : label;
}

// ------------------------------------------------------------------ AI clean
function aiCleanup(silent) {
	if (!S.ai || !S.key) { if (!silent) toast("Switch on AI cleanup and add an API key in Settings.", "err"); return; }
	var cur = readForm();
	var raw = cur.raw_text || "";
	if (!raw) { if (!silent) toast("Nothing to clean up.", "err"); return; }
	busy($("btn-ai"), true, "Asking the model…");

	var keys = ["salutation", "first_name", "middle_name", "last_name", "designation", "department",
		"company_name", "email", "email_secondary", "mobile_no", "phone", "fax", "website",
		"address_line1", "address_line2", "city", "state", "pincode", "country"];
	var wantLi = S.li !== false;
	if (wantLi) keys = keys.concat(["linkedin"]);
	var prompt = "You clean up OCR output from a business card. Return ONLY a JSON object with exactly these keys: "
		+ keys.join(", ") + ". Use an empty string when a value is absent. Repair typical OCR confusions "
		+ "(0/O, 1/l/I, 5/S, rn/m) and missing dots in domains. Keep phone numbers in international format. "
		+ "Do not invent information.";
	if (wantLi) {
		prompt += "\n\nFor \"linkedin\": if the card itself shows a LinkedIn address, copy it. "
			+ "Otherwise, only if you already know this exact person's public LinkedIn profile from the "
			+ "person's name together with the company, return the full https://www.linkedin.com/in/... URL. "
			+ "If you are not certain the profile belongs to this person, return an empty string. "
			+ "Never construct or guess a slug from the name.";
	}
	prompt += "\n\nCard text:\n" + raw
		+ "\n\nCurrent rule-based guess (correct it):\n" + JSON.stringify(cur, null, 0);

	var url, headers, body;
	if (S.prov === "anthropic") {
		url = S.url && S.url.indexOf("anthropic") >= 0 ? S.url : "https://api.anthropic.com/v1/messages";
		headers = { "x-api-key": S.key, "anthropic-version": "2023-06-01" };
		body = JSON.stringify({ model: S.model || "claude-3-5-haiku-latest", max_tokens: 900,
			messages: [{ role: "user", content: prompt }] });
	} else {
		url = S.url || "https://api.openai.com/v1/chat/completions";
		headers = { Authorization: "Bearer " + S.key };
		body = JSON.stringify({ model: S.model || "gpt-4o-mini", temperature: 0,
			response_format: { type: "json_object" },
			messages: [{ role: "user", content: prompt }] });
	}

	window.CS_NET.raw(url, headers, body, 45, function (resp) {
		busy($("btn-ai"), false, "Clean up with AI");
		if (typeof resp === "string" && resp.indexOf("ERR:") === 0) { toast(resp.slice(4), "err"); return; }
		var txt = "";
		try {
			var j = JSON.parse(resp);
			if (j.choices && j.choices[0]) txt = j.choices[0].message.content;
			else if (j.content && j.content[0]) txt = j.content[0].text;
		} catch (e) { toast("Unexpected answer from the model.", "err"); return; }
		var m = txt && txt.match(/\{[\s\S]*\}/);
		if (!m) { toast("The model returned no JSON.", "err"); return; }
		var f;
		try { f = JSON.parse(m[0]); } catch (e) { toast("The model returned broken JSON.", "err"); return; }
		var changed = 0, liFound = false;
		keys.forEach(function (k) {
			var el = $("f-" + k);
			if (!el || typeof f[k] !== "string") return;
			var v = f[k].trim();
			if (k === "linkedin") {
				v = normLinkedIn(v);
				if (v && v !== el.value) { el.value = v; changed++; liFound = true; }
				return;
			}
			if (v && v !== el.value) { el.value = v; changed++; }
		});
		if (liFound) liNote("guess");
		toast(changed
			? "AI cleanup adjusted " + changed + " field(s)" + (liFound ? ", including a LinkedIn suggestion." : ".")
			: "AI cleanup found nothing to fix.", "good");
		if (S.norm !== false) applyNormalisation(true);
	});
}

/* Accepts only something that really looks like a LinkedIn profile address.
   Anything else is dropped, so a chatty model cannot fill the field with prose. */
function normLinkedIn(v) {
	if (!v) return "";
	v = String(v).trim().replace(/[),.;]+$/, "");
	if (/^(n\/a|none|unknown|null)$/i.test(v)) return "";
	var m = v.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(in|pub|company)\/([A-Za-z0-9\-_%\u00C0-\u024F]{3,})\/?/i);
	if (!m) return "";
	return "https://www.linkedin.com/" + m[1].toLowerCase() + "/" + m[2];
}

// --------------------------------------------------------------- xlsx export
function b64ToU8(b64) {
	var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
	for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
	return u;
}
function u8ToB64(u8) {
	var s = "", CH = 0x8000;
	for (var i = 0; i < u8.length; i += CH) {
		s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
	}
	return btoa(s);
}

/* Reads one of the bundled ERPNext templates and returns
   { wb, ws, sheet, colOf:{column_name:colIndex}, firstRow } */
function openTemplate(assetName) {
	var b64 = A.readAsset(assetName);
	if (!b64) throw new Error("Template " + assetName + " is missing from the app.");
	var wb = XLSX.read(b64ToU8(b64), { type: "array", cellStyles: true });
	var sheet = wb.SheetNames[0];
	var ws = wb.Sheets[sheet];
	var ref = XLSX.utils.decode_range(ws["!ref"]);
	var colOf = {}, nameRow = -1, startRow = -1;
	for (var r = ref.s.r; r <= Math.min(ref.e.r, 40); r++) {
		var a = ws[XLSX.utils.encode_cell({ c: 0, r: r })];
		var v = a && a.v ? String(a.v).trim() : "";
		if (/^Column Name:?$/i.test(v)) nameRow = r;
		if (/start entering data below/i.test(v)) startRow = r + 1;
	}
	if (nameRow < 0) throw new Error("Cannot find the 'Column Name:' row in " + assetName);
	if (startRow < 0) startRow = nameRow + 5;
	for (var c = 1; c <= ref.e.c; c++) {
		var cell = ws[XLSX.utils.encode_cell({ c: c, r: nameRow })];
		var nm = cell && cell.v ? String(cell.v).trim() : "";
		if (nm && nm !== "~" && !(nm in colOf)) colOf[nm] = c;
	}
	return { wb: wb, ws: ws, sheet: sheet, colOf: colOf, firstRow: startRow, ref: ref };
}

function put(ws, r, c, v) {
	if (v === "" || v === null || v === undefined) return;
	ws[XLSX.utils.encode_cell({ c: c, r: r })] = typeof v === "number"
		? { t: "n", v: v } : { t: "s", v: String(v) };
}

function finishTemplate(T, lastRow) {
	var ref = XLSX.utils.decode_range(T.ws["!ref"]);
	ref.e.r = Math.max(ref.e.r, lastRow);
	T.ws["!ref"] = XLSX.utils.encode_range(ref);
	return new Uint8Array(XLSX.write(T.wb, { bookType: "xlsx", type: "array" }));
}

function addressComplete(c) {
	return !!(c.address_line1 && c.city && c.country);
}

function buildContactBook(sel) {
	var T = openTemplate("template-contact.xlsx");
	var K = T.colOf, r = T.firstRow, used = 0;
	sel.forEach(function (c) {
		if (!c.first_name && !c.last_name && !c.email) return;
		var first = c.first_name || (c.company_name ? c.company_name : "Unknown");
		var last = [c.middle_name, c.last_name].filter(Boolean).join(" ");
		put(T.ws, r, K.first_name, first);
		put(T.ws, r, K.last_name, last);
		put(T.ws, r, K.email_id, c.email);
		put(T.ws, r, K.salutation, c.salutation);
		put(T.ws, r, K.phone, c.phone);
		put(T.ws, r, K.mobile_no, c.mobile_no);
		put(T.ws, r, K.designation, c.designation);
		put(T.ws, r, K.department, c.department);
		put(T.ws, r, K.linkedin, c.linkedin);
		// ERPNext stores the opposite of a subscription: 0 = happy to receive mail.
		put(T.ws, r, K.unsubscribed, c.newsletter ? 0 : 1);
		put(T.ws, r, K.status, S.status || "Open");
		if (S.lang) put(T.ws, r, K.main_language, S.lang);
		put(T.ws, r, K.is_primary_contact, S.primary ? 1 : 0);
		if (c.link_doctype && c.link_name) {
			put(T.ws, r, K.link_doctype, c.link_doctype);
			put(T.ws, r, K.link_name, c.link_name);
		}
		r++; used++;
	});
	return { bytes: finishTemplate(T, r - 1), rows: used };
}

function buildAddressBook(sel) {
	var T = openTemplate("template-address.xlsx");
	var K = T.colOf, r = T.firstRow, used = 0;
	sel.forEach(function (c) {
		if (!addressComplete(c)) return;
		var who = [c.first_name, c.last_name].filter(Boolean).join(" ");
		var title = c.company_name || who || c.city;
		put(T.ws, r, K.address_type, S.atype || "Office");
		put(T.ws, r, K.address_title, title);
		put(T.ws, r, K.address_line1, c.address_line1);
		put(T.ws, r, K.address_line2, c.address_line2);
		put(T.ws, r, K.city, c.city);
		put(T.ws, r, K.state, c.state);
		put(T.ws, r, K.pincode, c.pincode);
		put(T.ws, r, K.country, c.country || S.country);
		put(T.ws, r, K.email_id, c.email);
		put(T.ws, r, K.phone, c.phone || c.mobile_no);
		put(T.ws, r, K.fax, c.fax);
		put(T.ws, r, K.is_primary_address, 1);
		if (c.link_doctype && c.link_name) {
			put(T.ws, r, K.link_doctype, c.link_doctype);
			put(T.ws, r, K.link_name, c.link_name);
		}
		r++; used++;
	});
	return { bytes: finishTemplate(T, r - 1), rows: used };
}

function buildBackupBook(sel) {
	var head = ["Scanned", "Salutation", "First name", "Middle name", "Last name", "Designation",
		"Department", "Company", "Email", "Second email", "Newsletter", "Mobile", "Phone", "Fax",
		"Website", "LinkedIn", "LinkedIn verified",
		"Address line 1", "Address line 2", "City", "State", "Post code", "Country",
		"Link doctype", "Link name", "Notes", "Recognised text"];
	var rows = [head];
	sel.forEach(function (c) {
		rows.push([c.created || "", c.salutation, c.first_name, c.middle_name, c.last_name,
			c.designation, c.department, c.company_name, c.email, c.email_secondary,
			c.newsletter ? "Yes" : "No",
			c.mobile_no, c.phone, c.fax, c.website, c.linkedin,
			c.linkedin ? (c.linkedin_guess ? "AI suggestion" : "From the card") : "",
			c.address_line1, c.address_line2,
			c.city, c.state, c.pincode, c.country, c.link_doctype, c.link_name,
			c.notes, c.raw_text].map(function (v) { return v || ""; }));
	});
	var ws = XLSX.utils.aoa_to_sheet(rows);
	ws["!cols"] = head.map(function (h, i) { return { wch: i === head.length - 1 ? 46 : Math.max(11, h.length + 2) }; });
	var wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, ws, "Cards");
	return { bytes: new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" })), rows: rows.length - 1 };
}

var lastUris = [];

function doExport() {
	var sel = cards.filter(function (c) { return c.sel !== false; });
	if (!sel.length) { toast("Tick at least one card on the Cards tab.", "err"); return; }
	busy($("btn-export"), true, "Building…");
	setTimeout(function () {
		var stat = $("ex-stat"), out = [];
		lastUris = [];
		try {
			var stamp = new Date().toISOString().slice(0, 10);
			var jobs = [
				["Contact-" + stamp + ".xlsx", buildContactBook(sel)],
				["Address-" + stamp + ".xlsx", buildAddressBook(sel)],
				["Cards-" + stamp + ".xlsx", buildBackupBook(sel)]
			];
			var MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
			jobs.forEach(function (j) {
				if (!j[1].rows) { out.push("· " + j[0] + " — skipped, no usable rows"); return; }
				var res = JSON.parse(A.saveToDocuments(j[0], u8ToB64(j[1].bytes), MIME));
				if (res.ok) {
					lastUris.push(res.uri);
					out.push("✓ " + j[0] + " — " + j[1].rows + " row(s) → " + res.path);
				} else {
					out.push("✗ " + j[0] + " — " + res.error);
				}
			});
			var noAddr = sel.filter(function (c) { return !addressComplete(c); }).length;
			if (noAddr) out.push("· " + noAddr + " card(s) had an incomplete address (line 1, city and country are required) and were left out of Address.xlsx.");
			stat.innerHTML = '<p class="hint">' + out.join("<br>") + "</p>";
			$("btn-share").disabled = !lastUris.length;
			toast(lastUris.length ? "Saved to Documents/CardScanner" : "Nothing was written.", lastUris.length ? "good" : "err");
		} catch (e) {
			stat.innerHTML = '<p class="hint" style="color:var(--err)">' + String(e.message || e) + "</p>";
			toast("Export failed: " + (e.message || e), "err");
		}
		busy($("btn-export"), false, "Create Excel files");
	}, 30);
}

// ------------------------------------------------------------------- settings
function paintSettings() {
	$("s-country").value = S.country || "";
	$("s-atype").value = S.atype || "Office";
	$("s-status").value = S.status || "Open";
	$("s-lang").value = S.lang || "";
	$("s-primary").checked = !!S.primary;
	$("s-news").checked = !!S.news;
	$("s-ai").checked = !!S.ai;
	$("s-li").checked = S.li !== false;
	$("s-prov").value = S.prov || "openai";
	$("s-url").value = S.url || "";
	$("s-model").value = S.model || "";
	$("s-key").value = S.key || "";
	$("s-norm").checked = S.norm !== false;
	$("s-erp-url").value = S.erp_url || "";
	$("s-erp-mode").value = S.erp_mode || "token";
	$("s-erp-key").value = S.erp_key || "";
	$("s-erp-secret").value = S.erp_secret || "";
	$("s-erp-usr").value = S.erp_usr || "";
	$("s-erp-pwd").value = S.erp_pwd || "";
	$("s-erp-org").value = S.erp_org || "Customer";
	$("s-erp-supplier-type").value = S.erp_supplier_type || "";
	$("s-extract-key").value = S.extract_key || "";
	$("s-extract-workspace").value = S.extract_workspace || "";
	$("s-erp-attach").checked = S.erp_attach !== false;
	$("s-erp-masters").checked = S.erp_masters !== false;
	$("s-sync-org").checked = !!S.sync_org;
	$("s-sync-contact").checked = S.sync_contact !== false;
	$("s-sync-address").checked = S.sync_address !== false;
	erpModeUi();
	$("ver").textContent = A.appVersion();
}

/* Only the boxes that belong to the chosen authentication method are shown. */
function erpModeUi() {
	var token = $("s-erp-mode").value !== "login";
	$("erp-token").style.display = token ? "" : "none";
	$("erp-login").style.display = token ? "none" : "";
}

function grabSettings(silent) {
	S.country = $("s-country").value.trim();
	S.atype = $("s-atype").value;
	S.status = $("s-status").value;
	S.lang = $("s-lang").value;
	S.primary = $("s-primary").checked;
	S.news = $("s-news").checked;
	S.ai = $("s-ai").checked;
	S.li = $("s-li").checked;
	S.prov = $("s-prov").value;
	S.url = $("s-url").value.trim();
	S.model = $("s-model").value.trim();
	S.key = $("s-key").value.trim();
	S.norm = $("s-norm").checked;
	S.erp_url = $("s-erp-url").value.trim().replace(/\/+$/, "");
	S.erp_mode = $("s-erp-mode").value;
	S.erp_key = $("s-erp-key").value.trim();
	S.erp_secret = $("s-erp-secret").value.trim();
	S.erp_usr = $("s-erp-usr").value.trim();
	S.erp_pwd = $("s-erp-pwd").value;
	S.erp_org = $("s-erp-org").value;
	S.erp_supplier_type = $("s-erp-supplier-type").value.trim();
	S.extract_key = $("s-extract-key").value.trim();
	S.extract_workspace = $("s-extract-workspace").value.trim();
	S.erp_attach = $("s-erp-attach").checked;
	S.erp_masters = $("s-erp-masters").checked;
	S.sync_org = $("s-sync-org").checked;
	S.sync_contact = $("s-sync-contact").checked;
	S.sync_address = $("s-sync-address").checked;
	saveSettings();
	ERP.configure(S);
	if (!silent) toast("Settings saved.", "good");
}

/* ===========================================================================
   Long press, then slide: move a value from one field to another.

   Hold a field for LONG_PRESS_MS, the box lifts (violet) and a chip follows
   the finger. Slide onto another field, it turns green, let go and the text
   moves there. If the target already holds something the two values swap, so
   a first name and a last name that came out the wrong way round are fixed in
   one gesture. Lift the finger anywhere else and nothing changes.
   =========================================================================== */
var LONG_PRESS_MS = 700;

function fieldLabel(el) {
	var p = el.parentNode, l = p && p.querySelector("label");
	var t = l ? l.textContent.replace(/\*/g, "").trim() : "";
	return t || el.id.replace(/^f-/, "").replace(/_/g, " ");
}

function installMoveGesture() {
	var G = {
		timer: null, src: null, active: false, over: null,
		x0: 0, y0: 0
	};
	var ghost = $("ghost"), hint = $("movehint");

	function targets() {
		return MOVABLE.map(function (k) { return $("f-" + k); }).filter(Boolean);
	}

	function cancelPending() {
		if (G.timer) { clearTimeout(G.timer); G.timer = null; }
	}

	function clearOver() {
		if (G.over) { G.over.classList.remove("dropok"); G.over = null; }
	}

	function stop() {
		cancelPending();
		if (G.src) G.src.classList.remove("lifted");
		clearOver();
		ghost.style.display = "none";
		hint.style.display = "none";
		G.src = null;
		G.active = false;
	}

	function lift(el, x, y) {
		G.active = true;
		G.src = el;
		el.blur();
		el.classList.add("lifted");
		ghost.textContent = el.value;
		ghost.style.display = "block";
		ghost.style.left = x + "px";
		ghost.style.top = y + "px";
		hint.style.display = "block";
		if (navigator.vibrate) { try { navigator.vibrate(28); } catch (e) {} }
	}

	function under(x, y) {
		var el = document.elementFromPoint(x, y);
		if (el && el.tagName === "INPUT" && el.id.indexOf("f-") === 0
			&& MOVABLE.indexOf(el.id.slice(2)) >= 0) return el;
		// Forgiving hit test: the nearest movable field the finger is level with.
		var best = null, bd = 26;
		targets().forEach(function (t) {
			var r = t.getBoundingClientRect();
			var dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
			var dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
			var d = Math.max(dx, dy);
			if (d < bd) { bd = d; best = t; }
		});
		return best;
	}

	function drop(dst) {
		var src = G.src;
		if (!src || !dst || dst === src) return;
		var a = src.value.trim(), b = dst.value.trim();
		if (!a) return;
		dst.value = a;
		src.value = b;
		if ($("f-linkedin") === dst || $("f-linkedin") === src) liNote("");
		if (navigator.vibrate) { try { navigator.vibrate([12, 40, 12]); } catch (e) {} }
		toast(b
			? "Swapped " + fieldLabel(src) + " and " + fieldLabel(dst) + "."
			: "Moved to " + fieldLabel(dst) + ".", "good");
	}

	document.addEventListener("touchstart", function (e) {
		stop();
		if (e.touches.length !== 1) return;
		var el = e.target;
		if (!el || el.tagName !== "INPUT" || !el.id || el.id.indexOf("f-") !== 0) return;
		if (MOVABLE.indexOf(el.id.slice(2)) < 0) return;
		if (!el.value.trim()) return;
		var t = e.touches[0];
		G.x0 = t.clientX; G.y0 = t.clientY;
		G.timer = setTimeout(function () { G.timer = null; lift(el, G.x0, G.y0); }, LONG_PRESS_MS);
	}, { passive: true });

	document.addEventListener("touchmove", function (e) {
		var t = e.touches[0];
		if (!t) return;
		if (!G.active) {
			// Finger travelled before the hold finished: this is a scroll, not a move.
			if (G.timer && (Math.abs(t.clientX - G.x0) > 9 || Math.abs(t.clientY - G.y0) > 9)) cancelPending();
			return;
		}
		e.preventDefault();
		ghost.style.left = t.clientX + "px";
		ghost.style.top = t.clientY + "px";
		var dst = under(t.clientX, t.clientY);
		if (dst === G.src) dst = null;
		if (dst !== G.over) {
			clearOver();
			if (dst) { dst.classList.add("dropok"); G.over = dst; }
		}
	}, { passive: false });

	document.addEventListener("touchend", function (e) {
		if (!G.active) { cancelPending(); return; }
		e.preventDefault();
		var t = e.changedTouches[0];
		var dst = G.over || (t ? under(t.clientX, t.clientY) : null);
		drop(dst);
		stop();
	}, { passive: false });

	document.addEventListener("touchcancel", stop, { passive: true });

	/* Mouse equivalent, so the same gesture can be tried in a desktop browser. */
	document.addEventListener("mousedown", function (e) {
		if (e.button !== 0) return;
		var el = e.target;
		if (!el || el.tagName !== "INPUT" || !el.id || el.id.indexOf("f-") !== 0) return;
		if (MOVABLE.indexOf(el.id.slice(2)) < 0 || !el.value.trim()) return;
		G.x0 = e.clientX; G.y0 = e.clientY;
		G.timer = setTimeout(function () { G.timer = null; lift(el, G.x0, G.y0); }, LONG_PRESS_MS);
	});
	document.addEventListener("mousemove", function (e) {
		if (!G.active) {
			if (G.timer && (Math.abs(e.clientX - G.x0) > 9 || Math.abs(e.clientY - G.y0) > 9)) cancelPending();
			return;
		}
		ghost.style.left = e.clientX + "px";
		ghost.style.top = e.clientY + "px";
		var dst = under(e.clientX, e.clientY);
		if (dst === G.src) dst = null;
		if (dst !== G.over) { clearOver(); if (dst) { dst.classList.add("dropok"); G.over = dst; } }
	});
	document.addEventListener("mouseup", function (e) {
		if (!G.active) { cancelPending(); return; }
		drop(G.over || under(e.clientX, e.clientY));
		stop();
	});

	window.CS_MOVE = { lift: lift, drop: drop, stop: stop, state: G, under: under };
}

/* ===========================================================================
   Standardising: country -> ERPNext territory, region -> full name,
   phone -> international. Anything that cannot be settled safely is marked on
   the field itself rather than guessed.
   =========================================================================== */

/* Note under one field. kind "" clears it. */
function fieldNote(key, msg, kind) {
	var el = $("f-" + key);
	if (!el) return;
	var note = el.parentNode.querySelector(".fnote[data-for=\"" + key + "\"]");
	el.classList.remove("needs", "fixed");
	if (!msg) { if (note) note.parentNode.removeChild(note); return; }
	if (!note) {
		note = document.createElement("p");
		note.className = "fnote";
		note.setAttribute("data-for", key);
		el.parentNode.insertBefore(note, el.nextSibling);
	}
	note.className = "fnote" + (kind === "good" ? " good" : "");
	note.textContent = msg;
	el.classList.add(kind === "good" ? "fixed" : "needs");
}

function clearNotes() {
	Array.prototype.forEach.call(document.querySelectorAll(".fnote"), function (n) {
		n.parentNode.removeChild(n);
	});
	Array.prototype.forEach.call(document.querySelectorAll("input.needs,input.fixed,select.needs"),
		function (e) { e.classList.remove("needs", "fixed"); });
}

/* The state datalist follows the country, so the suggestions are the regions of
   the right country rather than every abbreviation in the world. */
function paintRegionList(territory) {
	var dl = $("dl-regions");
	if (!dl) return;
	dl.innerHTML = "";
	var table = NORM.regionTable(territory);
	if (!table) return;
	var seen = {};
	Object.keys(table).forEach(function (a) {
		if (seen[table[a]]) return;
		seen[table[a]] = true;
		var o = document.createElement("option");
		o.value = table[a];
		dl.appendChild(o);
	});
}

function paintCountryList() {
	var dl = $("dl-countries");
	if (!dl) return;
	dl.innerHTML = "";
	GEO.COUNTRIES.forEach(function (c) {
		var o = document.createElement("option");
		o.value = c;
		dl.appendChild(o);
	});
}

/* Runs the three normalisers over the open form and reports back.
   Returns the number of fields that still need a human. */
function applyNormalisation(silent) {
	var f = readForm();
	var r = NORM.normalizeCard(f);
	var fixed = 0, flagged = 0;

	["country", "state", "mobile_no", "phone", "fax"].forEach(function (k) {
		fieldNote(k, "");
		if (Object.prototype.hasOwnProperty.call(r.changed, k)) {
			var el = $("f-" + k);
			if (el) el.value = r.changed[k];
			fixed++;
		}
	});
	Object.keys(r.notes).forEach(function (k) {
		fieldNote(k, r.notes[k]);
		flagged++;
	});

	/* A territory spelled oddly in ERPNext is kept, because a Link field only
	   takes an exact match, but the person is told why it looks wrong. */
	if (r.territory && GEO.SUSPECT[r.territory]) {
		fieldNote("country", "Kept as “" + r.territory + "”, which is how “" +
			GEO.SUSPECT[r.territory] + "” is spelled in your ERPNext territory list.", "good");
	}

	paintRegionList(r.territory);

	if (!silent) {
		if (flagged) toast(flagged + " field(s) need your attention.", "err");
		else if (fixed) toast(fixed + " field(s) standardised.", "good");
		else toast("Everything already matches ERPNext.", "good");
	}
	return flagged;
}

/* ===========================================================================
   Direct ERPNext synchronisation.
   =========================================================================== */

function syncPrefs(c) {
	return {
		doctype: c && c.sync_doctype ? c.sync_doctype : (S.erp_org || "Customer"),
		org: c && c.sync_org !== undefined ? !!c.sync_org : !!S.sync_org,
		contact: c && c.sync_contact !== undefined ? !!c.sync_contact : S.sync_contact !== false,
		address: c && c.sync_address !== undefined ? !!c.sync_address : S.sync_address !== false
	};
}

function esc(s) { return String(s === undefined ? "" : s).replace(/[<>&]/g, function (m) {
	return { "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m];
}); }

/* The tick, the cross, or a grey dash for a switch that was left off. */
function tickHtml(p) {
	if (p.state === "off") return '<span class="tick none" title="switched off">\u2013</span>';
	if (p.ok === true) return '<span class="tick yes" title="in ERPNext">\u2713</span>';
	return '<span class="tick no" title="not in ERPNext">\u2715</span>';
}

/* One line per document in a report, each with a green tick or a red cross.
   The tick only goes up once the record has been read back out of ERPNext. */
function reportHtml(rep, label) {
	if (rep.fatal) {
		return (label ? '<p class="hint" style="margin-top:12px"><b>' + esc(label) + "</b></p>" : "") +
			'<p class="hint" style="color:var(--err)">' + esc(rep.fatal) + "</p>";
	}
	var rows = [
		{ k: "org", n: rep.org.doctype || "Organisation" },
		{ k: "contact", n: "Contact" },
		{ k: "address", n: "Address" }
	].map(function (r) {
		var p = rep[r.k];
		var msg;
		if (p.state === "created") {
			msg = "created as <i>" + esc(p.name) + "</i>" +
				(p.verified ? ", confirmed in ERPNext" : " — could not be read back");
		} else if (p.state === "duplicate") {
			msg = "already in ERPNext as <i>" + esc(p.name) + "</i>, left untouched";
		} else if (p.state === "error") {
			msg = (p.errors || []).map(function (e) { return esc(e.message); }).join(" ");
		} else {
			msg = "switched off";
		}
		/* values that had to be changed or left out to get the record accepted */
		(p.notes || []).forEach(function (n) {
			msg += '<span class="note">' + esc(n.message) + "</span>";
		});
		/* the photo hangs off the contact, so its outcome belongs on that line */
		if (r.k === "contact" && rep.file && rep.file.state !== "off") {
			if (rep.file.state === "created") {
				msg += '<span class="note att" style="color:#1f8a4c">\u2713 card photo attached</span>';
			} else {
				msg += '<span class="note att" style="color:var(--err)">\u2715 the card photo could not be attached: ' +
					esc((rep.file.errors && rep.file.errors[0] && rep.file.errors[0].message) || "") +
					"</span>";
			}
		}
		var state = p.state === "working" ? "error" : p.state;
		return "<div>" + tickHtml(p) + "<b>" + esc(r.n) + '</b><span class="s ' + state + '">' +
			(p.state === "off" ? "skipped" : esc(p.state)) + '</span><span class="m">' +
			msg + "</span></div>";
	}).join("");
	return (label ? '<p class="hint" style="margin-top:12px"><b>' + esc(label) + "</b></p>" : "") +
		'<div class="rep">' + rows + "</div>";
}

/* Marks the boxes ERPNext complained about. */
function markErrors(rep) {
	["org", "contact", "address"].forEach(function (k) {
		(rep[k].errors || []).forEach(function (e) {
			if (e.field) fieldNote(e.field, e.message);
		});
		/* a value that had to be dropped is worth marking too */
		(rep[k].notes || []).forEach(function (n) {
			if (n.field) fieldNote(n.field, n.message);
		});
	});
}

function repOk(rep) {
	if (rep.fatal) return false;
	return ["org", "contact", "address"].every(function (k) {
		return rep[k].state !== "error";
	});
}

/* Everything the sync layer needs from a card, already standardised.
   `imageName` is the file the photo was stored under, so the picture can be
   attached to the contact once it exists. */
function syncPayload(f, imageName) {
	var r = NORM.normalizeCard(f);
	var out = {};
	FIELDS.forEach(function (k) { out[k] = f[k] || ""; });
	Object.keys(r.changed).forEach(function (k) { out[k] = r.changed[k]; });
	out.newsletter = !!f.newsletter;
	out.is_primary = !!S.primary;
	out.status = S.status || "Open";
	out.address_type = S.atype || "Office";
	out.country_field = r.country_field;
	out.territory = r.territory;
	out.notes_norm = r.notes;
	out.card_image = "";
	if (imageName && S.erp_attach !== false) {
		try { out.card_image = A.readCardImage(imageName) || ""; } catch (e) { out.card_image = ""; }
	}
	return out;
}

function syncOne() {
	var f = readForm();
	var want = {
		org: $("f-sync_org").checked ? $("f-sync_doctype").value : "",
		contact: $("f-sync_contact").checked,
		address: $("f-sync_address").checked
	};
	if (!want.org && !want.contact && !want.address) {
		toast("Switch on at least one of the three.", "err");
		return;
	}
	var bad = ERP.ready();
	if (bad) { toast(bad, "err"); show("set"); return; }

	clearNotes();
	if (S.norm !== false) applyNormalisation(true);

	var p = syncPayload(readForm(), draft ? draft.image : "");
	if (Object.keys(p.notes_norm).length) {
		Object.keys(p.notes_norm).forEach(function (k) { fieldNote(k, p.notes_norm[k]); });
		$("sync-stat").innerHTML = '<p class="hint" style="color:var(--err)">' +
			"Sort out the flagged fields first, then send again.</p>";
		toast("Some fields still need attention.", "err");
		return;
	}

	busy($("btn-sync-one"), true, "Sending…");
	$("sync-stat").innerHTML = "";
	ERP.syncCard(p, want, p.territory).then(function (rep) {
		busy($("btn-sync-one"), false, "Send this card to ERPNext");
		$("sync-stat").innerHTML = reportHtml(rep, "");
		markErrors(rep);
		if (repOk(rep)) {
			if (draft && draft.index >= 0) {
				cards[draft.index].synced = new Date().toISOString().slice(0, 16).replace("T", " ");
				saveCards();
			}
			toast("Sent to ERPNext.", "good");
		} else {
			toast("ERPNext refused part of this card — see the marked fields.", "err");
		}
	}).catch(function (e) {
		busy($("btn-sync-one"), false, "Send this card to ERPNext");
		$("sync-stat").innerHTML = '<p class="hint" style="color:var(--err)">' +
			esc(e.message || e) + "</p>";
		toast(e.message || String(e), "err");
	});
}

function syncAll() {
	var bad = ERP.ready();
	if (bad) { toast(bad, "err"); show("set"); return; }
	var picked = [];
	cards.forEach(function (c, i) { if (c.sel !== false) picked.push(i); });
	if (!picked.length) { toast("No cards ticked.", "err"); return; }

	var stat = $("bulk-stat");
	stat.innerHTML = "";
	busy($("btn-sync-all"), true, "Syncing…");

	var done = 0, failed = 0, blocked = 0;

	function next() {
		if (!picked.length) {
			busy($("btn-sync-all"), false, "Sync selected cards");
			saveCards();
			paintList();
			var sum = done + " card(s) sent" +
				(failed ? ", " + failed + " refused" : "") +
				(blocked ? ", " + blocked + " need fixing first" : "") + ".";
			stat.insertAdjacentHTML("afterbegin", '<p class="hint"><b>' + esc(sum) + "</b></p>");
			toast(sum, failed || blocked ? "err" : "good");
			return;
		}
		var i = picked.shift();
		var c = cards[i];
		var pref = syncPrefs(c);
		var want = { org: pref.org ? pref.doctype : "", contact: pref.contact,
			address: pref.address };
		var title = cardTitle(c);

		if (!want.org && !want.contact && !want.address) {
			stat.insertAdjacentHTML("beforeend",
				'<p class="hint">' + esc(title) + " — all three switches off, skipped.</p>");
			setTimeout(next, 0);
			return;
		}

		var p = syncPayload(c, c.image || "");
		if (Object.keys(p.notes_norm).length) {
			blocked++;
			var list = Object.keys(p.notes_norm).map(function (k) {
				return esc(p.notes_norm[k]);
			}).join("<br>");
			stat.insertAdjacentHTML("beforeend",
				'<p class="hint" style="color:var(--err)"><b>' + esc(title) +
				"</b><br>" + list + " Open the card to fix it.</p>");
			setTimeout(next, 0);
			return;
		}

		ERP.syncCard(p, want, p.territory).then(function (rep) {
			stat.insertAdjacentHTML("beforeend", reportHtml(rep, title));
			if (repOk(rep)) {
				done++;
				c.synced = new Date().toISOString().slice(0, 16).replace("T", " ");
			} else { failed++; }
			next();
		}).catch(function (e) {
			failed++;
			stat.insertAdjacentHTML("beforeend",
				'<p class="hint" style="color:var(--err)"><b>' + esc(title) + "</b><br>" +
				esc(e.message || e) + "</p>");
			next();
		});
	}
	next();
}

function testErp() {
	grabSettings(true);
	var bad = ERP.ready();
	if (bad) { $("erp-test").innerHTML = '<p class="hint" style="color:var(--err)">' +
		esc(bad) + "</p>"; return; }
	busy($("btn-erp-test"), true, "Checking…");
	ERP.testConnection().then(function (v) {
		busy($("btn-erp-test"), false, "Test the connection");
		paintCountryList();
		var okHtml = '<p class="hint" style="color:#1f8a4c">Connected — the credentials were accepted. ' +
			v.territories + " territories and " + v.countries +
			" countries read from your instance — country names will now be matched against those.</p>";
		if (v.unreadable && v.unreadable.length) {
			okHtml = '<p class="hint" style="color:#1f8a4c">Connected — the credentials were accepted.</p>' +
				'<p class="hint" style="color:var(--violet)">This user is not allowed to read ' +
				esc(v.unreadable.join(" and ")) + ", so country/territory names are matched against the " +
				"built-in lists instead. Records that need those lists may be refused when sent — give the " +
				"API user a role with read access to them (ERPNext: User \u2192 Roles).</p>";
		}
		$("erp-test").innerHTML = okHtml;
		toast("ERPNext connection works.", "good");
	}).catch(function (e) {
		busy($("btn-erp-test"), false, "Test the connection");
		var m = (e.errors && e.errors[0] && e.errors[0].message) || e.message || String(e);
		$("erp-test").innerHTML = '<p class="hint" style="color:var(--err)">' + esc(m) + "</p>";
		toast(m, "err");
	});
}

// ----------------------------------------------------------------------- wire
function wire() {
	Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
		b.onclick = function () { show(b.dataset.v); };
	});

	$("btn-cam").onclick = function () { busy($("btn-cam"), true, "Opening the camera…"); A.takePhoto(); };
	$("btn-pick").onclick = function () { busy($("btn-pick"), true, "Opening the gallery…"); A.pickPhoto(); };

	$("btn-reparse").onclick = function () {
		var txt = $("f-raw_text").value;
		var f = parseCard(txt);
		if (!f.country) f.country = S.country;
		var keep = readForm();
		f.link_doctype = keep.link_doctype; f.link_name = keep.link_name; f.notes = keep.notes;
		f.thumb = draft ? draft.thumb : "";
		fillForm(f);
		toast("Parsed again.", "good");
	};

	$("btn-ai").onclick = function () { aiCleanup(false); };

	$("btn-save").onclick = function () {
		var f = readForm();
		if (!f.first_name && !f.last_name && !f.company_name && !f.email) {
			toast("Fill in at least a name, a company or an email.", "err");
			return;
		}
		var rec = {};
		FIELDS.forEach(function (k) { rec[k] = f[k] || ""; });
		rec.newsletter = !!f.newsletter;
		rec.sync_doctype = f.sync_doctype;
		rec.sync_org = !!f.sync_org;
		rec.sync_contact = !!f.sync_contact;
		rec.sync_address = !!f.sync_address;
		rec.linkedin_guess = !!(f.linkedin && f.linkedin_guess);
		rec.image = draft ? draft.image : "";
		rec.thumb = draft ? draft.thumb : "";
		rec.sel = true;
		if (draft && draft.index >= 0) {
			rec.created = cards[draft.index].created;
			rec.exported = cards[draft.index].exported;
			rec.synced = cards[draft.index].synced;
			rec.sel = cards[draft.index].sel !== false;
			cards[draft.index] = rec;
			toast("Card updated.", "good");
		} else {
			rec.created = new Date().toISOString().slice(0, 16).replace("T", " ");
			cards.unshift(rec);
			toast("Card saved.", "good");
		}
		saveCards();
		closeForm();
		show("cards");
	};

	$("btn-cancel").onclick = function () {
		if (draft && draft.index < 0 && draft.image) A.deleteCardImage(draft.image);
		closeForm();
		toast("Discarded.");
	};

	$("btn-all").onclick = function () { cards.forEach(function (c) { c.sel = true; }); saveCards(); paintList(); };
	$("btn-none").onclick = function () { cards.forEach(function (c) { c.sel = false; }); saveCards(); paintList(); };

	$("btn-export").onclick = doExport;
	$("btn-share").onclick = function () {
		if (!lastUris.length) return;
		A.shareFiles(JSON.stringify(lastUris), "Card Scanner export");
	};
	$("btn-mark").onclick = function () {
		var n = 0;
		cards.forEach(function (c) { if (c.sel !== false) { c.exported = true; c.sel = false; n++; } });
		saveCards();
		toast(n + " card(s) marked as exported.", "good");
	};
	$("btn-del").onclick = function () {
		var keep = [], gone = 0;
		cards.forEach(function (c) {
			if (c.sel !== false) { if (c.image) A.deleteCardImage(c.image); gone++; }
			else keep.push(c);
		});
		if (!gone) { toast("Nothing selected.", "err"); return; }
		if (!confirm("Delete " + gone + " selected card(s)? This cannot be undone.")) return;
		cards = keep;
		saveCards();
		paintList();
		toast(gone + " card(s) deleted.", "good");
	};

	$("btn-save-set").onclick = function () { grabSettings(false); };

	// A typed or corrected LinkedIn address is no longer a model guess.
	$("f-linkedin").addEventListener("input", function () { liNote(""); });

	// ------------------------------------------------ standardising and ERPNext
	$("btn-norm").onclick = function () { applyNormalisation(false); };
	$("btn-sync-one").onclick = syncOne;
	$("btn-sync-all").onclick = syncAll;
	$("btn-erp-test").onclick = testErp;
	$("s-erp-mode").addEventListener("change", erpModeUi);
	$("f-country").addEventListener("input", function () {
		var t = NORM.normCountry($("f-country").value);
		paintRegionList(t.ok ? t.value : "");
	});

	installMoveGesture();
}

loadState();
ERP.configure(S);
wire();
if (window.CS_DOCSCAN) window.CS_DOCSCAN.init();
paintCountryList();
paintSettings();
paintCount();
paintList();
window.CS = { parseCard: parseCard, doExport: doExport, cards: function () { return cards; },
	addCard: function (c) { cards.unshift(c); saveCards(); }, settings: function () { return S; },
	normLinkedIn: normLinkedIn,
	/* image/thumb let a caller that already has a picture (e.g. the desktop
	   shell's Claude-vision card reading, which has no OCR step to go
	   through onScan/parseCard) open the review form with it attached. */
	showDraft: function (f, image, thumb) { newDraft(f, image || "", thumb || ""); },
	normCountry: NORM.normCountry, normRegion: NORM.normRegion, normPhone: NORM.normPhone,
	normalizeCard: NORM.normalizeCard, applyNormalisation: applyNormalisation,
	syncPayload: syncPayload, erp: ERP, geo: GEO,
	reportHtml: reportHtml, tickHtml: tickHtml };
})();
