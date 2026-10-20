import {getCategory} from "./categories.js";

export class HelperClient {
  constructor(token, fetcher = globalThis.fetch.bind(globalThis)) { this.token = token; this.fetcher = fetcher; }
  async call(path, args = {}, {keepalive = false} = {}) {
    let response;
    try {
      response = await this.fetcher("http://127.0.0.1:8767" + path, {method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": "Bearer " + this.token},
        body: JSON.stringify(args), cache: "no-store", keepalive,
        signal: AbortSignal.timeout(path.startsWith("/login/") ? 120000 : 45000)});
    } catch { throw new Error("无法连接本地后台，请保持 start-helper.cmd 窗口开启，并检查配对码"); }
    const result = await response.json();
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || "后台请求失败"), {code: result.code});
    return result.data;
  }
}

export class HelperAPI {
  constructor(client, accountId, categoryKey, ocr, log = () => {}) {
    getCategory(categoryKey);
    Object.assign(this, {client, accountId, categoryKey, ocr, log, runId: undefined});
  }
  args(extra = {}) { return {id: this.accountId, runId: this.runId, ...extra}; }
  login() {
    this.client.logins ||= new Map();
    if (!this.client.logins.has(this.accountId)) {
      const pending = this.performLogin().finally(() => this.client.logins.delete(this.accountId));
      this.client.logins.set(this.accountId, pending);
    }
    return this.client.logins.get(this.accountId);
  }
  async performLogin() {
    // Warm up before fetching a short-lived captcha, especially on the first account.
    await this.ocr.prepare?.();
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.log(`正在自动登录，第 ${attempt}/3 次`);
      const {image, challengeId, loginMode, requiresCaptcha = !!image} = await this.client.call("/login/challenge", this.args());
      if (loginMode === "sso") this.log("统一认证 → i 北化 → 研究生系统。");
      const code = requiresCaptcha ? await this.ocr.recognize(image) : "";
      if (requiresCaptcha && !/^\d{4}$/.test(code)) { this.log("验证码识别结果不完整，获取新图重试。"); continue; }
      try { return await this.client.call("/login/submit", this.args({code, challengeId})); }
      catch (error) {
        if (error.code !== "LOGIN_CAPTCHA" || attempt === 3) throw error;
        this.log(error.message + "；重新获取验证码。");
      }
    }
    throw new Error("登录验证码识别失败，请重试登录");
  }
  async request(operation, data = {}) {
    return this.client.call("/request", this.args({category: this.categoryKey, operation, data}));
  }
  async read(operation, data) {
    try { return await this.request(operation, data); }
    catch (error) {
      // Do not re-login behind another target's pending captcha or submission.
      if (error.code !== "SESSION_EXPIRED") throw error;
      if (this.runId) throw Object.assign(new Error("登录会话已失效，任务已停止，请重新登录后启动"), {code: "SESSION_EXPIRED"});
      await this.login(); return this.request(operation, data);
    }
  }
  async rows(operation) {
    const result = await this.read(operation);
    if (!Array.isArray(result?.rows) || result.rows.some(r => !r || typeof r !== "object")) throw new Error("学校接口未返回项目列表");
    return result.rows;
  }
  available() { return this.rows("available"); }
  enrolled() { return this.rows("enrolled"); }
  async captcha() { return (await this.read("captcha")).image; }
  async preflight(id) {
    if (!getCategory(this.categoryKey).preflight) return true;
    const result = await this.read("preflight", {id});
    if (String(result?.sign) === "0") return false;
    if (String(result?.sign) === "1") return true;
    throw new Error("学术报告预检未明确放行，已停止");
  }
  async submit(id, code, beforeSend = () => {}) {
    beforeSend();
    // Writes are never transparently retried after a timeout or re-login.
    return this.request("submit", {id, VeriCode: code});
  }
}

export class QueuedOCR {
  constructor(ocr) { this.ocr = ocr; this.queue = Promise.resolve(); }
  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  prepare() { return this.enqueue(() => this.ocr.prepare()); }
  recognize(image) { return this.enqueue(() => this.ocr.recognize(image)); }
}
