import {randomUUID} from "node:crypto";
import {safeNotice, loginFailure} from "./login-result.js";
import {inspectSSOForm} from "./sso-form.js";
import {runStep} from "./operations.js";

export const SSO_ORIGIN = "https://sidportal.buct.edu.cn";
export const PORTAL_ORIGIN = "https://i.buct.edu.cn";
export const SSO_LOGIN = SSO_ORIGIN + "/login?service=https:%2F%2Fi.buct.edu.cn%2F";
export const GMIS_SSO = "https://gmis.buct.edu.cn/oauthLogin/bjhgdx";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (message, code) => Object.assign(new Error(message), {code});

export class SSOLogin {
  constructor({now = Date.now, sleep = pause, inspect = inspectSSOForm} = {}) { Object.assign(this, {now, sleep, inspect}); }
  async read(page) { return page.evaluate(this.inspect); }
  input(page, index, selector) { return selector ? page.locator(selector) : page.locator("input").nth(index); }
  async form(page) {
    const until = this.now() + 20000;
    let switched = false, lastForm = {};
    while (this.now() < until) {
      let form;
      try { form = await this.read(page); }
      catch (cause) {
        if (!/Execution context was destroyed|Cannot find context|navigation|Frame was detached/i.test(String(cause?.message || ""))) throw cause;
        await this.sleep(200); continue;
      }
      lastForm = form;
      if (form.password !== undefined && form.username !== undefined && form.submit >= 0) return form;
      if (!switched) {
        const names = /^(用户名密码|账号密码|账号密码登录|用户名密码登录|密码登录|账号登录)$/;
        // This school's default is enterprise-WeChat QR; the actual password tab is 用户名密码.
        const tab = page.getByRole("tab", {name: names}).first();
        if (await tab.isVisible()) { await tab.click(); switched = true; continue; }
        const mode = page.getByText(names).first();
        if (await mode.isVisible()) { await mode.click(); switched = true; continue; }
      }
      await this.sleep(200);
    }
    const missing = [lastForm.username === undefined && "用户名输入框", lastForm.password === undefined && "密码输入框",
      !(lastForm.submit >= 0) && "登录按钮"].filter(Boolean).join("、");
    throw error(`统一认证表单未就绪，缺少：${missing}${lastForm.selectedTab ? `；当前标签：${lastForm.selectedTab}` : ""}`, "SSO_FORM_NOT_FOUND");
  }
  async snapshot(page, index) {
    return page.locator("img,canvas").nth(index).evaluate(el => {
      if (el.tagName === "CANVAS") return el.toDataURL("image/png");
      if (!el.complete || !el.naturalWidth) throw new Error("统一认证验证码未加载");
      const canvas = document.createElement("canvas"); canvas.width = el.naturalWidth; canvas.height = el.naturalHeight;
      canvas.getContext("2d").drawImage(el, 0, 0); return canvas.toDataURL("image/png");
    });
  }
  async challenge(account) {
    const page = account.page;
    account.ready = false; account.challenge = null;
    if (!account.ssoRetry || new URL(page.url()).origin !== SSO_ORIGIN) {
      await runStep(account, "准备独立认证会话", () => account.context.clearCookies());
      await runStep(account, "打开统一认证页面", () => page.goto(SSO_LOGIN, {waitUntil: "commit", timeout: 30000}));
    }
    account.ssoRetry = false;
    if (new URL(page.url()).origin !== SSO_ORIGIN) throw error("统一认证登录页跳转异常，请重新登录", "SSO_PAGE_CHANGED");
    const form = await runStep(account, "识别用户名密码登录表单", () => this.form(page));
    let image = null;
    if (form.captcha !== undefined) {
      if (form.captchaImage < 0 || /短信|手机|动态/.test(form.captchaHint)) {
        throw error("统一认证当前要求短信、滑块或其他二次验证，无法按普通图形验证码自动登录", "LOGIN_INTERACTIVE");
      }
      image = await runStep(account, "读取统一认证验证码", () => this.snapshot(page, form.captchaImage));
    }
    const challengeId = randomUUID();
    account.challenge = {id: challengeId, form, image, expires: this.now() + 60000, type: "sso"};
    return {challengeId, image, loginMode: "sso", requiresCaptcha: !!image};
  }
  async submit(account, code, challengeId) {
    const page = account.page, challenge = account.challenge;
    account.challenge = null; account.ready = false;
    if (!challenge || challenge.type !== "sso" || challenge.id !== challengeId || challenge.expires <= this.now()) {
      throw error("统一认证登录页面已变化或验证码过期，请重新获取", "LOGIN_CAPTCHA");
    }
    if (new URL(page.url()).origin !== SSO_ORIGIN) throw error("统一认证页面地址异常，已停止填写凭据", "SSO_PAGE_CHANGED");
    const form = await runStep(account, "复核统一认证表单", () => this.form(page));
    if ((form.usernameSelector ?? form.username) !== (challenge.form.usernameSelector ?? challenge.form.username) ||
      (form.passwordSelector ?? form.password) !== (challenge.form.passwordSelector ?? challenge.form.password) ||
      (form.submitSelector ?? form.submit) !== (challenge.form.submitSelector ?? challenge.form.submit)) {
      throw error("统一认证表单发生变化，请重新获取", "LOGIN_CAPTCHA");
    }
    if (challenge.image) {
      if (!/^[A-Za-z0-9]{4,8}$/.test(code || "") || form.captchaImage < 0 ||
        challenge.image !== await this.snapshot(page, form.captchaImage)) throw error("统一认证验证码已变化或格式无效", "LOGIN_CAPTCHA");
    } else if (form.captcha !== undefined) {
      account.ssoRetry = true;
      throw error("统一认证新增了验证码，请重新获取", "LOGIN_CAPTCHA");
    }
    account.loginNotice = ""; account.loginCode = code || "";
    account.loginInFlight = true; account.loginAttempt = randomUUID();
    try {
      // Use the original rendered form so its encryption, flow keys and CSRF handling execute normally.
      await runStep(account, "填写统一认证学号", () => this.input(page, form.username, form.usernameSelector).fill(account.username, {timeout: 10000}));
      await runStep(account, "填写统一认证密码", () => this.input(page, form.password, form.passwordSelector).fill(account.password, {timeout: 10000}));
      if (challenge.image) await runStep(account, "填写统一认证验证码", () => this.input(page, form.captcha, form.captchaSelector).fill(code, {timeout: 10000}));
      // Do not wait for the portal's scripts/resources as part of the click. The next step observes auth explicitly.
      const submit = form.submitSelector ? page.locator(form.submitSelector) : page.locator("button,input[type='submit'],[role='button']").nth(form.submit);
      await runStep(account, "提交统一身份认证", () => submit.click({noWaitAfter: true, timeout: 10000}));
      await runStep(account, "等待 i 北化认证完成", () => this.waitForPortal(account, form.notice));
    } finally { account.loginInFlight = false; account.loginAttempt = null; account.loginCode = ""; }
    // The authenticated iBUCT portal's Research Student System link targets this exact endpoint.
    // Navigate in the same isolated context, retaining SSO cookies across the OAuth redirects.
    await runStep(account, "打开研究生系统", () => page.goto(GMIS_SSO, {waitUntil: "commit", timeout: 30000}));
    const until = this.now() + 30000;
    while (this.now() < until) {
      const url = new URL(page.url());
      if (url.origin === "https://gmis.buct.edu.cn" && /^\/student\//i.test(url.pathname)) return;
      if (url.origin === SSO_ORIGIN && /\/login\/?$/i.test(url.pathname)) {
        throw error("i 北化已登录，但研究生系统仍要求认证，请核对账号是否有研究生系统权限", "SSO_GMIS_NOT_AUTHENTICATED");
      }
      await this.sleep(200);
    }
    throw error("统一认证后进入研究生系统超时，未确认 GMIS 登录成功", "SSO_GMIS_TIMEOUT");
  }
  async waitForPortal(account, baselineNotice = "") {
    const started = this.now(), until = started + 20000;
    while (this.now() < until) {
      const page = account.page, url = new URL(page.url());
      if (url.origin === PORTAL_ORIGIN) return;
      if (url.origin !== SSO_ORIGIN) throw error("统一认证跳转到未预期的地址，已停止", "SSO_PAGE_CHANGED");
      let form;
      try { form = await this.read(page); } catch { await this.sleep(200); continue; }
      const renderedNotice = form.notice === baselineNotice && this.now() - started < 1000 ? "" : form.notice;
      const notice = safeNotice(account.loginNotice || renderedNotice, [account.username, account.password, account.loginCode]);
      if (notice && !/(?:登录|验证)成功|^success$/i.test(notice)) {
        const failure = loginFailure(notice);
        if (failure.code === "LOGIN_CAPTCHA") account.ssoRetry = true;
        throw error(failure.message, failure.code);
      }
      if (form.interactive && form.captcha === undefined) throw error("统一认证要求滑块、短信或二次验证，自动登录未完成", "LOGIN_INTERACTIVE");
      if (form.captcha !== undefined && !account.loginCode) {
        account.ssoRetry = true;
        throw error("统一认证要求图形验证码，正在获取验证码", "LOGIN_CAPTCHA");
      }
      await this.sleep(200);
    }
    throw error("统一身份认证提交后仍未进入 i 北化，未确认登录；请查看学校提示", "LOGIN_TIMEOUT");
  }
}
