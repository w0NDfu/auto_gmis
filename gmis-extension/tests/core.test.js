import {test} from "node:test";
import assert from "node:assert/strict";
import {normalize, matches, parseTime, hasEnrollment, classifyResult, countdown} from "../core.js";

test("keywords support partial names and punctuation; every token is required", () => {
  assert.equal(matches("10.23 昌平校区场地维护（上午）", "昌平 场地维护"), true);
  assert.equal(matches("朝阳校区场地维护", "昌平 场地维护"), false);
  assert.equal(matches("项目", "　"), false);
  assert.equal(normalize("ＡＣＭ（上午）"), "acm上午");
});
test("registration times are parsed in China time including midnight dates", () => {
  assert.equal(parseTime("2026-10-18 00:00:01"), Date.parse("2026-10-17T16:00:01Z"));
  assert.equal(parseTime("2026/10/18 0:00:01"), Date.parse("2026-10-17T16:00:01Z"));
  assert.throws(() => parseTime("garbage"));
});
test("enrollment uses activity ID rather than the enrollment row ID", () => {
  assert.equal(hasEnrollment([{id: 7, hdid: 42}], "42"), true);
  assert.equal(hasEnrollment([{id: 7, hdid: 42}], "7"), false);
});
test("only explicit failures can trigger a retry", () => {
  assert.equal(classifyResult({sign: -1}), "not-open");
  assert.equal(classifyResult({msg: "验证码错误"}), "captcha");
  assert.equal(classifyResult({msg: "该活动已经满额"}), "full");
  assert.equal(classifyResult({zt: "1"}), "unknown");
});
test("countdown never goes negative and includes full days", () => {
  assert.equal(countdown(-10), "00:00:00");
  assert.equal(countdown(90061000), "1天 01:01:01");
});
