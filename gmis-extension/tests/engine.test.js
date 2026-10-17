import {test} from "node:test";
import assert from "node:assert/strict";
import {Engine, Cancelled} from "../engine.js";

const target = {id: 42, mc: "昌平项目", bmkssj: "2026-10-17 12:00:00", bmjzsj: "2026-10-17 14:00:00"};
const baseTime = Date.parse("2026-10-17T12:00:00+08:00");
function harness(mode = "success", startTime = baseTime) {
  let now = startTime, writes = 0, images = 0, registered = false;
  const records = [], states = [], submittedAt = [];
  const api = {
    available: async () => [{...target}],
    enrolled: async () => registered ? [{hdid: 42, id: 999}] : [],
    captcha: async () => { images++; return "image"; },
    submit: async (id, code) => {
      assert.equal(id, "42"); assert.equal(code, "1234"); writes++;
      submittedAt.push(now);
      if (mode === "lost") { registered = true; throw new Error("Timeout"); }
      if (mode === "uncertain") throw new Error("Timeout");
      if (mode === "false-success") return {zt: "1"};
      if (mode === "full") return {msg: "已经满额"};
      if (mode === "full-once" && writes === 1) return {msg: "已经满额"};
      if (mode === "not-open" && now < baseTime) return {sign: "-1"};
      if (mode === "retry" && writes === 1) return {msg: "验证码错误"};
      registered = true; return {zt: "1"};
    }
  };
  const ocr = {recognize: async () => "1234"};
  const engine = new Engine({api, ocr, now: () => now,
    sleep: async ms => { now += ms; }, journal: async r => records.push(r), state: s => states.push(s)});
  return {engine, api, ocr, records, states, submittedAt, writes: () => writes, images: () => images};
}
test("success is verified using the enrollment list", async () => {
  const h = harness();
  assert.equal((await h.engine.run(target)).success, true);
  assert.equal(h.writes(), 1);
  assert.equal(h.records.at(-1).phase, "success");
});
test("default attempt time is exactly one minute before opening", async () => {
  const h = harness("success", baseTime - 62500);
  await h.engine.run(target);
  assert.ok(h.states.some(s => s.phase === "waiting"));
  assert.equal(h.writes(), 1);
  assert.equal(h.submittedAt[0], baseTime - 60000);
});
test("a committed request with lost response is not sent twice", async () => {
  const h = harness("lost");
  await h.engine.run(target);
  assert.equal(h.writes(), 1);
});
test("an uncertain response stops instead of blindly resubmitting", async () => {
  const h = harness("uncertain");
  await assert.rejects(h.engine.run(target), /结果不明确/);
  assert.equal(h.writes(), 1);
  assert.equal(h.records.at(-1).phase, "submitting");
});
test("the site's success flag is insufficient", async () => {
  const h = harness("false-success");
  await assert.rejects(h.engine.run(target), /未在成功报名列表确认/);
  assert.equal(h.writes(), 1);
});
test("explicit captcha rejection obtains a new image", async () => {
  const h = harness("retry");
  await h.engine.run(target);
  assert.equal(h.writes(), 2);
  assert.equal(h.images(), 2);
});

test("0.01 second retry waits exactly 10 milliseconds after a rejected attempt", async () => {
  const h = harness("retry");
  await h.engine.run(target, {intervalSeconds: .01, maxAttempts: 2});
  assert.equal(h.writes(), 2);
  assert.equal(h.submittedAt[1] - h.submittedAt[0], 10);
});

test("retry intervals below 0.01 second are rejected before requests", async () => {
  const h = harness();
  await assert.rejects(h.engine.run(target, {intervalSeconds: .009}), /尝试参数无效/);
  assert.equal(h.writes(), 0);
});
test("full project is not retried", async () => {
  const h = harness("full");
  await assert.rejects(h.engine.run(target), /满额/);
  assert.equal(h.writes(), 1);
});
test("stop during OCR prevents a later submit", async () => {
  const h = harness();
  h.ocr.recognize = async () => { h.engine.stop(); return "1234"; };
  await assert.rejects(h.engine.run(target), Cancelled);
  assert.equal(h.writes(), 0);
});
test("stop after persisting submit intent still prevents transmission", async () => {
  const h = harness();
  h.engine.journal = async r => { if (r.phase === "submitting") h.engine.stop(); };
  await assert.rejects(h.engine.run(target), Cancelled);
  assert.equal(h.writes(), 0);
});
test("OCR format failures never send a registration", async () => {
  const h = harness(); h.ocr.recognize = async () => "12";
  await assert.rejects(h.engine.run(target, 2), /重试上限/);
  assert.equal(h.images(), 2); assert.equal(h.writes(), 0);
});
test("expired target does not submit", async () => {
  const h = harness("success", baseTime + 3 * 3600000);
  await assert.rejects(h.engine.run(target), /截止/);
  assert.equal(h.writes(), 0);
});
test("user-entered attempt time overrides the default minute lead", async () => {
  const h = harness("success", baseTime - 120000);
  await h.engine.run(target, {attemptAt: baseTime - 90000});
  assert.equal(h.submittedAt[0], baseTime - 90000);
});
test("past attempt time starts immediately", async () => {
  const h = harness("success", baseTime);
  await h.engine.run(target, {attemptAt: baseTime - 120000});
  assert.equal(h.submittedAt[0], baseTime);
});
test("not-open responses retry across the actual opening time", async () => {
  const h = harness("not-open", baseTime - 60000);
  await h.engine.run(target, {intervalSeconds: 20, maxAttempts: 4});
  assert.equal(h.writes(), 4);
  assert.equal(h.submittedAt.at(-1), baseTime);
});
test("academic preflight denial does not fetch or submit a captcha", async () => {
  const h = harness(); h.api.preflight = async () => false;
  await assert.rejects(h.engine.run(target, {maxAttempts: 3}), /重试上限/);
  assert.equal(h.writes(), 0); assert.equal(h.images(), 0);
});
test("full retry is opt-in and can succeed after a seat returns", async () => {
  const h = harness("full-once");
  await h.engine.run(target, {retryFull: true, maxAttempts: 2});
  assert.equal(h.writes(), 2);
});
test("invalid attempt settings and start after deadline are rejected", async () => {
  const h = harness();
  await assert.rejects(h.engine.run(target, {maxAttempts: 0}), /尝试参数无效/);
  await assert.rejects(h.engine.run(target, {intervalSeconds: 0}), /尝试参数无效/);
  await assert.rejects(h.engine.run(target, {attemptAt: baseTime + 3 * 3600000}), /开始尝试时间必须早于/);
  assert.equal(h.writes(), 0);
});
test("deadline crossed during OCR prevents the pending submission", async () => {
  const h = harness();
  h.ocr.recognize = async () => { await h.engine.sleep(3 * 3600000); return "1234"; };
  await assert.rejects(h.engine.run(target), /截止/);
  assert.equal(h.writes(), 0);
});
