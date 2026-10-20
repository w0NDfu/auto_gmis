import {test} from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import http from "node:http";
import {AccountManager} from "../manager.js";
import {createServer} from "../server.js";
import "./integration.js";
import "./login.test.js";
import "./sso.test.js";
import "./sso-form.test.js";
import "./identity.test.js";
import "./operations.test.js";
import "./tasks.test.js";
import {LeaseKeeper} from "../../gmis-extension/run-heartbeat.js";

function harness(options) {
  const contexts = [], requests = [];
  const manager = new AccountManager(async () => ({
    newContext: async () => {
      const index = contexts.length;
      const context = {index, closed: false, cookie: "cookie-" + index,
        newPage: async () => ({setDefaultTimeout() {}, on() {}}),
        close: async () => { context.closed = true; },
        request: {fetch: async (url, options) => {
          requests.push({index, cookie: context.cookie, url, options});
          return {status: () => 200, ok: () => true, headers: () => ({"content-type": "application/json"}),
            json: async () => ({rows: [{hdid: index}]}), dispose: async () => {}};
        }}};
      contexts.push(context); return context;
    }, close: async () => {}
  }), options);
  const add = async username => {
    const account = await manager.create({username, password: "mock-password", label: "测试账号"});
    manager.get(account.id).ready = true; return account;
  };
  return {manager, contexts, requests, add};
}
test("accounts use distinct browser contexts and context-bound request cookies", async () => {
  const h = harness(); const [a, b] = await Promise.all([h.add("DEMO0001"), h.add("DEMO0002")]);
  assert.equal(h.contexts.length, 2); assert.notEqual(h.contexts[0], h.contexts[1]);
  await Promise.all([a, b].map(a => h.manager.request(a.id, {category: "academic", operation: "available"})));
  assert.deepEqual(h.requests.map(r => r.cookie).sort(), ["cookie-0", "cookie-1"]);
  assert.ok(h.requests.every(r => r.url.endsWith("xshdbm_sqlist")));
  assert.ok(!JSON.stringify(h.manager.list()).includes("mock-password"));
  assert.ok(!JSON.stringify(h.manager.list()).includes("DEMO0001"));
});
test("same-account operations serialize while other accounts remain concurrent", async () => {
  const h = harness(), a = await h.add("DEMO0001"), b = await h.add("DEMO0002");
  let release; const barrier = new Promise(r => { release = r; }); const seen = [];
  const first = h.manager.serial(a.id, async () => { seen.push("a1"); await barrier; seen.push("a1done"); });
  const second = h.manager.serial(a.id, () => { seen.push("a2"); });
  await h.manager.serial(b.id, () => { seen.push("b1"); });
  assert.deepEqual(seen, ["a1", "b1"]); release(); await Promise.all([first, second]);
  assert.deepEqual(seen, ["a1", "b1", "a1done", "a2"]);
});

test("same-account lists use at most two readers; captcha/write operations wait for readers and block later reads", async () => {
  const h = harness(), a = await h.add("DEMO0001");
  const seen = []; let releaseReaders, releaseWriter, active = 0, peak = 0;
  const readers = new Promise(r => { releaseReaders = r; }), writer = new Promise(r => { releaseWriter = r; });
  const read = n => h.manager.read(a.id, async () => { active++; peak = Math.max(peak, active); seen.push(n); await readers; active--; });
  const first = read("read1"), second = read("read2");
  const exclusive = h.manager.serial(a.id, async () => { assert.equal(active, 0); seen.push("write"); await writer; });
  const third = read("read3");
  await new Promise(setImmediate); assert.deepEqual(seen, ["read1", "read2"]);
  releaseReaders(); await new Promise(setImmediate);
  assert.deepEqual(seen, ["read1", "read2", "write"]);
  releaseWriter(); await Promise.all([first, second, exclusive, third]);
  assert.deepEqual(seen, ["read1", "read2", "write", "read3"]); assert.equal(peak, 2);
});

test("both real list routes overlap while same-account submits remain exclusive", async () => {
  const h = harness(), a = await h.add("DEMO0001"), {runId} = h.manager.start(a.id);
  let release, active = 0, peak = 0;
  const barrier = new Promise(r => { release = r; });
  const fetch = h.contexts[0].request.fetch;
  h.contexts[0].request.fetch = async (...args) => { active++; peak = Math.max(peak, active); await barrier; const result = await fetch(...args); active--; return result; };
  const queries = ["labour", "academic"].map(category => h.manager.request(a.id, {category, operation:"available", runId}));
  await new Promise(setImmediate); assert.equal(peak, 2); release(); await Promise.all(queries);
  assert.equal(h.requests.length, 2);
});
test("stop immediately invalidates a queued submit without waiting for the queue", async () => {
  const h = harness(), a = await h.add("DEMO0001"), {runId} = h.manager.start(a.id);
  let release; const blocked = h.manager.serial(a.id, () => new Promise(r => { release = r; }));
  await Promise.resolve();
  const pending = h.manager.request(a.id, {category: "labour", operation: "submit", data: {id: 1, VeriCode: "1234"}, runId});
  h.manager.stop(a.id, runId); release(); await blocked;
  await assert.rejects(pending, error => error.code === "RUN_EXPIRED");
  assert.equal(h.requests.length, 0);
});
test("leases expire and old console stop commands cannot cancel a new run", async () => {
  let now = 0; const h = harness({now: () => now, leaseMs: 100}), a = await h.add("DEMO0001");
  const old = h.manager.start(a.id).runId;
  assert.throws(() => h.manager.start(a.id), /已有任务/);
  now = 101;
  await assert.rejects(h.manager.request(a.id, {category: "labour", operation: "captcha", runId: old}), cause => cause.code === "RUN_EXPIRED" && /续租超时/.test(cause.message));
  const next = h.manager.start(a.id).runId; h.manager.stop(a.id, old);
  assert.equal(h.manager.heartbeat(a.id, next).alive, true);
});

test("worker heartbeat keeps real account lease active beyond five minutes without page timers, then stops immediately", async () => {
  let now = 0;
  const h = harness({now: () => now}), account = await h.add("DEMO0001"), run = h.manager.start(account.id);
  assert.equal(run.leaseMs, 180000);
  const keeper = new LeaseKeeper({now: () => now, notify: () => {}, schedule: () => 1, unschedule: () => {},
    call: async (path, args) => path === "/runs/heartbeat" ? h.manager.heartbeat(args.id, args.runId) : h.manager.stop(args.id, args.runId)});
  await keeper.start({id: account.id, runId: run.runId});
  for (let n = 0; n < 90; n++) { now += 10000; await keeper.pulse(); assert.doesNotThrow(() => h.manager.validateRun(h.manager.get(account.id), run.runId)); }
  await keeper.close();
  assert.throws(() => h.manager.heartbeat(account.id, run.runId), cause => cause.code === "RUN_EXPIRED");
});

test("an expired or stopped run is never revived by a delayed heartbeat", async () => {
  let now = 0;
  const h = harness({now: () => now}), account = await h.add("DEMO0001"), run = h.manager.start(account.id);
  now = 180001;
  assert.throws(() => h.manager.heartbeat(account.id, run.runId), /最近 180 秒/);
  const next = h.manager.start(account.id); h.manager.stop(account.id, next.runId);
  assert.throws(() => h.manager.heartbeat(account.id, next.runId), cause => cause.code === "RUN_EXPIRED");
});
test("duplicate accounts are rejected even during concurrent creation", async () => {
  const h = harness();
  const results = await Promise.allSettled([h.add("DEMO0001"), h.add("DEMO0001")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(h.contexts.length, 1);
});
test("removal requires stopped tasks and closes the account context", async () => {
  const h = harness(), a = await h.add("DEMO0001"), {runId} = h.manager.start(a.id);
  await assert.rejects(h.manager.remove(a.id), /先停止/);
  h.manager.stop(a.id, runId); await h.manager.remove(a.id);
  assert.equal(h.contexts[0].closed, true); assert.equal(h.manager.list().length, 0);
});
test("request routing never accepts arbitrary URLs or malformed submission data", async () => {
  const h = harness(), a = await h.add("DEMO0001"), {runId} = h.manager.start(a.id);
  for (const args of [
    {category: "__proto__", operation: "available"},
    {category: "labour", operation: "https://example.org"},
    {category: "labour", operation: "submit", data: {id: "../../admin", VeriCode: "1234"}},
    {category: "labour", operation: "submit", data: {id: 1, VeriCode: "12"}}
  ]) await assert.rejects(h.manager.request(a.id, {...args, runId}));
  assert.equal(h.requests.length, 0);
});
test("academic preflight is GET and submission is a context-specific form POST", async () => {
  const h = harness(), a = await h.add("DEMO0001"), {runId} = h.manager.start(a.id);
  await h.manager.request(a.id, {category: "academic", operation: "preflight", data: {id: 42}, runId});
  await h.manager.request(a.id, {category: "academic", operation: "submit", data: {id: 42, VeriCode: "1234"}, runId});
  assert.equal(h.requests[0].options.method, "GET");
  assert.ok(h.requests[0].url.endsWith("xshdbm_sfkysq?id=42"));
  assert.equal(h.requests[1].options.method, "POST");
  assert.deepEqual(h.requests[1].options.form, {id: "42", VeriCode: "1234"});
});
test("HTTP helper requires pairing, restricts Origin/Host, and never launches Chrome for health", async () => {
  let launched = 0;
  const manager = new AccountManager(async () => { launched++; throw new Error("unexpected browser"); });
  const server = createServer(manager, "test-pair-token", {port: 0});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = "http://127.0.0.1:" + server.address().port + "/health";
  const headers = {"Content-Type": "application/json", "Authorization": "Bearer test-pair-token", "Origin": "chrome-extension://" + "a".repeat(32)};
  try {
    assert.equal((await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"})).status, 401);
    assert.equal((await fetch(url, {method: "POST", headers: {...headers, Origin: "https://untrusted.example"}, body: "{}"})).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.request(url, {method: "POST", headers: {...headers, Host: "evil.example"}}, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(badHostStatus, 403);
    const response = await fetch(url, {method: "POST", headers, body: "{}"});
    assert.equal(response.status, 200); assert.equal((await response.json()).data.version, "0.5.0");
    assert.equal(response.headers.get("access-control-allow-origin"), headers.Origin);
    assert.equal(launched, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("HTTP login timeout returns an actionable stage rather than the old generic Chrome/network failure", async () => {
  const manager = {login: async () => { throw Object.assign(new Error("locator.click: Timeout 15000ms exceeded. Call log: mock-secret private-ticket"), {name: "TimeoutError"}); }};
  const server = createServer(manager, "test-token", {port: 0});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/login/submit", {method: "POST",
      headers: {"Content-Type": "application/json", Authorization: "Bearer test-token"}, body: JSON.stringify({id: "a", code: "1234"})});
    const body = await response.json();
    assert.equal(response.status, 400); assert.equal(body.code, "STEP_TIMEOUT");
    assert.ok(body.error.includes("登录账号超时"));
    assert.ok(!/mock-secret|private-ticket|Chrome 是否|Call log/.test(JSON.stringify(body)));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
