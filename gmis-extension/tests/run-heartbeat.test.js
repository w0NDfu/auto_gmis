import {test} from "node:test";
import assert from "node:assert/strict";
import {LeaseKeeper, RunHeartbeat} from "../run-heartbeat.js";

function host(call) {
  let now = 0, tick, cleared = 0;
  const messages = [], calls = [];
  const keeper = new LeaseKeeper({call: async (path, args) => { calls.push({path, args}); return call?.(path, args); },
    notify: message => messages.push(message), now: () => now,
    schedule: callback => { tick = callback; return 1; }, unschedule: () => { cleared++; }});
  return {keeper, messages, calls, cleared: () => cleared, advance: async ms => { now += ms; tick(); await new Promise(setImmediate); }};
}
test("worker renews for thirty minutes without any console timer and closes its lease immediately", async () => {
  const h = host(); await h.keeper.start({id: "a", runId: "r"});
  for (let n = 0; n < 180; n++) await h.advance(10000);
  assert.equal(h.calls.filter(c => c.path === "/runs/heartbeat").length, 181);
  assert.equal(h.messages.filter(m => m.type === "tick").length, 181);
  await h.keeper.close(); await h.advance(10000);
  assert.equal(h.cleared(), 1); assert.equal(h.calls.at(-1).path, "/runs/stop");
  assert.ok(h.calls.every(c => c.args.id === "a" && c.args.runId === "r"));
});
test("one transient transport failure recovers without stopping the account", async () => {
  let calls = 0;
  const h = host(async path => { if (path === "/runs/heartbeat" && ++calls === 2) throw Object.assign(new Error("offline"), {code: "HELPER_UNAVAILABLE"}); });
  await h.keeper.start({id: "a", runId: "r"}); await h.advance(10000); await h.advance(10000);
  assert.deepEqual(h.messages.filter(m => m.type !== "tick").map(m => m.type), ["ready", "retrying", "recovered"]);
  assert.equal(h.keeper.closed, false); await h.keeper.close();
});
test("three transport failures stop and revoked leases never silently restart", async () => {
  for (const code of ["HELPER_UNAVAILABLE", "RUN_EXPIRED"]) {
    let calls = 0;
    const h = host(async path => { if (path === "/runs/heartbeat" && ++calls > 1) throw Object.assign(new Error("failed"), {code}); });
    await h.keeper.start({id: "a", runId: "r"});
    for (let n = 0; n < 3; n++) await h.advance(10000);
    assert.equal(h.keeper.closed, true); assert.equal(h.messages.at(-1).type, "failed");
    assert.equal(h.calls.at(-1).path, "/runs/stop");
    assert.equal(h.calls.some(c => c.path === "/runs/start"), false);
    if (code === "RUN_EXPIRED") assert.equal(calls, 2);
  }
});
test("a slow heartbeat cannot overlap; closing during it ignores its late response", async () => {
  let release;
  const h = host(path => path === "/runs/heartbeat" ? new Promise(resolve => { release = resolve; }) : undefined);
  const start = h.keeper.start({id: "a", runId: "r"}); await h.advance(10000);
  assert.equal(h.calls.filter(c => c.path === "/runs/heartbeat").length, 1);
  await h.keeper.close(); release(); await start;
  assert.equal(h.messages.some(m => m.type === "ready"), false);
});

function consolePort() {
  const event = () => ({listeners: [], addListener(listener) { this.listeners.push(listener); }, emit(message) { this.listeners.forEach(listener => listener(message)); }});
  const sent = [], failed = [], notices = [];
  const port = {onMessage: event(), onDisconnect: event(), postMessage: message => sent.push(message), disconnect() { this.onDisconnect.emit(); }};
  const heartbeat = new RunHeartbeat({runtime: {connect: () => port}, onFailure: error => failed.push(error), onNotice: message => notices.push(message)});
  return {heartbeat, port, sent, failed, notices};
}
test("console waits for worker acknowledgement and reports genuine lease failure distinctly", async () => {
  const h = consolePort(), ready = h.heartbeat.start({token: "memory-only", id: "a", runId: "r"});
  h.port.onMessage.emit({type: "tick"}); h.port.onMessage.emit({type: "ready"}); await ready;
  assert.deepEqual(h.sent.map(m => m.type), ["start", "pong"]);
  h.port.onMessage.emit({type: "failed", code: "RUN_EXPIRED", message: "任务续租超时"});
  assert.equal(h.failed.length, 1); assert.equal(h.failed[0].code, "RUN_EXPIRED");
  assert.equal(h.failed[0].message, "任务续租超时");
});
test("stopping while worker startup is pending settles the promise instead of hanging the job", async () => {
  const h = consolePort(), ready = h.heartbeat.start({token: "t", id: "a", runId: "r"});
  h.heartbeat.close(); await assert.rejects(ready, /任务已停止/);
  assert.equal(h.failed.length, 0);
});

test("actual service-worker wiring admits only its own console and revokes a disconnected port's lease", async t => {
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
  const event = () => ({listeners: [], addListener(callback) { this.listeners.push(callback); }, emit(value) { this.listeners.forEach(callback => callback(value)); }});
  const onConnect = event(), onClicked = event(), calls = [];
  globalThis.chrome = {runtime: {id: "own-extension", getURL: path => "chrome-extension://own-extension/" + path, onConnect}, action: {onClicked}};
  globalThis.fetch = async (url, options) => { calls.push({url, options}); return {ok: true, json: async () => ({ok: true, data: {alive: true}})}; };
  await import("../background.js");
  function port(sender) {
    return {name: "gmis-run-heartbeat", sender, messages: [], disconnected: false, onMessage: event(), onDisconnect: event(),
      postMessage(message) { this.messages.push(message); }, disconnect() { this.disconnected = true; this.onDisconnect.emit(); }};
  }
  const wrong = port({id: "other-extension", url: "chrome-extension://own-extension/multi.html"});
  onConnect.emit(wrong); assert.equal(wrong.disconnected, true); assert.equal(calls.length, 0);
  const web = port({id: "own-extension", url: "https://untrusted.example"}); onConnect.emit(web); assert.equal(web.disconnected, true);
  const own = port({id: "own-extension", url: "chrome-extension://own-extension/multi.html"});
  t.after(() => own.disconnect()); onConnect.emit(own);
  own.onMessage.emit({type: "start", token: "paired-token", id: "account-1", runId: "run-1"});
  await new Promise(setImmediate);
  assert.ok(own.messages.some(message => message.type === "ready"));
  assert.equal(calls[0].url, "http://127.0.0.1:8767/runs/heartbeat");
  assert.equal(calls[0].options.headers.Authorization, "Bearer paired-token");
  own.disconnect(); await new Promise(setImmediate);
  assert.equal(calls.at(-1).url, "http://127.0.0.1:8767/runs/stop");
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {id: "account-1", runId: "run-1"});
});
