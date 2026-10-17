import {test} from "node:test";
import assert from "node:assert/strict";
import {safeNotice, resultNotice, loginFailure, waitForLogin} from "../login-result.js";
import {AccountManager} from "../manager.js";

test("school error notices distinguish captcha, credentials and unknown timeout", () => {
  assert.equal(loginFailure("验证码输入不正确").code, "LOGIN_CAPTCHA");
  assert.equal(loginFailure("用户名或密码错误").code, "LOGIN_CREDENTIALS");
  assert.equal(loginFailure("当前不允许登录").code, "LOGIN_REJECTED");
  assert.equal(loginFailure().code, "LOGIN_TIMEOUT");
  assert.equal(resultNotice({msg: "验证码错误", password: "do not retain"}), "验证码错误");
  assert.equal(resultNotice({Message: "账号不存在"}), "账号不存在");
});
test("notices redact credentials and code before returning to the UI", () => {
  const notice = safeNotice("<b>DEMO0001</b> password=fake-secret code=1234\n错误", ["DEMO0001", "fake-secret", "1234"]);
  assert.ok(!/DEMO0001|fake-secret|1234|<b>/.test(notice));
  assert.ok(notice.includes("错误"));
});
test("rendered captcha notices are surfaced immediately and do not consume the full timeout", async () => {
  let pauses = 0;
  const page = {url: () => "https://gmis.buct.edu.cn/home/stulogin", evaluate: async () => "验证码错误"};
  await assert.rejects(waitForLogin(page, {}, {pause: async () => { pauses++; }}), error => error.code === "LOGIN_CAPTCHA" && error.message.includes("验证码错误"));
  assert.equal(pauses, 0);
});
test("native alert notices are used instead of silently discarding the school error", async () => {
  const page = {url: () => "https://gmis.buct.edu.cn/home/stulogin", evaluate: async () => ""};
  await assert.rejects(waitForLogin(page, {loginNotice: "学号或密码错误"}), error => error.code === "LOGIN_CREDENTIALS");
});
test("navigation succeeds with ASP.NET path case differences and success notices", async () => {
  const account = {loginNotice: "登录成功"}; let moved = false;
  const page = {url: () => "https://gmis.buct.edu.cn/" + (moved ? "Student/Default/Index" : "home/stulogin"), evaluate: async () => ""};
  await waitForLogin(page, account, {pause: async () => { moved = true; }});
});
test("timeout remains inconclusive instead of claiming password rejection", async () => {
  let now = 0;
  const page = {url: () => "https://gmis.buct.edu.cn/home/stulogin", evaluate: async () => ""};
  await assert.rejects(waitForLogin(page, {}, {timeout: 400, now: () => now, pause: async ms => { now += ms; }}), error => error.code === "LOGIN_TIMEOUT" && error.message.includes("尚不能判断"));
});

async function loginHarness({identity = "DEMO0001", image = "image-a", expires = 20000, waitLogin, redirects = true, sessionValid = true} = {}) {
  let url = "https://gmis.buct.edu.cn/home/stulogin?returnUrl=%2Fstudent", clicks = 0; const fills = [];
  const page = {setDefaultTimeout() {}, on() {}, url: () => url,
    locator: selector => ({fill: async value => { fills.push({selector, value}); }, first: () => ({click: async () => { clicks++; if (redirects) url = "https://gmis.buct.edu.cn/Student/Default/Index"; }})}),
    goto: async next => { url = sessionValid ? next : "https://gmis.buct.edu.cn/home/stulogin"; }, evaluate: async () => ({state: "ready", account: identity})};
  const manager = new AccountManager(async () => ({newContext: async () => ({newPage: async () => page, close: async () => {}})}), {now: () => 10000, waitLogin});
  const account = await manager.create({username: "DEMO0001", password: "mock-password", loginMode: "direct"});
  manager.imageSnapshot = async () => image;
  manager.get(account.id).challenge = {id: "challenge-a", image: "image-a", expires};
  return {manager, account, fills, clicks: () => clicks};
}
test("login uses the bound account form values then verifies actual rendered identity", async () => {
  const h = await loginHarness();
  const result = await h.manager.login(h.account.id, "1234", undefined, "challenge-a");
  assert.equal(result.ready, true); assert.equal(h.clicks(), 1);
  assert.deepEqual(h.fills, [{selector: "#UserId", value: "DEMO0001"}, {selector: "#Password", value: "mock-password"}, {selector: "#VeriCode", value: "1234"}]);
  assert.equal(h.manager.get(h.account.id).loginCode, "");
});
test("changed, expired or wrong-account challenges never submit login credentials", async () => {
  for (const options of [{image: "image-b"}, {expires: 9999}, {}]) {
    const h = await loginHarness(options);
    await assert.rejects(h.manager.login(h.account.id, "1234", undefined, options.image || options.expires ? "challenge-a" : "another-challenge"), error => error.code === "LOGIN_CAPTCHA");
    assert.equal(h.clicks(), 0); assert.equal(h.fills.length, 0);
  }
});
test("a successful redirect cannot bypass account identity mismatch", async () => {
  const h = await loginHarness({identity: "DEMO0002"});
  await assert.rejects(h.manager.login(h.account.id, "1234", undefined, "challenge-a"), error => error.code === "ACCOUNT_MISMATCH");
  assert.equal(h.manager.get(h.account.id).ready, false);
});

test("missing frontend redirect is recovered only by a protected home with the expected identity", async () => {
  const waitLogin = async () => { throw Object.assign(new Error("navigation unknown"), {code: "LOGIN_TIMEOUT"}); };
  const h = await loginHarness({redirects: false, waitLogin});
  assert.equal((await h.manager.login(h.account.id, "1234", undefined, "challenge-a")).ready, true);
  assert.equal(h.clicks(), 1);
});
test("timeout with no authenticated session stays inconclusive and does not bind the account", async () => {
  const waitLogin = async () => { throw Object.assign(new Error("navigation unknown"), {code: "LOGIN_TIMEOUT"}); };
  const h = await loginHarness({redirects: false, sessionValid: false, waitLogin});
  await assert.rejects(h.manager.login(h.account.id, "1234", undefined, "challenge-a"), error => error.code === "LOGIN_TIMEOUT");
  assert.equal(h.manager.get(h.account.id).ready, false);
});
