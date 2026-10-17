import {test} from "node:test";
import assert from "node:assert/strict";
import {SSOLogin, SSO_LOGIN, SSO_ORIGIN, PORTAL_ORIGIN, GMIS_SSO} from "../sso.js";
import {AccountManager} from "../manager.js";

function harness({captcha = false, denial = "", gmis = true} = {}) {
  let now = 10000, url = "about:blank", clears = 0, clicks = 0, image = "data:image/png;base64,dGVzdA==";
  const visits = [], fills = [];
  const form = {username: 0, password: 1, submit: 0, captcha: captcha ? 2 : undefined, captchaImage: captcha ? 0 : -1, notice: "", interactive: false};
  const account = {username: "DEMO0001", password: "mock-secret", ready: false,
    context: {clearCookies: async () => { clears++; }}};
  const page = {url: () => url,
    goto: async next => { visits.push(next); url = next === GMIS_SSO && gmis ? "https://gmis.buct.edu.cn/student/default/index?dl=dddl" : next; },
    evaluate: async () => ({...form}), getByText: () => ({first: () => ({isVisible: async () => false})}),
    getByRole: () => ({first: () => ({isVisible: async () => false})}),
    locator: selector => ({nth: index => ({fill: async value => fills.push({selector, index, value}),
      evaluate: async () => image,
      click: async () => { clicks++; if (denial) form.notice = denial; else url = PORTAL_ORIGIN + "/_s2/yjs_sy/main.psp"; }})})};
  account.page = page;
  const sso = new SSOLogin({now: () => now, sleep: async ms => { now += ms; }});
  return {sso, account, form, visits, fills, clears: () => clears, clicks: () => clicks,
    setImage: value => { image = value; }, setURL: value => { url = value; }};
}
test("SSO uses the user-specified login URL then enters Research Student System in the same context", async () => {
  const h = harness(); const challenge = await h.sso.challenge(h.account);
  assert.equal(challenge.requiresCaptcha, false); assert.equal(challenge.image, null);
  await h.sso.submit(h.account, "", challenge.challengeId);
  assert.deepEqual(h.visits, [SSO_LOGIN, GMIS_SSO]); assert.equal(h.clears(), 1);
  assert.equal(h.clicks(), 1); assert.equal(h.account.ready, false, "only GMIS identity verification can mark ready");
  assert.deepEqual(h.fills.map(f => f.value), ["DEMO0001", "mock-secret"]);
});

test("submit does not wait for portal resources and then verifies the portal explicitly", async () => {
  const h = harness(), originalLocator = h.account.page.locator;
  h.account.page.locator = selector => selector === "input" ? originalLocator(selector) : ({nth: () => ({click: async options => {
    if (!options.noWaitAfter) throw Object.assign(new Error("Timeout 15000ms exceeded waiting for navigation"), {name: "TimeoutError"});
    h.setURL(PORTAL_ORIGIN + "/_s2/yjs_sy/main.psp");
  }})});
  const challenge = await h.sso.challenge(h.account);
  await h.sso.submit(h.account, "", challenge.challengeId);
  assert.ok(h.account.events.some(e => e.step === "等待 i 北化认证完成" && e.phase === "done"));
  assert.deepEqual(h.visits, [SSO_LOGIN, GMIS_SSO]);
});

test("stable visible control selectors survive inserted hidden fields without targeting their numeric positions", async () => {
  const h = harness();
  Object.assign(h.form, {usernameSelector: '[id="nameInput"]:visible', passwordSelector: 'input[type="password"]:visible', submitSelector: '[id="submitBtn"]:visible'});
  const challenge = await h.sso.challenge(h.account);
  h.form.username = 5; h.form.password = 6; h.form.submit = 4;
  const fills = [];
  h.account.page.locator = selector => ({fill: async value => { fills.push({selector, value}); }, click: async () => { h.setURL(PORTAL_ORIGIN); }});
  await h.sso.submit(h.account, "", challenge.challengeId);
  assert.deepEqual(fills.map(f => f.selector), ['[id="nameInput"]:visible', 'input[type="password"]:visible']);
  assert.deepEqual(fills.map(f => f.value), ["DEMO0001", "mock-secret"]);
});

test("default QR view switches via the real 用户名密码 tab before waiting for fields", async () => {
  const h = harness(); let switches = 0;
  h.form.username = undefined; h.form.password = undefined; h.form.submit = -1;
  h.account.page.getByRole = (role, {name}) => {
    assert.equal(role, "tab"); assert.ok(name.test("用户名密码"));
    return {first: () => ({isVisible: async () => true, click: async () => {
      switches++; h.form.username = 0; h.form.password = 1; h.form.submit = 1;
    }})};
  };
  const form = await h.sso.form(h.account.page);
  assert.equal(switches, 1); assert.equal(form.submit, 1); assert.equal(form.password, 1);
});

test("unrecognized form reports missing controls and the current tab without blaming credentials", async () => {
  const h = harness(); h.form.submit = -1; h.form.selectedTab = "用户名密码";
  await assert.rejects(h.sso.form(h.account.page), error => error.code === "SSO_FORM_NOT_FOUND" &&
    error.message.includes("缺少：登录按钮") && error.message.includes("用户名密码"));
  assert.equal(h.clicks(), 0);
});
test("SSO image captcha is bound to its page and credentials never submit if the image changes", async () => {
  const h = harness({captcha: true}), challenge = await h.sso.challenge(h.account);
  assert.equal(challenge.requiresCaptcha, true);
  h.setImage("another-image");
  await assert.rejects(h.sso.submit(h.account, "1234", challenge.challengeId), error => error.code === "LOGIN_CAPTCHA");
  assert.equal(h.fills.length, 0); assert.equal(h.clicks(), 0);
});
test("SSO form receives a captcha only when one is actually displayed", async () => {
  const h = harness({captcha: true}), challenge = await h.sso.challenge(h.account);
  await h.sso.submit(h.account, "1234", challenge.challengeId);
  assert.deepEqual(h.fills.map(f => f.value), ["DEMO0001", "mock-secret", "1234"]);
});
test("SSO credential rejection cannot be mistaken for an authenticated campus portal", async () => {
  const h = harness({denial: "用户名或密码不正确"}), challenge = await h.sso.challenge(h.account);
  await assert.rejects(h.sso.submit(h.account, "", challenge.challengeId), error => error.code === "LOGIN_CREDENTIALS");
  assert.deepEqual(h.visits, [SSO_LOGIN]); assert.equal(h.account.loginInFlight, false);
});
test("captcha retry keeps the account's SSO cookie jar instead of resetting the challenge session", async () => {
  const h = harness({captcha: true, denial: "验证码错误"}), challenge = await h.sso.challenge(h.account);
  await assert.rejects(h.sso.submit(h.account, "1234", challenge.challengeId), error => error.code === "LOGIN_CAPTCHA");
  await h.sso.challenge(h.account);
  assert.equal(h.clears(), 1); assert.deepEqual(h.visits, [SSO_LOGIN]);
});
test("SSO credentials are never filled on an unexpected origin", async () => {
  const h = harness(), challenge = await h.sso.challenge(h.account);
  h.setURL("https://untrusted.example/login");
  await assert.rejects(h.sso.submit(h.account, "", challenge.challengeId), error => error.code === "SSO_PAGE_CHANGED");
  assert.equal(h.fills.length, 0);
});
test("iBUCT success without a GMIS student session is not treated as complete login", async () => {
  const h = harness({gmis: false}), challenge = await h.sso.challenge(h.account);
  await assert.rejects(h.sso.submit(h.account, "", challenge.challengeId), error => error.code === "SSO_GMIS_TIMEOUT");
  assert.equal(h.account.ready, false);
});
test("manager defaults to SSO, sends its context through both steps, then binds only the GMIS identity", async () => {
  const seen = []; let url = "about:blank";
  const page = {setDefaultTimeout() {}, on() {}, url: () => url,
    goto: async next => { url = next; seen.push("home"); }, evaluate: async () => ({state: "ready", account: "DEMO0001"})};
  const context = {newPage: async () => page, close: async () => {}};
  const sso = {challenge: async account => { assert.equal(account.context, context); seen.push("challenge"); return {challengeId: "sso-challenge", requiresCaptcha: false}; },
    submit: async (account, code, challengeId) => { assert.equal(account.context, context); assert.equal(challengeId, "sso-challenge"); seen.push("sso+portal+gmis"); }};
  const manager = new AccountManager(async () => ({newContext: async () => context}), {sso});
  const added = await manager.create({username: "DEMO0001", password: "mock-secret"});
  assert.equal(added.loginMode, "sso");
  await manager.challenge(added.id);
  assert.equal((await manager.login(added.id, "", undefined, "sso-challenge")).ready, true);
  assert.deepEqual(seen, ["challenge", "sso+portal+gmis", "home"]);
});
test("a GMIS account different from the configured SSO username never becomes ready", async () => {
  let url = "about:blank";
  const page = {setDefaultTimeout() {}, on() {}, url: () => url, goto: async next => { url = next; }, evaluate: async () => ({state: "ready", account: "DEMO0002"})};
  const manager = new AccountManager(async () => ({newContext: async () => ({newPage: async () => page})}), {sso: {submit: async () => {}}});
  const added = await manager.create({username: "DEMO0001", password: "mock-secret"});
  await assert.rejects(manager.login(added.id, "", undefined, "challenge"), error => error.code === "ACCOUNT_MISMATCH");
  assert.equal(manager.get(added.id).ready, false);
});
