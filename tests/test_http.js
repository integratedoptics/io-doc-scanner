const http = require("http");
const { request } = require("../electron/app/http.js");
let fails = 0;
function check(l, c) { if (c) console.log("ok   " + l); else { fails++; console.log("FAIL " + l); } }

const seen = {};
const target = http.createServer((req, res) => {
  seen[req.url] = req.headers.authorization || null;
  if (req.url === "/login") { res.setHeader("Set-Cookie", ["sid=abc123; Path=/; HttpOnly", "user_id=a%40b.c; Path=/"]); }
  if (req.url === "/logout") { res.setHeader("Set-Cookie", ["sid=; Max-Age=0; Path=/"]); }
  if (req.url === "/whoami") { res.end(JSON.stringify({ cookie: req.headers.cookie || null })); return; }
  res.end(JSON.stringify({ auth: req.headers.authorization || null, method: req.method }));
}).listen(0, "127.0.0.1", async () => {
  const tp = target.address().port;
  // redirector on a DIFFERENT port (= different origin, like http->https or apex->www)
  const redir = http.createServer((req, res) => {
    if (req.url === "/same") { res.writeHead(302, { Location: "http://127.0.0.1:" + tp + "/landed" }); res.end(); }
    else if (req.url === "/other") { res.writeHead(302, { Location: "http://localhost:" + tp + "/other-host" }); res.end(); }
    else if (req.url === "/post") { res.writeHead(307, { Location: "http://127.0.0.1:" + tp + "/post-landed" }); res.end(); }
    else if (req.url === "/loop") { res.writeHead(302, { Location: "/loop" }); res.end(); }
  }).listen(0, "127.0.0.1", async () => {
    const rp = redir.address().port;
    const H = { Authorization: "token k:s" };

    // baseline: plain fetch drops Authorization across origins (the bug)
    const plain = await fetch("http://127.0.0.1:" + rp + "/same", { headers: H });
    check("plain fetch LOSES Authorization on cross-origin redirect (the bug)", JSON.parse(await plain.text()).auth === null);

    const a = await request({ url: "http://127.0.0.1:" + rp + "/same", headers: H });
    check("same host redirect keeps Authorization", JSON.parse(a.body).auth === "token k:s");
    check("reports the hop", a.hops.length === 1 && a.finalUrl.endsWith("/landed"));

    const b = await request({ url: "http://127.0.0.1:" + rp + "/other", headers: H });
    check("redirect to an unrelated host drops Authorization", JSON.parse(b.body).auth === null);

    const c = await request({ url: "http://127.0.0.1:" + rp + "/post", method: "POST", headers: H, body: "x=1" });
    check("307 keeps method and Authorization", JSON.parse(c.body).method === "POST" && JSON.parse(c.body).auth === "token k:s");

    const d = await request({ url: "http://127.0.0.1:" + rp + "/loop", headers: H });
    check("redirect loop gives up cleanly", d.ok === false && /redirects/.test(d.error));

    const e = await request({ url: "http://127.0.0.1:1/nothing", headers: H, timeoutMs: 3000 });
    check("connection refused is an error, not a throw", e.ok === false);

    // session cookie from the login call is replayed on later calls (login mode)
    const base = "http://127.0.0.1:" + tp;
    const w0 = await request({ url: base + "/whoami" });
    check("no cookie before login", JSON.parse(w0.body).cookie === null);
    await request({ url: base + "/login", method: "POST", body: "usr=a&pwd=b" });
    const w1 = await request({ url: base + "/whoami" });
    check("session cookie is sent after login", /sid=abc123/.test(JSON.parse(w1.body).cookie) && /user_id=a%40b.c/.test(JSON.parse(w1.body).cookie));
    const w2 = await request({ url: base + "/whoami", headers: { Cookie: "own=1" } });
    check("a caller-supplied Cookie header is not overridden", JSON.parse(w2.body).cookie === "own=1");
    await request({ url: base + "/logout" });
    const w3 = await request({ url: base + "/whoami" });
    check("expired cookie is dropped", !/sid=/.test(JSON.parse(w3.body).cookie || ""));

    console.log(fails ? fails + " failed" : "all passed");
    process.exit(fails ? 1 : 0);
  });
});
