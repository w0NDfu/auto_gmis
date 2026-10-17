import "./catalog.js";
export const CATEGORIES = globalThis.GMIS_CATALOG;
export function getCategory(key = "labour") {
  if (!Object.hasOwn(CATEGORIES, key)) throw new Error("未知的报名类别");
  return CATEGORIES[key];
}
export function assertAccount(actual, bound, expected = "") {
  if (!actual || !/^[\p{L}\p{N}_-]{4,32}$/u.test(actual)) throw new Error("无法识别当前登录学号，请检查学校主页");
  if ((bound && actual !== bound) || (expected && actual !== expected)) {
    throw new Error("当前登录学号与绑定账号不一致，已停止。请使用独立 Chrome 配置登录对应账号，再重新连接。");
  }
  return actual;
}
export function maskAccount(value) {
  const text = String(value || "");
  return text.length > 4 ? `${text.slice(0, 2)}••••${text.slice(-2)}` : text;
}
