const ORIGIN = "https://gmis.buct.edu.cn";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value || "").normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]/g, "");
const mask = value => value.length < 5 ? "••••" : value.slice(0, 2) + "••••" + value.slice(-2);
const failure = (message, code) => Object.assign(new Error(message), {code});

// The home initially renders empty #xh; bindxscard() fills it asynchronously.
// Inspect only explicit account fields, never script text, input credentials or arbitrary digits.
export function inspectIdentity() {
  const clean = value => String(value || "").normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]/g, "");
  const candidates = values => [...new Set(values.map(clean).filter(value =>
    /^[A-Za-z0-9_-]{4,32}$/.test(value) && !/^(?:loading|null|undefined|none|unknown|[-_]+|x+)$/i.test(value)))];
  if (document.getElementById("UserId") && document.getElementById("Password")) return {state: "expired"};
  const explicit = candidates([...document.querySelectorAll("#xh")].map(el => el.textContent?.trim() || el.value));
  if (explicit.length > 1) return {state: "conflict"};
  if (explicit.length === 1) return {state: "ready", account: explicit[0], source: "xh"};
  const labeled = [];
  for (const dl of document.querySelectorAll("dl")) {
    if (!/^(?:学生)?学号$/.test(clean(dl.querySelector("dt")?.textContent).replace(/[:：]/g, ""))) continue;
    for (const dd of dl.querySelectorAll("dd")) labeled.push(dd.textContent?.trim() || dd.value);
  }
  const values = candidates(labeled);
  if (values.length > 1) return {state: "conflict"};
  if (values.length === 1) return {state: "ready", account: values[0], source: "label"};
  return {state: "pending"};
}

export async function waitForIdentity(page, expected, {timeout = 15000, interval = 200,
  now = Date.now, sleep = pause, inspect = inspectIdentity} = {}) {
  const until = now() + timeout;
  expected = clean(expected);
  if (!expected) throw failure("未配置核验学号，已停止", "ACCOUNT_REQUIRED");
  while (now() < until) {
    const url = new URL(page.url());
    if (url.origin !== ORIGIN || !/^\/student\//i.test(url.pathname)) {
      throw failure("研究生系统未建立登录会话，请重新连接统一认证", "SESSION_EXPIRED");
    }
    let result;
    try { result = await page.evaluate(inspect); }
    catch { await sleep(interval); continue; } // A navigation can replace the document while it is read.
    if (result?.state === "expired") throw failure("研究生系统登录已失效", "SESSION_EXPIRED");
    if (result?.state === "conflict") throw failure("学校主页出现多个不同学号，已停止账号核验", "IDENTITY_CONFLICT");
    if (result?.state === "ready") {
      const actual = clean(result.account);
      if (actual) {
        if (actual !== expected) throw failure(`登录账号不一致：配置 ${mask(expected)}，GMIS 实际 ${mask(actual)}；已停止`, "ACCOUNT_MISMATCH");
        return actual;
      }
    }
    await sleep(Math.min(interval, Math.max(1, until - now())));
  }
  throw failure(`GMIS 主页学号仍未加载（已等待 ${timeout / 1000} 秒），尚未确认登录身份，请重新连接`, "IDENTITY_NOT_FOUND");
}
