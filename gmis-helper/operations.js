// Keep diagnostics useful without returning Playwright call logs, credentials or ticket URLs.
export function pageLocation(page) {
  try { const url = new URL(page.url()); return url.origin + url.pathname; }
  catch { return "页面尚未打开"; }
}
export function describeError(cause, {step = "后台操作", page, secrets = []} = {}) {
  const code = String(cause?.code || "");
  if (/^(?:LOGIN_|SSO_|IDENTITY_|ACCOUNT_|SESSION_|RUN_|STEP_|BROWSER_|INVALID_REQUEST$|UPSTREAM_)/.test(code)) {
    let message = String(cause.message || step + "失败");
    for (const value of secrets.filter(Boolean).sort((a, b) => String(b).length - String(a).length)) message = message.split(String(value)).join("[已隐藏]");
    return {code, message: message.slice(0, 500), step: cause.step || step};
  }
  const raw = String(cause?.message || "");
  const location = page ? `；当前页面：${pageLocation(page)}` : "";
  if (cause?.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(raw)) {
    const milliseconds = /Timeout\s+(\d+)ms/i.exec(raw)?.[1];
    return {code: "STEP_TIMEOUT", step,
      message: `${step}超时${milliseconds ? `（${Number(milliseconds) / 1000} 秒）` : ""}${location}`};
  }
  if (/TargetClosed|Target page, context or browser has been closed|browser has been closed/i.test(raw)) {
    return {code: "BROWSER_CLOSED", step, message: `${step}中断：浏览器或页面已关闭${location}`};
  }
  const network = /\b(ERR_[A-Z_]+)\b/.exec(raw)?.[1];
  if (network) return {code: "STEP_NETWORK", step, message: `${step}连接失败（${network}）${location}`};
  const kind = ["TypeError", "ReferenceError", "RangeError", "SyntaxError"].includes(cause?.name) ? cause.name : "Error";
  const source = /(?:manager|sso|sso-form|identity|operations)\.js:\d+:\d+/.exec(String(cause?.stack || ""))?.[0];
  return {code: "STEP_ERROR", step, message: `${step}失败（${kind}）${location}${source ? `；代码位置：${source}` : ""}；请查看后台步骤记录`};
}
export async function runStep(account, step, operation) {
  const started = Date.now();
  const emit = (phase, extra = {}) => {
    const event = {step, phase, at: Date.now(), elapsed: Date.now() - started, ...extra};
    account.stage = event;
    account.events ||= []; account.events.push(event);
    if (account.events.length > 60) account.events.shift();
    try { account.report?.(event); } catch { /* Diagnostic output cannot interrupt authentication. */ }
  };
  emit("running");
  try { const result = await operation(); emit("done"); return result; }
  catch (cause) {
    const diagnostic = describeError(cause, {step, page: account.page,
      secrets: [account.username, account.password, account.loginCode]});
    account.lastError = diagnostic;
    emit("error", {code: diagnostic.code, message: diagnostic.message});
    throw Object.assign(new Error(diagnostic.message), {code: diagnostic.code, step: diagnostic.step});
  }
}
