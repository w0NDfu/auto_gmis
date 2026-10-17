import {LOGIN, ORIGIN} from "./core.js";
import {getCategory, assertAccount} from "./categories.js";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export class PortalAPI {
  constructor(ocr, credentials, log) {
    Object.assign(this, {ocr, credentials, log});
    this.tabId = null;
    this.categoryKey = "labour";
    this.boundAccount = "";
  }
  setCategory(key) { getCategory(key); this.categoryKey = key; }
  get category() { return getCategory(this.categoryKey); }
  get page() { return ORIGIN + this.category.page; }
  async identity() {
    try { return (await this.send({type: "GMIS_IDENTITY"})).account; }
    catch (error) {
      if (error.code !== "IDENTITY_NOT_FOUND") throw error;
      return this.renderedIdentity();
    }
  }
  async renderedIdentity() {
    // Fresh top-level navigation handles home responses that differ for fetch().
    // Never reuse a stale rendered identity after another tab changed accounts.
    const tab = await chrome.tabs.create({url: ORIGIN + "/student/default/home", active: false});
    try {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        let response;
        try {
          const current = await chrome.tabs.get(tab.id);
          if (current.status === "complete") {
            response = await chrome.tabs.sendMessage(tab.id, {type: "GMIS_IDENTITY_DOM"}, {frameId: 0});
          }
        } catch { /* Navigation has not installed the content script yet. */ }
        if (response?.ok) return response.data.account;
        if (response?.error === "SESSION_EXPIRED") throw new Error("SESSION_EXPIRED");
        if (response && response.code !== "IDENTITY_NOT_FOUND") throw new Error(response.error || "主页核验失败");
        await pause(250);
      }
      throw new Error("学校主页加载后仍未识别到学号，请确认当前配置已登录后重新连接");
    } finally { await chrome.tabs.remove(tab.id).catch(() => {}); }
  }
  async assertIdentity() {
    return assertAccount(await this.identity(), this.boundAccount, String(this.credentials().username || "").trim());
  }
  async bindIdentity() {
    this.boundAccount = assertAccount(await this.identity(), "", String(this.credentials().username || "").trim());
    return this.boundAccount;
  }
  async send(message) {
    if (!this.tabId) throw new Error("请先连接学校系统");
    const response = await chrome.tabs.sendMessage(this.tabId, message, {frameId: 0});
    if (!response?.ok) {
      const error = new Error(response?.error || "无法连接页面，请重新连接系统");
      error.code = response?.code;
      throw error;
    }
    return response.data;
  }
  async ready(timeout = 20000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try {
        const tab = await chrome.tabs.get(this.tabId);
        if (tab.status === "complete") {
          const status = await this.send({type: "GMIS_STATUS"});
          // Do not accept the old document while a tab is navigating.
          if (status.href === tab.url) return status;
        }
      } catch { /* Receiver is not ready during navigation. */ }
      await pause(250);
    }
    throw new Error("学校页面加载超时，请检查网络或登录页状态");
  }
  async connect() {
    let exists = false;
    if (this.tabId) {
      try { await chrome.tabs.get(this.tabId); exists = true; } catch { /* Tab closed. */ }
    }
    if (!exists) {
      const tab = await chrome.tabs.create({url: this.page, active: false});
      this.tabId = tab.id;
    }
    await this.ready();
    return this.withAuth(async () => {
      // Only an explicit connect action may establish a new account binding.
      await this.bindIdentity();
      return this.rows(this.category.available);
    });
  }
  async login() {
    const {username, password} = this.credentials();
    if (!username || !password) {
      await chrome.tabs.update(this.tabId, {active: true});
      throw new Error("登录已失效。请在学校页面登录，或填写控制台中的学号和独立登录密码后重新连接。");
    }
    await this.ocr.prepare();
    await chrome.tabs.update(this.tabId, {url: LOGIN});
    let status = await this.ready();
    if (status.state === "student") return;
    if (status.state !== "login") throw new Error("未找到独立登录表单，请检查学校页面");
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.log(`自动登录，第 ${attempt}/3 次。`);
      if (attempt > 1) status = {...status, ...await this.send({type: "GMIS_LOGIN_REFRESH"})};
      const code = await this.ocr.recognize(status.image);
      if (!/^\d{4}$/.test(code)) continue;
      await this.send({type: "GMIS_LOGIN_SUBMIT", username, password, code, image: status.image});
      let notice = "";
      const until = Date.now() + 15000;
      await pause(800);
      while (Date.now() < until) {
        try {
          status = await this.send({type: "GMIS_STATUS"});
          if (status.state === "student") { this.log("自动登录完成，开始验证项目接口。"); return; }
          if (status.notice) { notice = status.notice; break; }
        } catch { /* Navigation temporarily removes the message receiver. */ }
        await pause(300);
      }
      if (notice && /验证码/.test(notice)) continue;
      throw new Error("登录未通过，请检查账号密码或打开学校页面查看提示；已停止重复登录。");
    }
    throw new Error("登录验证码连续识别失败，已停止");
  }
  async request(route, data) { return this.send({type: "GMIS_REQUEST", category: this.categoryKey, route, data}); }
  async rows(route) {
    const result = await this.request(route);
    if (!Array.isArray(result?.rows) || result.rows.some(row => !row || typeof row !== "object")) {
      throw new Error("接口没有返回有效的项目列表");
    }
    return result.rows;
  }
  async withAuth(operation) {
    try { return await operation(); }
    catch (error) {
      if (error.message !== "SESSION_EXPIRED") throw error;
      this.log("当前会话需要重新登录。");
      await this.login();
      return operation();
    }
  }
  available() { return this.withAuth(async () => { await this.assertIdentity(); return this.rows(this.category.available); }); }
  enrolled() { return this.withAuth(async () => { await this.assertIdentity(); return this.rows(this.category.enrolled); }); }
  async preflight(id) {
    if (!this.category.preflight) return true;
    return this.withAuth(async () => {
      await this.assertIdentity();
      const result = await this.request(this.category.preflight, {id});
      if (String(result?.sign) === "0") return false;
      if (String(result?.sign) === "1") return true;
      throw new Error("学术报告预检没有返回明确许可，已停止，请在学校页面核对");
    });
  }
  async captcha() {
    return (await this.withAuth(async () => { await this.assertIdentity(); return this.request("captcha"); })).image;
  }
  // Never transparently retry a write request, including after re-login.
  async submit(id, code, beforeSend = () => {}) {
    await this.assertIdentity();
    beforeSend();
    return this.request(this.category.submit, {id, VeriCode: code});
  }
  async open() {
    if (this.tabId) {
      try { await chrome.tabs.update(this.tabId, {active: true, url: this.page}); return; } catch { /* Closed. */ }
    }
    const tab = await chrome.tabs.create({url: this.page}); this.tabId = tab.id;
  }
}
