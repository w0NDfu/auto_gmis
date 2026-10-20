import http from "node:http";
import {randomBytes, timingSafeEqual} from "node:crypto";
import {pathToFileURL} from "node:url";
import {AccountManager, fail} from "./manager.js";
import {describeError} from "./operations.js";

const HOST = "127.0.0.1", PORT = 8767;
export function createServer(manager, token, {port = PORT} = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const send = (status, result) => { res.writeHead(status); res.end(JSON.stringify(result)); };
    const boundPort = port || server.address()?.port;
    if (req.headers.host !== `${HOST}:${boundPort}`) return send(403, {error: "Host 不受支持"});
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return send(403, {error: "仅允许浏览器扩展连接"});
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const supplied = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from("Bearer " + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, {error: "配对码无效，请复制后台窗口里的配对码"});
    if (req.method !== "POST") return send(405, {error: "仅接受 POST"});
    try {
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw fail("需要 JSON 请求");
      let body = "";
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) throw fail("请求过大"); }
      const args = JSON.parse(body || "{}");
      let result;
      switch (req.url) {
        case "/health": result = {version: "0.4.2", build: "sso-sms-recovery-20261020", accounts: manager.list()}; break;
        case "/accounts/add": result = await manager.create(args); break;
        case "/accounts/remove": result = await manager.remove(args.id); break;
        case "/login/challenge": result = await manager.challenge(args.id, args.runId); break;
        case "/login/submit": result = await manager.login(args.id, args.code, args.runId, args.challengeId); break;
        case "/request": result = await manager.request(args.id, args); break;
        case "/runs/start": result = manager.start(args.id); break;
        case "/runs/heartbeat": result = manager.heartbeat(args.id, args.runId); break;
        case "/runs/stop": result = manager.stop(args.id, args.runId); break;
        default: return send(404, {error: "接口不存在"});
      }
      send(200, {ok: true, data: result});
    } catch (error) {
      // Never print request bodies, passwords, cookies, or upstream HTML.
      const action = {"/accounts/add": "添加账号", "/login/challenge": "准备登录页面", "/login/submit": "登录账号", "/request": "访问学校接口"}[req.url] || "处理后台请求";
      const diagnostic = describeError(error, {step: action});
      send(400, {ok: false, error: diagnostic.message, code: diagnostic.code});
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
async function main() {
  const token = randomBytes(32).toString("base64url");
  const manager = new AccountManager(async () => {
    const {chromium} = await import("playwright-core");
    return chromium.launch({channel: "chrome", headless: true});
  }, {report: event => {
    const time = new Date(event.at).toLocaleTimeString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false});
    const phase = {running: "开始", done: "完成", error: "失败"}[event.phase];
    console.log(`${time} [${event.masked}] ${event.step}：${phase}${event.phase !== "running" ? `（${event.elapsed}ms）` : ""}${event.message ? " " + event.message : ""}`);
  }});
  const server = createServer(manager, token);
  server.on("error", error => { console.error(error.code === "EADDRINUSE" ? "8767 端口已占用，请关闭旧后台后重启。" : "后台无法启动：" + error.code); process.exitCode = 1; });
  server.listen(PORT, HOST, () => {
    console.log("\n北化报名助手多账号后台 0.4.2 · 短信标签恢复修复版\n仅监听本机 http://127.0.0.1:8767\n");
    console.log("配对码：" + token + "\n\n在扩展控制台粘贴配对码。账号密码仅保存在内存，关闭本窗口即清除。\n请保持此窗口和扩展控制台开启。Ctrl+C 退出。\n");
  });
  const shutdown = async () => { server.close(); await manager.close().catch(() => {}); process.exit(); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("后台启动失败"); process.exitCode = 1; });
