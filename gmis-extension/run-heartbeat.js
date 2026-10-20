// Runs in the extension service worker, independently of the console's throttled timers.
export class LeaseKeeper {
  constructor({call, notify, now = Date.now, schedule = setInterval, unschedule = clearInterval}) {
    Object.assign(this, {call, notify, now, schedule, unschedule});
    this.closed = false; this.started = false; this.pending = false; this.failures = 0;
  }
  async start({id, runId}) {
    if (this.started || this.closed) throw new Error("续租通道已使用");
    this.started = true; this.args = {id, runId};
    this.lastSuccess = this.now();
    // Start the independent ticker before awaiting the network, also keeping the port active.
    this.timer = this.schedule(() => { void this.pulse(); }, 10000);
    await this.pulse(true);
  }
  async pulse(initial = false) {
    if (this.closed) return;
    this.notify({type: "tick"}); // Port traffic keeps the service worker active during a task.
    if (this.pending) return;
    this.pending = true;
    try {
      await this.call("/runs/heartbeat", this.args);
      if (this.closed) return;
      const recovered = this.failures > 0;
      this.lastSuccess = this.now(); this.failures = 0;
      this.notify({type: initial ? "ready" : recovered ? "recovered" : "alive"});
    } catch (error) {
      if (this.closed) return;
      const transient = error.code === "HELPER_UNAVAILABLE";
      this.failures++;
      if (!initial && transient && this.failures < 3 && this.now() - this.lastSuccess < 60000) {
        this.notify({type: "retrying", message: "续租请求暂时失败，扩展后台正在重试"});
      } else {
        this.notify({type: "failed", code: error.code, message: error.message});
        await this.close();
      }
    } finally { this.pending = false; }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.unschedule(this.timer);
    if (this.args) await this.call("/runs/stop", this.args).catch(() => {});
  }
}

export async function leaseCall(token, path, args) {
  let response;
  try {
    response = await fetch("http://127.0.0.1:8767" + path, {method: "POST", cache: "no-store",
      headers: {"Content-Type": "application/json", Authorization: "Bearer " + token},
      body: JSON.stringify(args), signal: AbortSignal.timeout(8000)});
  } catch { throw Object.assign(new Error("无法连接本机后台，请检查启动窗口是否仍开启"), {code: "HELPER_UNAVAILABLE"}); }
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error("本机后台响应格式异常，请重新启动并配对"), {code: "HELPER_PROTOCOL"}); }
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || "续租请求被后台拒绝"), {code: result.code || "HELPER_REJECTED"});
  return result.data;
}

export class RunHeartbeat {
  constructor({runtime = globalThis.chrome?.runtime, onFailure = () => {}, onNotice = () => {}} = {}) {
    Object.assign(this, {runtime, onFailure, onNotice}); this.closed = false;
  }
  start({token, id, runId}) {
    if (!this.runtime?.connect) return Promise.reject(new Error("扩展后台不可用，请重新加载扩展并打开新控制台"));
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = error => {
        if (this.closed) return;
        this.close(error);
        if (ready) this.onFailure(error); else reject(error);
      };
      this.rejectStartup = reject;
      this.timer = setTimeout(() => fail(new Error("扩展后台续租通道启动超时，请重新加载扩展")), 15000);
      try {
        const port = this.runtime.connect({name: "gmis-run-heartbeat"}); this.port = port;
        port.onMessage.addListener(message => {
          if (this.closed) return;
          if (message.type === "tick") { try { port.postMessage({type: "pong"}); } catch { /* Disconnect listener handles closure. */ } }
          if (message.type === "ready") { clearTimeout(this.timer); this.rejectStartup = null; ready = true; resolve(); }
          if (message.type === "failed") fail(Object.assign(new Error(message.message), {code: message.code}));
          if (message.type === "retrying" || message.type === "recovered") this.onNotice(message);
        });
        port.onDisconnect.addListener(() => {
          void this.runtime.lastError;
          fail(new Error("扩展后台续租通道已断开，请重新加载扩展并启动任务"));
        });
        port.postMessage({type: "start", token, id, runId});
      } catch (error) { fail(error); }
    });
  }
  close(reason = new Error("任务已停止")) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    this.rejectStartup?.(reason); this.rejectStartup = null;
    try { this.port?.disconnect(); } catch { /* Already disconnected. */ }
  }
}
