import {parseTime, hasEnrollment, classifyResult} from "./core.js";

export class Cancelled extends Error {
  constructor() { super("任务已停止"); }
}
export class RetryLimitReached extends Error {
  constructor() { super("达到重试上限，未确认报名成功"); }
}
export class ProjectUnavailable extends Error {}
export class Engine {
  constructor({api, ocr, log = () => {}, state = () => {},
    now = () => Date.now(), sleep, journal = async () => {}, withAttempt = operation => operation()}) {
    Object.assign(this, {api, ocr, log, state, now, journal, withAttempt});
    this.sleep = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.cancelled = false;
    this.running = false;
  }
  stop() { this.cancelled = true; }
  check() { if (this.cancelled) throw new Cancelled(); }
  async enrolled(id, tries = 1) {
    for (let n = 0; n < tries; n++) {
      if (hasEnrollment(await this.api.enrolled(), id)) return true;
      if (n + 1 < tries) await this.sleep(800);
    }
    return false;
  }
  async run(selected, options = {}) {
    if (this.running) throw new Error("已有任务在运行");
    if (typeof options === "number") options = {maxAttempts: options};
    const {maxAttempts = 90, intervalSeconds = 2, attemptAt: customAttemptAt, retryFull = false} = options;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 99999 ||
      !Number.isFinite(intervalSeconds) || intervalSeconds < 0.01 || intervalSeconds > 60 ||
      (customAttemptAt !== undefined && !Number.isFinite(customAttemptAt))) {
      throw new Error("尝试参数无效：次数 1–99999，间隔 0.01–60 秒，开始时间须为有效日期时间");
    }
    const interval = intervalSeconds * 1000;
    this.running = true;
    this.cancelled = false;
    try {
      const id = String(selected.id);
      // Lock an ID only; re-fetch authoritative times before arming.
      let row = (await this.api.available()).find(r => String(r.id) === id);
      this.check();
      if (await this.enrolled(id)) return this.success(id);
      if (!row) throw new ProjectUnavailable("项目不在可报名列表中");
      let start = parseTime(row.bmkssj), end = parseTime(row.bmjzsj);
      if (this.now() >= end) throw new ProjectUnavailable("报名已截止");
      let attemptAt = customAttemptAt ?? start - 60000;
      if (attemptAt >= end) throw new ProjectUnavailable("开始尝试时间必须早于报名截止时间");
      this.log(`已锁定项目 ${id}：${row.mc}`);
      await this.journal({id, phase: "waiting", name: row.mc});
      let refreshed = this.now();
      while (this.now() < attemptAt) {
        this.check();
        this.state({phase: "waiting", start, end, attemptAt, project: row});
        await this.sleep(Math.min(1000, attemptAt - this.now()));
        this.check();
        if (this.now() - refreshed >= 60000) {
          row = (await this.api.available()).find(r => String(r.id) === id);
          if (!row) {
            if (await this.enrolled(id)) return this.success(id);
            throw new ProjectUnavailable("目标已从可报名列表消失");
          }
          start = parseTime(row.bmkssj); end = parseTime(row.bmjzsj);
          attemptAt = customAttemptAt ?? start - 60000;
          if (this.now() >= end) throw new ProjectUnavailable("报名已截止");
          if (attemptAt >= end) throw new ProjectUnavailable("开始尝试时间已超出最新的报名截止时间");
          refreshed = this.now();
        }
      }
      this.check();
      this.log(`已到尝试时间，最多尝试 ${maxAttempts} 次，失败后间隔 ${intervalSeconds} 秒。`);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const outcome = await this.withAttempt(async () => {
          this.check();
          if (this.now() >= end) throw new ProjectUnavailable("报名已截止");
          if (await this.enrolled(id)) return this.success(id);
          this.check();
          this.state({phase: "running", attempt, maxAttempts, early: this.now() < start, start, end, attemptAt, project: row});
          if (this.api.preflight && !await this.api.preflight(id)) {
            this.log("报名预检尚未放行，稍后重新核对。");
            return null;
          }
          this.check();
          const image = await this.api.captcha();
          this.check();
          const code = await this.ocr.recognize(image);
          this.check();
          if (!/^\d{4}$/.test(code)) {
            this.log(`第 ${attempt} 次：识别不确定，重新获取验证码。`);
            return null;
          }
          // Persist intent before sending. A page reload never resumes submission.
          await this.journal({id, phase: "submitting", name: row.mc});
          this.check();
          const beforeSend = () => {
            this.check();
            if (this.now() >= end) {
              const error = new ProjectUnavailable("报名已截止"); error.code = "DEADLINE"; throw error;
            }
          };
          beforeSend();
          this.log(`第 ${attempt} 次：提交报名。`);
          let result;
          try { result = await this.api.submit(id, code, beforeSend); }
          catch (error) {
            if (error instanceof Cancelled || error.code === "DEADLINE") throw error;
            // The server may have committed even when the response was lost.
            if (await this.enrolled(id, 3)) return this.success(id);
            throw new Error("提交结果不明确，已停止重发；请查询学校的成功报名列表");
          }
          const kind = classifyResult(result);
          if (await this.enrolled(id, kind === "unknown" ? 3 : 1)) return this.success(id);
          this.check();
          if (kind === "full" && !retryFull) throw new ProjectUnavailable("项目已满额");
          if (kind === "not-open" || kind === "captcha" || (kind === "full" && retryFull)) {
            this.log(kind === "not-open" ? "服务器尚未开放，稍后重试。" : kind === "full" ? "项目已满额，按设置继续等待名额。" : "验证码被拒绝，重新识别。");
            await this.journal({id, phase: "retrying", name: row.mc});
            return null;
          }
          throw new Error(`未在成功报名列表确认，已停止。${String(result?.msg || "服务器未提供明确提示")}`);
        });
        if (outcome) return outcome;
        await this.sleep(interval);
      }
      throw new RetryLimitReached();
    } finally { this.running = false; }
  }
  async success(id) {
    await this.journal({id, phase: "success"});
    this.state({phase: "success"});
    this.log("报名成功，已在成功报名列表核验。");
    return {success: true, id};
  }
}
