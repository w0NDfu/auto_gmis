import {test} from "node:test";
import assert from "node:assert/strict";
import {waitForIdentity} from "../identity.js";
import {AccountManager} from "../manager.js";

function harness(results, url = "https://gmis.buct.edu.cn/student/default/home") {
  let now = 0, reads = 0;
  return {page: {url: () => url, evaluate: async () => results[Math.min(reads++, results.length - 1)]},
    options: {timeout: 1000, interval: 200, now: () => now, sleep: async ms => { now += ms; }},
    reads: () => reads, elapsed: () => now};
}
test("home AJAX starts with empty identity and later fills the expected student number", async () => {
  const h = harness([{state: "pending"}, {state: "pending"}, {state: "ready", account: "DEMO0001"}]);
  assert.equal(await waitForIdentity(h.page, "DEMO0001", h.options), "DEMO0001");
  assert.equal(h.reads(), 3); assert.equal(h.elapsed(), 400);
});
test("unloaded home identity times out as missing, never as an account mismatch", async () => {
  const h = harness([{state: "pending"}]);
  await assert.rejects(waitForIdentity(h.page, "DEMO0001", h.options), error =>
    error.code === "IDENTITY_NOT_FOUND" && !error.message.includes("不一致"));
  assert.equal(h.elapsed(), 1000);
});
test("a real mismatch stops immediately and only returns masked account identifiers", async () => {
  const h = harness([{state: "pending"}, {state: "ready", account: "DEMO0002"}]);
  await assert.rejects(waitForIdentity(h.page, "DEMO0001", h.options), error =>
    error.code === "ACCOUNT_MISMATCH" && error.message.includes("DE••••01") && error.message.includes("DE••••02") &&
    !error.message.includes("DEMO0001") && !error.message.includes("DEMO0002"));
  assert.equal(h.reads(), 2);
});
test("conflicting identity fields cannot bind an account", async () => {
  const h = harness([{state: "conflict"}]);
  await assert.rejects(waitForIdentity(h.page, "DEMO0001", h.options), error => error.code === "IDENTITY_CONFLICT");
});
test("redirect to authentication is never treated as a loading student profile", async () => {
  const h = harness([{state: "pending"}], "https://sidportal.buct.edu.cn/login");
  await assert.rejects(waitForIdentity(h.page, "DEMO0001", h.options), error => error.code === "SESSION_EXPIRED");
  assert.equal(h.reads(), 0);
});
test("identity format normalization preserves matching across full-width digits and zero-width space", async () => {
  const h = harness([{state: "ready", account: "２０２６\u200b０００１"}]);
  assert.equal(await waitForIdentity(h.page, "20260001", h.options), "20260001");
});
test("manager keeps ready false until asynchronous home identity is actually verified", async () => {
  const h = harness([{state: "pending"}, {state: "ready", account: "DEMO0001"}]);
  const manager = new AccountManager(async () => {}, {identityReader: (page, expected) => waitForIdentity(page, expected, h.options)});
  const account = {id: "mock", username: "DEMO0001", label: "demo", loginMode: "direct", ready: true, page: h.page};
  const operation = manager.verifyIdentity(account);
  assert.equal(account.ready, false);
  assert.equal((await operation).ready, true); assert.equal(h.reads(), 2);
});
