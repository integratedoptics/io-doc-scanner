const http = require("http");
const { request } = require("../electron/app/http.js");
let fails = 0;
function check(l, c) { if (c) console.log("ok   " + l); else { fails++; console.log("FAIL " + l); } }

const seen = {};
const target = http.createServer((req, res) => {
  seen[req.url] = req.headers.authorization || null;
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

    console.log(fails ? fails + " failed" : "all passed");
    process.exit(fails ? 1 : 0);
  });
});
