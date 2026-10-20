// Return short, redacted notices only; never retain complete upstream responses.
export function safeNotice(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets.filter(Boolean).sort((a, b) => String(b).length - String(a).length)) {
    text = text.split(String(secret)).join("[已隐藏]");
  }
  return text.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}
export function resultNotice(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  for (const key of ["msg", "message", "Message", "Msg", "error", "ErrorMessage", "messageInfo"]) {
    if (typeof result[key] === "string" && result[key].trim()) return result[key];
  }
  return "";
}
export function loginFailure(notice = "") {
  if (/短信|动态口令|一次性口令|二次认证|人脸验证|扫码确认|滑块|sms|one.?time.?password/i.test(notice)) {
    return {code: "LOGIN_INTERACTIVE", message: `学校要求其他认证步骤：${notice}`};
  }
  if (/验证码|校验码|verification\s*code|captcha/i.test(notice)) {
    return {code: "LOGIN_CAPTCHA", message: `学校拒绝验证码：${notice}`};
  }
  if (/密码|口令|账号|帐号|用户名|学号|用户不存在|账户|password|invalid\s*(user|credential)/i.test(notice)) {
    return {code: "LOGIN_CREDENTIALS", message: `学校未通过账号验证：${notice}`};
  }
  if (notice) return {code: "LOGIN_REJECTED", message: `学校登录提示：${notice}`};
  return {code: "LOGIN_TIMEOUT", message: "登录提交后 15 秒内未检测到成功跳转，且学校未返回可识别的错误；尚不能判断是验证码、密码还是网络问题"};
}

export async function waitForLogin(page, account, {timeout = 15000, now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const until = now() + timeout;
  while (now() < until) {
    const url = new URL(page.url());
    if (url.origin === "https://gmis.buct.edu.cn" && /^\/student\//i.test(url.pathname)) return;
    let notice = account.loginNotice;
    if (!notice) {
      try {
        notice = await page.evaluate(() => [...document.querySelectorAll(".messager-body, .validation-summary-errors, .field-validation-error, [role='alert']")]
          .filter(el => el.getClientRects().length)
          .map(el => el.textContent).join(" ").replace(/确定\s*$/, "").trim());
      } catch { /* A navigation can destroy the previous document's execution context. */ }
    }
    notice = safeNotice(notice, [account.username, account.password, account.loginCode]);
    if (notice && !/(?:登录|验证)成功|^success$/i.test(notice)) {
      // Re-check the URL: a successful navigation may finish while a notice is read.
      const current = new URL(page.url());
      if (current.origin === "https://gmis.buct.edu.cn" && /^\/student\//i.test(current.pathname)) return;
      const failure = loginFailure(notice);
      throw Object.assign(new Error(failure.message), {code: failure.code});
    }
    await pause(200);
  }
  const failure = loginFailure(account.loginNotice);
  throw Object.assign(new Error(failure.message), {code: failure.code});
}
