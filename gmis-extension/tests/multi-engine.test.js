import {test} from "node:test";
import assert from "node:assert/strict";
import {MultiEngine, projectKey, shareReads} from "../multi-engine.js";
import {Cancelled, RetryLimitReached} from "../engine.js";

const now = Date.parse("2026-10-18T12:00:00+08:00");
const targets = ["labour", "academic"].map(category => ({id: 42, category, mc: category,
  bmkssj: "2026-10-18 12:00:00", bmjzsj: "2026-10-18 14:00:00"}));
const options = {maxAttempts: 8, intervalSeconds: .01};
function harness(mode = "success") {
  const registered = new Set(), writes = [], lists = [], states = [];
  let outstanding = false, peak = 0, reading = 0;
  const engine = new MultiEngine({now: () => now, sleep: async () => {},
    apiFor: category => ({
      available: async () => { lists.push(category); reading++; peak = Math.max(peak, reading); await Promise.resolve(); reading--; return targets.filter(t => t.category === category); },
      enrolled: async () => registered.has(category) ? [{hdid: 42}] : [],
      captcha: async () => { assert.equal(outstanding, false, "captcha transactions must not overlap"); outstanding = true; return category; },
      submit: async () => {
        assert.equal(outstanding, true); outstanding = false; writes.push(category);
        if (mode === "uncertain") throw new Error("lost response");
        if (mode === "full" && category === "labour") return {msg: "已经满额"};
        if (mode === "retry" && writes.length === 1) return {msg: "验证码错误"};
        registered.add(category); return {zt: "1"};
      }
    }), ocr: {recognize: async () => { await Promise.resolve(); return "1234"; }}, state: s => states.push(s)});
  return {engine, writes, lists, states, peak: () => peak};
}
test("mixed categories with the same numeric ID query concurrently and submit with isolated captcha transactions", async () => {
  const h = harness(); const result = await h.engine.run(targets, options);
  assert.equal(h.peak(), 2); assert.equal(result.filter(r => r.success).length, 2);
  assert.deepEqual(h.writes.sort(), ["academic", "labour"]);
  assert.equal(h.states.at(-1).phase, "success");
  assert.notEqual(projectKey(targets[0]), projectKey(targets[1]));
});
test("a retrying project releases the account so another due project gets a turn", async () => {
  const h = harness("retry"); await h.engine.run(targets, options);
  assert.deepEqual(h.writes, ["labour", "academic", "labour"]);
});
test("attempt limit is shared across all selected projects", async () => {
  const h = harness("retry");
  await assert.rejects(h.engine.run(targets, {...options, maxAttempts: 1}), RetryLimitReached);
  assert.equal(h.writes.length, 1);
});
test("a full target stops independently while the other category can still succeed", async () => {
  const h = harness("full"); const result = await h.engine.run(targets, options);
  assert.equal(result.filter(r => r.success).length, 1);
  assert.deepEqual(h.writes, ["labour", "academic"]);
  assert.equal(h.states.at(-1).completed, 1);
});
test("an uncertain submission stops queued targets before another captcha/write", async () => {
  const h = harness("uncertain");
  await assert.rejects(h.engine.run(targets, options), /结果不明确/);
  assert.equal(h.writes.length, 1);
});
test("a future target does not block a due target; stopping waiting tasks prevents later writes", async () => {
  let releaseWait, resolveWrite;
  const wait = new Promise(r => { releaseWait = r; }), wrote = new Promise(r => { resolveWrite = r; });
  const rows = [{...targets[0], bmkssj: "2026-10-18 13:00:00"}, targets[1]];
  const writes = [], enrolled = new Set();
  const engine = new MultiEngine({now: () => now, sleep: () => wait,
    apiFor: category => ({available: async () => rows.filter(r => r.category === category),
      enrolled: async () => enrolled.has(category) ? [{hdid:42}] : [], captcha: async () => "image",
      submit: async () => { writes.push(category); enrolled.add(category); resolveWrite(); return {zt:"1"}; }}),
    ocr: {recognize: async () => "1234"}});
  const running = engine.run(rows, options);
  await wrote; engine.stop(); releaseWait();
  await assert.rejects(running, Cancelled);
  assert.deepEqual(writes, ["academic"]);
});
test("in-flight list reads coalesce without caching later enrollment verification", async () => {
  let count = 0;
  const api = shareReads({enrolled: async () => { count++; return []; }});
  await Promise.all([api.enrolled(), api.enrolled()]); assert.equal(count, 1);
  await api.enrolled(); assert.equal(count, 2);
});
