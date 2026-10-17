import {randomUUID} from "node:crypto";
import {safeNotice, resultNotice, waitForLogin} from "./login-result.js";
import {SSOLogin, SSO_ORIGIN} from "./sso.js";
import {waitForIdentity} from "./identity.js";
import {runStep} from "./operations.js";

const ORIGIN = "https://gmis.buct.edu.cn";
const LOGIN = ORIGIN + "/home/stulogin";
const HOME = ORIGIN + "/student/default/home";
const CATEGORIES = Object.freeze({
  labour: {page: "/student/yggl/zyzfwbm", available: "zyzfwbm_sqlist", enrolled: "zyzfwbm_cklist"},
  academic: {page: "/student/yggl/xshdbm", available: "xshdbm_sqlist", enrolled: "xshdbm_cklist", preflight: "xshdbm_sfkysq"}
});
export function fail(message, code = "INVALID_REQUEST") { return Object.assign(new Error(message), {code}); }
const mask = value => value.length < 5 ? "••••" : value.slice(0, 2) + "••••" + value.slice(-2);

export class AccountManager {
  constructor(browserFactory, {now = Date.now, leaseMs = 45000, waitLogin = waitForLogin, identityReader = waitForIdentity, sso, report} = {}) {
    Object.assign(this, {browserFactory, now, leaseMs, waitLogin, identityReader, report});
    this.accounts = new Map();
    this.sso = sso || new SSOLogin({now});
  }
  async browser() {
    if (!this.browserPromise) {
      this.browserPromise = this.browserFactory().catch(error => { this.browserPromise = null; throw error; });
    }
    return this.browserPromise;
  }
  public(account) { return {id: account.id, label: account.label, masked: mask(account.username), ready: account.ready, loginMode: account.loginMode}; }
  list() { return [...this.accounts.values()].map(a => this.public(a)); }
  get(id) {
    const account = this.accounts.get(id);
    if (!account) throw fail("账号不存在，请重新添加");
    return account;
  }
  async create({username, password, label = "", loginMode = "sso"}) {
    username = String(username || "").trim();
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(username) || typeof password !== "string" || !password || password.length > 256) {
      throw fail("请填写有效学号和所选登录方式对应的密码");
    }
    if (!["sso", "direct"].includes(loginMode)) throw fail("不支持的登录方式");
    // Reserve before awaiting browser startup, including concurrent add requests.
    if ([...this.accounts.values()].some(a => a.username === username)) throw fail("该账号已添加");
    const account = {id: randomUUID(), username, password, loginMode, label: String(label).slice(0, 40) || mask(username),
      ready: false, queue: Promise.resolve(), run: null};
    this.accounts.set(account.id, account);
    account.report = event => this.report?.({masked: mask(account.username), ...event});
    try {
      const browser = await runStep(account, "启动本机 Chrome", () => this.browser());
      account.context = await runStep(account, "创建账号隔离会话", () => browser.newContext());
      account.page = await runStep(account, "创建登录页面", () => account.context.newPage());
      account.page.setDefaultTimeout(15000);
      account.page.on("dialog", dialog => {
        if (account.loginInFlight) account.loginNotice = safeNotice(dialog.message(), [account.username, account.password, account.loginCode]);
        void dialog.dismiss().catch(() => {});
      });
      account.page.on("response", async response => {
        const attempt = account.loginAttempt;
        if (!account.loginInFlight || !attempt) return;
        const url = new URL(response.url());
        if (response.request().method() !== "POST") return;
        if (!(url.origin === ORIGIN && /^\/home\//i.test(url.pathname)) &&
          !(url.origin === SSO_ORIGIN && /login|auth|credential|\/sso\/|\/cas\//i.test(url.pathname))) return;
        try {
          const notice = resultNotice(await response.json());
          // Do not mistake a success notification for a rejection; the identity check remains mandatory.
          if (notice && !/(?:登录|验证)成功|^success$/i.test(notice) && account.loginInFlight && account.loginAttempt === attempt) {
            account.loginNotice = safeNotice(notice, [account.username, account.password, account.loginCode]);
          }
        } catch { /* A login response can legitimately be HTML or a redirect. */ }
      });
      return this.public(account);
    } catch (error) { this.accounts.delete(account.id); await account.context?.close().catch(() => {}); throw error; }
  }
  serial(id, operation) {
    const account = this.get(id);
    const pending = account.queue.then(() => {
      if (this.accounts.get(id) !== account) throw fail("账号已移除");
      return operation(account);
    });
    account.queue = pending.catch(() => {});
    return pending;
  }
  active(account) { return account.run && account.run.expires > this.now(); }
  validateRun(account, runId) {
    if (!this.active(account) || account.run.id !== runId) throw fail("任务已停止或控制台连接已失效", "RUN_EXPIRED");
  }
  start(id) {
    const account = this.get(id);
    if (!account.ready) throw fail("请先登录账号");
    if (this.active(account)) throw fail("该账号已有任务在运行");
    account.run = {id: randomUUID(), expires: this.now() + this.leaseMs};
    return {runId: account.run.id};
  }
  heartbeat(id, runId) {
    const account = this.get(id); this.validateRun(account, runId);
    account.run.expires = this.now() + this.leaseMs;
    return {alive: true};
  }
  stop(id, runId) {
    const account = this.get(id);
    // Do not queue cancellation behind a pending network operation.
    if (account.run?.id === runId) account.run = null;
    return {stopped: true};
  }
  async remove(id) {
    const account = this.get(id);
    if (this.active(account)) throw fail("请先停止该账号的任务");
    this.accounts.delete(id); account.password = ""; account.run = null;
    await account.context.close();
    return {removed: true};
  }
  assertIdle(account) { if (this.active(account)) throw fail("该账号正在运行，请先停止再手动登录"); }
  challenge(id, runId) {
    return this.serial(id, async account => {
      if (runId) this.validateRun(account, runId); else this.assertIdle(account);
      if (account.loginMode === "sso") return this.sso.challenge(account);
      account.ready = false;
      account.challenge = null;
      const page = account.page;
      await account.context.clearCookies();
      await page.goto(LOGIN, {waitUntil: "domcontentloaded"});
      if (new URL(page.url()).origin !== ORIGIN) throw fail("登录页面地址异常");
      await page.locator("#UserId").waitFor();
      const image = page.locator("#imgVerifi");
      await page.waitForFunction(() => { const img = document.getElementById("imgVerifi"); return img?.complete && img.naturalWidth; }, null, {timeout: 10000});
      // Preserve original pixels; screenshots can resize small captcha images at CSS scale.
      const dataURL = await this.imageSnapshot(image);
      const challengeId = randomUUID();
      account.challenge = {id: challengeId, image: dataURL, expires: this.now() + 60000};
      return {image: dataURL, challengeId};
    });
  }
  imageSnapshot(image) {
    return image.evaluate(img => {
      if (!img.complete || !img.naturalWidth) throw new Error("验证码图片尚未加载");
      const canvas = document.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    });
  }
  login(id, code, runId, challengeId) {
    return this.serial(id, async account => {
      if (runId) this.validateRun(account, runId); else this.assertIdle(account);
      if (account.loginMode === "sso") {
        await this.sso.submit(account, code, challengeId);
        return this.verifyIdentity(account);
      }
      if (!/^\d{4}$/.test(code)) throw fail("验证码格式无效");
      const page = account.page;
      const url = new URL(page.url());
      if (url.origin !== ORIGIN || url.pathname.toLowerCase().replace(/\/$/, "") !== "/home/stulogin") throw fail("请重新获取登录验证码", "LOGIN_CAPTCHA");
      const challenge = account.challenge; account.challenge = null;
      if (!challenge || challenge.id !== challengeId || challenge.expires <= this.now() ||
        challenge.image !== await this.imageSnapshot(page.locator("#imgVerifi"))) {
        throw fail("登录验证码已变化或过期，正在重新获取", "LOGIN_CAPTCHA");
      }
      account.ready = false; account.loginNotice = "";
      account.loginAttempt = randomUUID(); account.loginCode = code; account.loginInFlight = true;
      let navigationFailure;
      try {
        await page.locator("#UserId").fill(account.username);
        await page.locator("#Password").fill(account.password);
        await page.locator("#VeriCode").fill(code);
        await runStep(account, "提交 GMIS 独立登录", () => page.locator(".btn").first().click({noWaitAfter: true, timeout: 10000}));
        try { await this.waitLogin(page, account); }
        catch (error) {
          if (error.code !== "LOGIN_TIMEOUT") throw error;
          navigationFailure = error;
        }
      } finally { account.loginInFlight = false; account.loginCode = ""; account.loginAttempt = null; }
      // An AJAX login can set the session even if its front-end redirect fails.
      // A fresh protected home and matching account are authoritative.
      await runStep(account, "加载 GMIS 主页", () => page.goto(HOME, {waitUntil: "commit", timeout: 30000}));
      if (navigationFailure && !/^\/student\//i.test(new URL(page.url()).pathname)) throw navigationFailure;
      return this.verifyIdentity(account, navigationFailure);
    });
  }
  async verifyIdentity(account, navigationFailure) {
      account.ready = false;
      const page = account.page;
      if (account.loginMode === "sso") await runStep(account, "加载 GMIS 主页", () => page.goto(HOME, {waitUntil: "commit", timeout: 30000}));
      const url = new URL(page.url());
      if (url.origin !== ORIGIN || !/^\/student\//i.test(url.pathname)) {
        throw navigationFailure || fail("研究生系统未建立登录会话，请重新连接统一认证", "SESSION_EXPIRED");
      }
      try { await runStep(account, "等待并核验 GMIS 学号", () => this.identityReader(page, account.username)); }
      catch (error) {
        if (navigationFailure && error.code === "IDENTITY_NOT_FOUND") throw navigationFailure;
        throw error;
      }
      account.ready = true; account.loginNotice = "";
      return this.public(account);
  }
  request(id, {category, operation, data = {}, runId}) {
    return this.serial(id, async account => {
      const config = Object.hasOwn(CATEGORIES, category) && CATEGORIES[category];
      if (!config || !["available", "enrolled", "captcha", "preflight", "submit"].includes(operation)) throw fail("不支持的请求");
      if (!account.ready) throw fail("SESSION_EXPIRED", "SESSION_EXPIRED");
      if (this.active(account)) this.validateRun(account, runId);
      if (["captcha", "submit", "preflight"].includes(operation)) this.validateRun(account, runId);
      if (operation === "preflight" && !config.preflight) return {sign: "1"};
      if (["submit", "preflight"].includes(operation) && !/^\d+$/.test(String(data.id))) throw fail("项目编号无效");
      if (operation === "submit" && !/^\d{4}$/.test(data.VeriCode)) throw fail("验证码格式无效");
      let path = operation === "captcha" ? "/Home/VerificationCode?t=" + this.now() :
        "/student/yggl/" + (operation === "submit" ? "xshdbm_bm" : config[operation]);
      const options = {method: "POST", timeout: 15000, maxRedirects: 0,
        headers: {"Origin": ORIGIN, "Referer": ORIGIN + config.page, "X-Requested-With": "XMLHttpRequest"}};
      if (operation === "captcha" || operation === "preflight") options.method = "GET";
      if (operation === "preflight") path += "?id=" + encodeURIComponent(data.id);
      if (operation === "submit") options.form = {id: String(data.id), VeriCode: data.VeriCode};
      else if (options.method === "POST") options.form = {};
      // Cancellation/lease must still be valid immediately before transmitting the write.
      if (operation === "submit") this.validateRun(account, runId);
      const response = await account.context.request.fetch(ORIGIN + path, options);
      try {
        const status = response.status();
        if ((status >= 300 && status < 400) || status === 401 || status === 403) {
          account.ready = false; throw fail("SESSION_EXPIRED", "SESSION_EXPIRED");
        }
        if (!response.ok()) throw fail("学校接口 HTTP " + status, "UPSTREAM_ERROR");
        const contentType = response.headers()["content-type"] || "";
        if (operation === "captcha") {
          if (!contentType.startsWith("image/")) { account.ready = false; throw fail("SESSION_EXPIRED", "SESSION_EXPIRED"); }
          return {image: "data:" + contentType.split(";")[0] + ";base64," + (await response.body()).toString("base64")};
        }
        try { return await response.json(); }
        catch { account.ready = false; throw fail("SESSION_EXPIRED", "SESSION_EXPIRED"); }
      } finally { await response.dispose(); }
    });
  }
  async close() {
    for (const account of this.accounts.values()) { account.run = null; account.password = ""; }
    this.accounts.clear();
    if (this.browserPromise) await (await this.browserPromise).close();
  }
}
