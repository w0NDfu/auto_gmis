export const ORIGIN = "https://gmis.buct.edu.cn";
export const LOGIN = `${ORIGIN}/home/stulogin`;
export const PAGE = `${ORIGIN}/student/yggl/zyzfwbm`;

export function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
export function matches(name, query) {
  const parts = query.trim().split(/\s+/u).map(normalize).filter(Boolean);
  const target = normalize(name);
  return parts.length > 0 && parts.every(part => target.includes(part));
}
export function parseTime(value) {
  const text = String(value ?? "").trim();
  // Do not interpret the university's timezone using the computer's timezone.
  const local = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  let date;
  if (local) {
    const [, y, m, d, h, minute, s = "00"] = local;
    date = Date.parse(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T${h.padStart(2,"0")}:${minute}:${s}+08:00`);
  } else if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) date = Date.parse(text);
  if (!Number.isFinite(date)) throw new Error(`无法解析报名时间：${text}`);
  return date;
}
export function inputTime(value) {
  return new Date(value + 8 * 3600000).toISOString().slice(0, 19);
}
export function hasEnrollment(rows, id) {
  return rows.some(row => String(row.hdid) === String(id));
}
export function classifyResult(result) {
  const message = String(result?.msg || "");
  if (String(result?.sign) === "-1") return "not-open";
  if (/验证码/.test(message) && /错误|不正确|失效|过期/.test(message)) return "captcha";
  if (/满额|已满|名额已/.test(message)) return "full";
  return "unknown";
}
export function countdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const clock = [Math.floor(seconds % 86400 / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
    .map(n => String(n).padStart(2, "0")).join(":");
  return (days ? `${days}天 ` : "") + clock;
}
