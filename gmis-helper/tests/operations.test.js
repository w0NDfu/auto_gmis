import {test} from "node:test";
import assert from "node:assert/strict";
import {describeError, runStep} from "../operations.js";
import {AccountManager} from "../manager.js";

test("Playwright timeout surfaces its exact stage without leaking call logs or ticket URLs", async () => {
  const reports = [];
  const account = {username: "DEMO0001", password: "mock-secret", loginCode: "1234",
    page: {url: () => "https://sidportal.buct.edu.cn/login?ticket=private-ticket&service=private-service"}, report: entry => reports.push(entry)};
  const original = Object.assign(new Error('locator.fill: Timeout 15000ms exceeded. Call log: password mock-secret username DEMO0001 ticket=private-ticket'), {name: "TimeoutError"});
  await assert.rejects(runStep(account, "填写统一认证密码", async () => { throw original; }), error =>
    error.code === "STEP_TIMEOUT" && error.step === "填写统一认证密码" && error.message.includes("15 秒"));
  const publicData = JSON.stringify({events: account.events, lastError: account.lastError, reports});
  assert.ok(!/mock-secret|DEMO0001|private-ticket|private-service|Call log/.test(publicData));
  assert.ok(publicData.includes("https://sidportal.buct.edu.cn/login"));
  assert.deepEqual(reports.map(r => r.phase), ["running", "error"]);
});
test("network and closed-page failures retain actionable categories", () => {
  assert.equal(describeError(new Error("page.goto: net::ERR_CONNECTION_RESET at https://example.com/?ticket=secret")).code, "STEP_NETWORK");
  const closed = describeError(new Error("Target page, context or browser has been closed"), {step: "打开研究生系统"});
  assert.equal(closed.code, "BROWSER_CLOSED"); assert.ok(closed.message.includes("打开研究生系统"));
});
test("typed school rejection retains its meaning while redacting any echoed credential", async () => {
  const account = {username: "DEMO0001", password: "mock-secret"};
  await assert.rejects(runStep(account, "等待 i 北化认证完成", async () => {
    throw Object.assign(new Error("用户 DEMO0001 密码 mock-secret 未通过"), {code: "LOGIN_CREDENTIALS"});
  }), error => error.code === "LOGIN_CREDENTIALS" && !/DEMO0001|mock-secret/.test(error.message));
});
test("a delayed unrelated resource does not prevent a committed GMIS home and identity check", async () => {
  let location = "https://gmis.buct.edu.cn/student/default/index", identityChecked = false;
  const page = {url: () => location, goto: async (url, options) => {
    if (options.waitUntil !== "commit") throw Object.assign(new Error("Timeout 15000ms exceeded waiting for unrelated script"), {name: "TimeoutError"});
    location = url;
  }};
  const manager = new AccountManager(async () => {}, {identityReader: async () => { identityChecked = true; }});
  const account = {id: "demo", username: "DEMO0001", label: "demo", page, loginMode: "sso"};
  assert.equal((await manager.verifyIdentity(account)).ready, true);
  assert.equal(identityChecked, true);
  assert.deepEqual(account.events.map(e => e.step), ["加载 GMIS 主页", "加载 GMIS 主页", "等待并核验 GMIS 学号", "等待并核验 GMIS 学号"]);
});
