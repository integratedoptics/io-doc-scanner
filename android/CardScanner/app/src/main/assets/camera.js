/* camera.js — a small live-camera overlay for shells that have a webcam but
   no native capture screen (the Windows/macOS desktop app, or the page opened
   in a browser). Phones use their own camera app instead, via the native
   bridge, so this is never shown there.

     CS_CAMERA.available()                 -> true if the browser can open a camera
     CS_CAMERA.open({ title, hint })       -> Promise<dataUrl | null>
                                              (null = the user cancelled)

   The picture is returned as a JPEG data URL, its long edge capped at 2400 px
   so it stays well under the 5 MB limit of the reading service while text on
   an invoice or a card is still sharp. */
window.CS_CAMERA = (function () {
"use strict";

var MAX_EDGE = 2400;

function available() {
	return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function friendly(e) {
	var n = e && e.name;
	if (n === "NotAllowedError" || n === "SecurityError") {
		return "Camera access was refused. On a Mac: System Settings → Privacy & Security → Camera, " +
			"switch it on for this app (when started with npm it is listed as “Electron”), then try again.";
	}
	if (n === "NotFoundError" || n === "OverconstrainedError" || n === "DevicesNotFoundError") {
		return "No camera was found on this computer.";
	}
	if (n === "NotReadableError" || n === "TrackStartError") {
		return "The camera is being used by another application. Close it and try again.";
	}
	return "Could not open the camera: " + ((e && e.message) || e);
}

function el(tag, css, text) {
	var e = document.createElement(tag);
	if (css) e.style.cssText = css;
	if (text) e.textContent = text;
	return e;
}

var BTN = "font:600 15px system-ui,sans-serif;border:0;border-radius:10px;padding:12px 22px;cursor:pointer;";

/* shrink(dataUrl, maxEdge) -> Promise<dataUrl>: re-encode a picture as a JPEG whose
   long edge is at most maxEdge. Photos straight from a phone or a camera folder can be
   10 MB or more; the reading service accepts at most 5 MB per picture. */
function shrink(dataUrl, maxEdge) {
	maxEdge = maxEdge || MAX_EDGE;
	return new Promise(function (resolve, reject) {
		var img = new Image();
		img.onload = function () {
			var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, maxEdge / Math.max(w, h));
			var c = document.createElement("canvas");
			c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
			c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
			resolve(c.toDataURL("image/jpeg", 0.88));
		};
		img.onerror = function () { reject(new Error("That picture could not be opened.")); };
		img.src = dataUrl;
	});
}

function open(opts) {
	opts = opts || {};
	/* a shell may ask the operating system for camera permission first (macOS) */
	var before = typeof window.CS_CAMERA_BEFORE === "function"
		? Promise.resolve().then(function () { return window.CS_CAMERA_BEFORE(); }) : Promise.resolve(true);
	return before.then(function (allowed) {
		if (allowed === false) {
			throw new Error("Camera access is switched off for this app. On a Mac: System Settings \u2192 " +
				"Privacy & Security \u2192 Camera, switch it on for this app (when started with npm it is listed as " +
				"\u201cElectron\u201d), then try again.");
		}
		return openOverlay(opts);
	});
}

function openOverlay(opts) {
	return new Promise(function (resolve, reject) {
		if (!available()) { reject(new Error("This computer has no camera access in this app.")); return; }

		var stream = null, shot = "", done = false;

		var wrap = el("div", "position:fixed;inset:0;z-index:99999;background:#000;display:flex;flex-direction:column;" +
			"align-items:center;justify-content:center;color:#fff;font-family:system-ui,sans-serif;");
		var title = el("div", "font:600 16px system-ui,sans-serif;padding:10px 16px;text-align:center;", opts.title || "Take a picture");
		var hint = el("div", "font:13px system-ui,sans-serif;color:#bbb;padding:0 16px 8px;text-align:center;max-width:560px;",
			opts.hint || "");
		var stage = el("div", "position:relative;flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center;");
		var video = el("video", "max-width:100%;max-height:100%;background:#111;");
		video.setAttribute("playsinline", ""); video.muted = true; video.autoplay = true;
		var still = el("img", "max-width:100%;max-height:100%;display:none;");
		var msg = el("div", "position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;" +
			"font:14px system-ui,sans-serif;padding:0 20px;color:#ddd;", "Starting the camera…");
		stage.appendChild(video); stage.appendChild(still); stage.appendChild(msg);

		var bar = el("div", "display:flex;gap:12px;align-items:center;justify-content:center;padding:14px;flex-wrap:wrap;");
		var sel = el("select", "font:14px system-ui,sans-serif;padding:8px;border-radius:8px;max-width:240px;display:none;");
		var bShoot = el("button", BTN + "background:#fa9d11;color:#000;", "Take picture");
		var bRetake = el("button", BTN + "background:#444;color:#fff;display:none;", "Retake");
		var bUse = el("button", BTN + "background:#fa9d11;color:#000;display:none;", "Use this picture");
		var bCancel = el("button", BTN + "background:#333;color:#fff;", "Cancel");
		[sel, bShoot, bRetake, bUse, bCancel].forEach(function (x) { bar.appendChild(x); });

		wrap.appendChild(title); wrap.appendChild(hint); wrap.appendChild(stage); wrap.appendChild(bar);
		document.body.appendChild(wrap);

		function stop() {
			if (stream) { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); stream = null; }
		}
		function finish(value, err) {
			if (done) return;
			done = true;
			document.removeEventListener("keydown", onKey, true);
			stop();
			if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
			if (err) reject(err); else resolve(value);
		}
		function onKey(ev) {
			if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
			else if ((ev.key === " " || ev.key === "Enter") && document.activeElement && document.activeElement.tagName !== "SELECT") {
				ev.preventDefault();
				if (shot) bUse.click(); else bShoot.click();
			}
		}
		document.addEventListener("keydown", onKey, true);

		function start(deviceId) {
			stop();
			msg.style.display = ""; msg.textContent = "Starting the camera…";
			var video_c = { width: { ideal: 3840 }, height: { ideal: 2160 } };
			if (deviceId) video_c.deviceId = { exact: deviceId };
			navigator.mediaDevices.getUserMedia({ video: video_c, audio: false }).then(function (s) {
				if (done) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
				stream = s;
				video.srcObject = s;
				var p = video.play(); if (p && p.catch) p.catch(function () { /* autoplay is already on */ });
				msg.style.display = "none";
				return navigator.mediaDevices.enumerateDevices().then(function (list) {
					var cams = list.filter(function (d) { return d.kind === "videoinput"; });
					if (cams.length > 1) {
						var cur = (s.getVideoTracks()[0].getSettings() || {}).deviceId;
						sel.innerHTML = "";
						cams.forEach(function (c, i) {
							var o = document.createElement("option");
							o.value = c.deviceId; o.textContent = c.label || ("Camera " + (i + 1));
							if (c.deviceId === cur) o.selected = true;
							sel.appendChild(o);
						});
						sel.style.display = "";
					}
				});
			}).catch(function (e) {
				msg.style.display = ""; msg.textContent = friendly(e);
				bShoot.disabled = true; bShoot.style.opacity = "0.5";
			});
		}
		sel.onchange = function () { start(sel.value); };

		bShoot.onclick = function () {
			if (!video.videoWidth) return;
			var w = video.videoWidth, h = video.videoHeight, k = Math.min(1, MAX_EDGE / Math.max(w, h));
			var c = document.createElement("canvas");
			c.width = Math.round(w * k); c.height = Math.round(h * k);
			c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
			shot = c.toDataURL("image/jpeg", 0.9);
			still.src = shot; still.style.display = ""; video.style.display = "none";
			bShoot.style.display = "none"; sel.style.display = "none";
			bRetake.style.display = ""; bUse.style.display = "";
		};
		bRetake.onclick = function () {
			shot = ""; still.style.display = "none"; video.style.display = "";
			bShoot.style.display = ""; bRetake.style.display = "none"; bUse.style.display = "none";
			if (sel.options.length > 1) sel.style.display = "";
		};
		bUse.onclick = function () { finish(shot); };
		bCancel.onclick = function () { finish(null); };

		start("");
	});
}

return { available: available, open: open, shrink: shrink, _friendly: friendly };
})();
