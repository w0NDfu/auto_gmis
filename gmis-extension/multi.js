import {HelperClient, HelperAPI, QueuedOCR} from "./helper-api.js";
import {LocalOCR} from "./ocr.js";
import {Engine} from "./engine.js";
import {matches, parseTime, countdown} from "./core.js";

const $ = id => document.getElementById(id);
const preview = new URL(location.href).searchParams.has("preview");
const accounts = new Map();
let client, current, busy = false;
const ocr = new QueuedOCR(new LocalOCR(message => log(null, message)));
const labels = {starting: "正在启动", waiting: "等待开始", running: "正在尝试", success: "报名成功", error: "已停止", stopped: "已停止"};
function log(account, message, error = false) {
  const row = document.createElement("div"); row.className = "log" + (error ? " error" : "");
  const time = document.createElement("time"); time.textContent = new Date().toLocaleTimeString("zh-CN", {hour12: false});
  const text = document.createElement("span"); text.textContent = (account ? `[${account.label} ${account.masked}] ` : "") + message;
  row.append(time, text); $("logs").append(row);
  while ($("logs").children.length > 500) $("logs").firstElementChild.remove();
  $("logs").scrollTop = $("logs").scrollHeight;
}
function selected() { return [...accounts.values()].filter(a => a.checked); }
function active() { return accounts.get(current); }
function phase(account) {
  if (account.state?.phase === "waiting") return "距离尝试 " + countdown(account.state.attemptAt - Date.now());
  if (account.state?.phase === "running") return `尝试 ${account.state.attempt}/${account.state.maxAttempts}`;
  return labels[account.state?.phase] || account.notice || (account.ready ? "登录就绪" : "等待登录");
}
function render() {
  $("account-count").textContent = accounts.size;
  $("accounts").replaceChildren();
  if (!accounts.size) { const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "尚未添加账号"; $("accounts").append(empty); }
  for (const account of accounts.values()) {
    const item = document.createElement("div"); item.className = "account-item" + (account.id === current ? " active" : "");
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = account.checked;
    check.setAttribute("aria-label", "选择 " + account.label); check.disabled = busy;
    check.onchange = () => { account.checked = check.checked; };
    const button = document.createElement("button"); button.type = "button";
    const title = document.createElement("strong"); title.textContent = account.label + " · " + account.masked;
    const target = document.createElement("small"); target.textContent = (account.loginMode === "direct" ? "独立登录 · " : "统一认证 · ") + (account.target?.mc || "尚未选择项目");
    const state = document.createElement("small"); state.className = "phase " + (account.state?.phase || ""); state.textContent = phase(account);
    button.append(title, target, state); button.onclick = () => { current = account.id; render(); renderProjects(); };
    item.append(check, button); $("accounts").append(item);
  }
  $("connection").textContent = client ? "本机后台已连接" : "后台未连接";
  for (const id of ["add", "load", "match-all", "start", "select-all"]) $(id).disabled = preview || !client || busy;
  for (const id of ["login", "remove"]) $(id).disabled = preview || !client || busy || !active() || !!active()?.job;
  $("pair").disabled = preview || busy || [...accounts.values()].some(a => a.job);
  $("stop-all").disabled = preview || ![...accounts.values()].some(a => a.job);
  $("stop").disabled = preview || !active()?.job;
  $("current-title").textContent = active() ? active().label + "的项目" : "当前账号项目";
  $("current-status").textContent = active() ? phase(active()) : "添加账号并登录后，输入关键词匹配项目。";
}
function renderProjects() {
  const account = active(), list = (account?.rows || []).filter(row => !$("keyword").value.trim() || matches(row.mc, $("keyword").value));
  $("projects").replaceChildren(); $("project-count").textContent = list.length;
  if (!list.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "还没有匹配项目，连接账号后获取列表。"; $("projects").append(empty); }
  for (const row of list) {
    const button = document.createElement("button"); button.className = "project" + (String(account.target?.id) === String(row.id) ? " selected" : "");
    button.disabled = busy || !!account.job;
    const radio = document.createElement("span"); radio.className = "radio";
    const content = document.createElement("div"); content.className = "project-content";
    const title = document.createElement("h3"); title.textContent = row.mc;
    const meta = document.createElement("p"); meta.textContent = `报名：${row.bmkssj} 至 ${row.bmjzsj}`;
    const info = document.createElement("p"); info.textContent = `${row.dd || "地点待公布"} · 已报名 ${row.bmrs ?? "—"} / ${row.rs ?? "—"}`;
    content.append(title, meta, info); button.append(radio, content);
    button.onclick = () => { account.target = row; account.targetCategory = account.rowsCategory; render(); renderProjects(); };
    $("projects").append(button);
  }
}
function remember(publicAccount) {
  const old = accounts.get(publicAccount.id);
  const record = old || {checked: true, rows: [], target: null, state: null};
  Object.assign(record, publicAccount); accounts.set(record.id, record); current ||= record.id; return record;
}
function apiFor(account, category = $("category").value) { return new HelperAPI(client, account.id, category, ocr, message => log(account, message)); }
async function action(operation) {
  if (busy) return;
  busy = true; render(); renderProjects();
  try { await operation(); } catch (error) { log(active(), error.message, true); }
  finally { busy = false; render(); renderProjects(); }
}
$("pair").onclick = () => action(async () => {
  const candidate = new HelperClient($("pair-token").value.trim());
  const health = await candidate.call("/health");
  if (health.version !== "0.4.1") throw new Error("后台仍是旧版，请关闭旧后台并重新运行 start-helper.cmd，再复制新的配对码");
  client = candidate; accounts.clear(); current = undefined;
  health.accounts.forEach(remember); $("pair-token").value = "";
  log(null, `后台 ${health.version} 已连接。账号会话彼此独立，可在此添加多个账号。`);
});
$("add").onclick = () => action(async () => {
  const added = await client.call("/accounts/add", {username: $("username").value.trim(), password: $("password").value, label: $("account-label").value.trim(), loginMode: $("login-mode").value});
  $("password").value = ""; $("username").value = ""; $("account-label").value = "";
  const account = remember(added); current = account.id; account.notice = "正在自动登录"; render();
  try { Object.assign(account, await apiFor(account).login()); account.notice = "登录就绪"; log(account, "登录成功，学号已核验。"); }
  catch (error) { account.notice = "登录失败，可重新登录或移除后更正密码"; throw error; }
});
$("login").onclick = () => action(async () => {
  const account = active(); account.ready = false; account.notice = "正在登录";
  try { Object.assign(account, await apiFor(account).login()); account.notice = "登录就绪"; log(account, "重新登录成功。"); }
  catch (error) { account.notice = "登录失败，请重试或更正密码"; throw error; }
});
$("remove").onclick = () => action(async () => {
  const account = active(); await client.call("/accounts/remove", {id: account.id}); accounts.delete(account.id); current = accounts.keys().next().value;
});
$("select-all").onclick = () => { const value = ![...accounts.values()].every(a => a.checked); accounts.forEach(a => { a.checked = value; }); render(); };
async function load(account, category) {
  if (account.job) throw new Error("请先停止该账号任务，再更换项目");
  account.rows = await apiFor(account, category).available(); account.rowsCategory = category;
  if (account.targetCategory !== category || !account.rows.some(r => String(r.id) === String(account.target?.id))) account.target = null;
}
$("load").onclick = () => action(async () => {
  if (!active()) throw new Error("请先添加账号");
  await load(active(), $("category").value); log(active(), "项目列表已更新。");
});
$("match-all").onclick = () => action(async () => {
  const keyword = $("keyword").value.trim(), category = $("category").value, targets = selected();
  if (!keyword || !targets.length) throw new Error("请输入关键词，并勾选账号");
  await Promise.all(targets.map(async account => {
    try {
      await load(account, category);
      const found = account.rows.filter(row => matches(row.mc, keyword));
      account.target = null;
      if (found.length !== 1) throw new Error(`匹配 ${found.length} 个项目，请点击账号后手动选择一个项目`);
      account.target = found[0]; account.targetCategory = category;
      log(account, "已匹配：" + account.target.mc);
    } catch (error) { log(account, error.message, true); }
  }));
});
function options() {
  const intervalSeconds = Number($("retry-interval").value), maxAttempts = Number($("max-attempts").value);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < .01 || intervalSeconds > 60 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 99999) {
    throw new Error("重试间隔须为 0.01–60 秒，次数须为 1–99999");
  }
  return {intervalSeconds, maxAttempts, retryFull: $("retry-full").checked,
    ...($("attempt-at").value ? {attemptAt: parseTime($("attempt-at").value)} : {})};
}
async function runAccount(account, settings) {
  const api = apiFor(account, account.targetCategory);
  const engine = new Engine({api, ocr, log: message => log(account, message), state: state => { account.state = state; render(); },
    journal: async entry => { account.lastTask = entry; }});
  // Set job before any awaits to make duplicate starts impossible in this console.
  const job = {api, engine, stopping: false}; account.job = job; account.state = {phase: "starting"};
  let heartbeat;
  try {
    api.runId = (await client.call("/runs/start", {id: account.id})).runId;
    if (job.stopping) return;
    let heartbeating = false;
    heartbeat = setInterval(async () => {
      if (heartbeating || job.stopping) return;
      heartbeating = true;
      try { await client.call("/runs/heartbeat", api.args()); }
      catch (error) { engine.stop(); log(account, "后台连接中断，任务已停止：" + error.message, true); }
      finally { heartbeating = false; }
    }, 10000);
    log(account, `任务已启动：${account.target.mc}；重试间隔 ${settings.intervalSeconds} 秒。`);
    await engine.run({...account.target}, settings);
  } catch (error) {
    account.state = {phase: job.stopping ? "stopped" : "error"}; log(account, error.message, !job.stopping);
  } finally {
    clearInterval(heartbeat);
    if (api.runId) await client.call("/runs/stop", api.args()).catch(error => log(account, error.message, true));
    if (job.stopping) account.state = {phase: "stopped"};
    account.job = null;
    if (![...accounts.values()].some(a => a.job)) globalThis.chrome?.power?.releaseKeepAwake();
    render(); renderProjects();
  }
}
$("start").onclick = () => action(async () => {
  const targets = selected().filter(a => !a.job), settings = options();
  if (!targets.length) throw new Error("请勾选尚未运行的账号");
  if (targets.some(a => !a.ready || !a.target)) throw new Error("每个勾选账号都需要先登录并选择项目");
  for (const account of targets) {
    if (settings.attemptAt !== undefined && settings.attemptAt >= parseTime(account.target.bmjzsj)) throw new Error(account.label + "的开始尝试时间已超过截止时间");
  }
  globalThis.chrome?.power?.requestKeepAwake("system");
  for (const account of targets) void runAccount(account, {...settings});
  log(null, `已启动 ${targets.length} 个账号，分别使用独立会话。`);
});
async function stop(account) {
  const job = account?.job; if (!job) return;
  job.stopping = true; job.engine.stop();
  if (job.api.runId) {
    try { await client.call("/runs/stop", job.api.args()); }
    catch (error) { log(account, "停止指令未送达后台：" + error.message + "；任务租约到期后禁止新提交。", true); }
  }
  log(account, "已请求停止；已发送到学校的请求仍需等待结果。"); render();
}
$("stop").onclick = () => { void stop(active()); };
$("stop-all").onclick = () => { accounts.forEach(a => { void stop(a); }); };
$("keyword").oninput = renderProjects;
$("login-mode").onchange = () => {
  const sso = $("login-mode").value === "sso";
  $("password-label").textContent = sso ? "统一身份认证密码" : "GMIS 独立登录密码";
  $("password").placeholder = sso ? "sidportal.buct.edu.cn 的登录密码" : "GMIS /home/stulogin 的独立登录密码";
  $("username").placeholder = sso ? "统一身份认证学号" : "GMIS 独立登录学号";
  $("login-path").textContent = sso ? "统一身份认证 → i 北化 → 研究生系统 → 核验学号。" : "GMIS 独立登录 → 核验学号；仅用于该入口的独立密码。";
};
$("category").onchange = () => { renderProjects(); };
window.addEventListener("beforeunload", () => {
  for (const account of accounts.values()) if (account.job) {
    account.job.engine.stop();
    if (account.job.api.runId) void client.call("/runs/stop", account.job.api.args(), {keepalive: true}).catch(() => {});
  }
});
setInterval(() => { if ([...accounts.values()].some(a => a.job)) render(); }, 1000);
if (preview) {
  $("preview-banner").hidden = false;
  const row = {id: 101, mc: "前沿科学学术报告：从材料创新到绿色未来", bmkssj: "2026-10-18 14:00:00", bmjzsj: "2026-10-18 15:00:00", dd: "学术报告厅", rs: 120, bmrs: 32};
  for (const [index, name] of ["账号 A", "账号 B", "账号 C"].entries()) {
    const account = remember({id: "demo-" + index, label: name, masked: "DE••••0" + index, ready: true});
    account.rows = [{...row}]; account.target = {...row}; account.rowsCategory = "academic"; account.targetCategory = "academic";
    account.notice = index === 2 ? "等待匹配" : "项目已就绪";
  }
  $("category").value = "academic"; $("keyword").value = "学术报告";
  log(null, "多账号界面预览：同一控制台管理多个独立会话。");
  log(accounts.get("demo-0"), "已匹配学术报告；开始尝试时间默认提前 1 分钟。");
}
render(); renderProjects();
