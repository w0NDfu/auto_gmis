import {test} from "node:test";
import assert from "node:assert/strict";
import {getCategory, assertAccount, maskAccount} from "../categories.js";
import {parseTime, inputTime} from "../core.js";

test("categories have separate enrollment routes, even with a shared submit route", () => {
  assert.equal(getCategory("labour").available, "zyzfwbm_sqlist");
  assert.equal(getCategory("academic").available, "xshdbm_sqlist");
  assert.equal(getCategory("academic").preflight, "xshdbm_sfkysq");
  assert.notEqual(getCategory("academic").enrolled, getCategory("labour").enrolled);
  assert.throws(() => getCategory("toString"));
  assert.throws(() => getCategory("unknown"));
});
test("explicit expected account and bound session both must match", () => {
  assert.equal(assertAccount("account-a", "account-a", "account-a"), "account-a");
  assert.throws(() => assertAccount("account-b", "account-a"), /不一致/);
  assert.throws(() => assertAccount("account-b", "", "account-a"), /不一致/);
  assert.throws(() => assertAccount("", ""), /无法识别/);
  assert.equal(maskAccount("test-account-01"), "te••••01");
});
test("manual datetime-local input round-trips in Beijing time", () => {
  const at = parseTime("2026-10-18T00:00");
  assert.equal(inputTime(at), "2026-10-18T00:00:00");
  assert.equal(inputTime(parseTime("2026-10-17 12:00:00") - 60000), "2026-10-17T11:59:00");
});
