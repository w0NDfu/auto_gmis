import {Engine, Cancelled, ProjectUnavailable, RetryLimitReached} from "./engine.js";

export const projectKey = row => `${row.category}:${row.id}`;
export const categoryLabel = key => key === "academic" ? "学术报告" : "劳动实践";

// Only in-flight reads are shared: verification after a write always fetches fresh data.
export function shareReads(api) {
  const pending = new Map();
  return new Proxy(api, {get(target, property) {
    const value = target[property];
    if (typeof value !== "function") return value;
    if (!["available", "enrolled"].includes(property)) return value.bind(target);
    return () => {
      if (!pending.has(property)) {
        const promise = Promise.resolve().then(() => value.call(target)).finally(() => pending.delete(property));
        pending.set(property, promise);
      }
      return pending.get(property);
    };
  }});
}

export class MultiEngine {
  constructor({apiFor, ocr, log = () => {}, state = () => {}, journal = async () => {}, now, sleep}) {
    Object.assign(this, {apiFor, ocr, log, state, journal, now, sleep});
    this.engines = []; this.cancelled = false; this.running = false;
  }
  stop() { this.cancelled = true; this.engines.forEach(engine => engine.stop()); }
  async run(targets, options) {
    if (this.running) throw new Error("已有任务在运行");
    if (!targets.length || new Set(targets.map(projectKey)).size !== targets.length) throw new Error("请选择不重复的项目");
    this.running = true; this.cancelled = false;
    let queue = Promise.resolve(), attempts = 0, fatal;
    const states = new Map(), results = new Map(), apis = new Map();
    const publish = () => {
      const pending = [...states.values()];
      const current = pending.find(s => s.phase === "running") || pending.filter(s => s.phase === "waiting").sort((a,b) => a.attemptAt - b.attemptAt)[0];
      this.state({...current, phase: current?.phase || "starting", attempt: attempts,
        maxAttempts: options.maxAttempts, completed: results.size, total: targets.length});
    };
    const withAttempt = operation => {
      const promise = queue.then(async () => {
        if (this.cancelled) throw new Cancelled();
        if (attempts >= options.maxAttempts) throw new RetryLimitReached();
        attempts++;
        try { return await operation(); }
        catch (error) {
          // Stop queued attempts before releasing the lock on an uncertain write/session error.
          if (!(error instanceof ProjectUnavailable)) { fatal ||= error; this.stop(); }
          throw error;
        }
      });
      queue = promise.catch(() => {});
      return promise;
    };
    try {
      await Promise.all(targets.map(async target => {
        const key = projectKey(target), prefix = `【${categoryLabel(target.category)} · ${target.mc}】`;
        if (!apis.has(target.category)) apis.set(target.category, shareReads(this.apiFor(target.category)));
        const engine = new Engine({api: apis.get(target.category), ocr: this.ocr, now: this.now, sleep: this.sleep,
          withAttempt, log: message => this.log(prefix + message),
          state: value => { states.set(key, value); publish(); },
          journal: entry => this.journal({...entry, category: target.category})});
        this.engines.push(engine);
        try { results.set(key, await engine.run({...target}, {...options})); }
        catch (error) {
          if (error instanceof ProjectUnavailable) {
            results.set(key, {success: false, error: error.message}); this.log(prefix + error.message);
          } else if (!(error instanceof Cancelled && this.cancelled)) {
            fatal ||= error;
            this.stop();
          }
        } finally { states.delete(key); publish(); }
      }));
      if (fatal) throw fatal;
      if (this.cancelled) throw new Cancelled();
      const successes = [...results.values()].filter(r => r.success).length;
      this.state({phase: successes === targets.length ? "success" : "error", completed: successes, total: targets.length, attempt: attempts});
      this.log(`任务结束：已核验成功 ${successes}/${targets.length} 个项目，共尝试 ${attempts} 次。`);
      return [...results.values()];
    } finally { this.running = false; }
  }
}
