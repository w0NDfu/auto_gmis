import {HelperClient, HelperAPI, QueuedOCR} from "./helper-api.js";
import {LocalOCR} from "./ocr.js";
import {projectKey, categoryLabel} from "./multi-engine.js";
import {matches, parseTime, countdown} from "./core.js";

const $ = id => document.getElementById(id);
const preview = new URL(location.href).searchParams.has("preview");
const accounts = new Map();
let client, current, busy = false;
const ocr = new QueuedOCR(new LocalOCR(message => log(null, message)));
const labels = {starting: "后台正在启动", waiting: "等待开始", running: "正在尝试", success: "全部报名成功", error: "已停止", stopped: "已停止",stopping:"正在停止",exhausted:"尝试次数已用完"};
function log(account, message, error = false, at = Date.now()) {
  const row = document.createElement("div"); row.className = "log" + (error ? " error" : "");
  const time = document.createElement("time"); time.textContent = new Date(at).toLocaleTimeString("zh-CN", {timeZone:"Asia/Shanghai",hour12: false});
  const text = document.createElement("span"); text.textContent = (account ? `[${account.label} ${account.masked}] ` : "") + message;
  row.append(time, text); $("logs").append(row);
  while ($("logs").children.length > 500) $("logs").firstElementChild.remove();
  $("logs").scrollTop = $("logs").scrollHeight;
}
function selected() { return [...accounts.values()].filter(a => a.checked); }
function active() { return accounts.get(current); }
function phase(account) {
  if(account.connectionNotice)return account.connectionNotice;
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
    const target = document.createElement("small"); target.textContent = (account.loginMode === "direct" ? "独立登录 · " : "统一认证 · ") + `已选 ${account.targets.size} 个项目`;
    const state = document.createElement("small"); state.className = "phase " + (account.state?.phase || ""); state.textContent = phase(account);
    button.append(title, target, state); button.onclick = () => { current = account.id; render(); renderProjects(); };
    item.append(check, button); $("accounts").append(item);
  }
  $("connection").textContent = client ? "本机后台已连接" : "后台未连接";
  for (const id of ["add", "load", "match-all", "start", "select-all"]) $(id).disabled = preview || !client || busy;
  for (const id of ["login", "remove"]) $(id).disabled = preview || !client || busy || !active() || !!active()?.job;
  $("pair").disabled = preview || busy;
  $("stop-all").disabled = preview || ![...accounts.values()].some(a => a.job);
  $("stop").disabled = preview || !active()?.job;
  $("current-title").textContent = active() ? active().label + "的项目" : "当前账号项目";
  $("current-status").textContent = active() ? phase(active()) : "添加账号并登录后，输入关键词匹配项目。";
}
function renderProjects() {
  const account = active(), list = (account?.rows || []).filter(row =>
    ($("category").value === "all" || row.category === $("category").value) &&
    (!$("keyword").value.trim() || matches(row.mc, $("keyword").value)));
  $("selected-count").textContent = account?.targets.size || 0;
  $("selected-projects").replaceChildren();
  $("clear-projects").disabled = !account?.targets.size || !!account?.job || busy;
  for (const [key, row] of account?.targets || []) {
    const button = document.createElement("button"); button.className = "selection-chip";
    button.textContent = `${categoryLabel(row.category)} · ${row.mc} ×`;
    button.setAttribute("aria-label", "取消选择 " + row.mc); button.disabled = busy || !!account.job;
    button.onclick = () => { account.targets.delete(key); render(); renderProjects(); };
    $("selected-projects").append(button);
  }
  $("projects").replaceChildren(); $("project-count").textContent = list.length;
  if (!list.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = account?.rows.length ? "当前筛选没有匹配项目，已有选择保留。" : "还没有项目，连接账号后获取列表。"; $("projects").append(empty); }
  for (const row of list) {
    const checked = account.targets.has(projectKey(row));
    const button = document.createElement("button"); button.className = "project" + (checked ? " selected" : "");
    button.setAttribute("role", "checkbox"); button.setAttribute("aria-checked", String(checked));
    button.disabled = busy || !!account.job;
    const radio = document.createElement("span"); radio.className = "radio";
    const content = document.createElement("div"); content.className = "project-content";
    const title = document.createElement("h3"); title.textContent = `【${categoryLabel(row.category)}】${row.mc}`;
    const meta = document.createElement("p"); meta.textContent = `报名：${row.bmkssj} 至 ${row.bmjzsj}`;
    const info = document.createElement("p"); info.textContent = `${row.dd || "地点待公布"} · 已报名 ${row.bmrs ?? "—"} / ${row.rs ?? "—"}`;
    content.append(title, meta, info); button.append(radio, content);
    button.onclick = () => { const key = projectKey(row); if (account.targets.has(key)) account.targets.delete(key); else account.targets.set(key, {...row}); render(); renderProjects(); };
    $("projects").append(button);
  }
}
function remember(publicAccount) {
  const old = accounts.get(publicAccount.id);
  const record = old || {checked: true, rows: [], targets: new Map(), state: null};
  Object.assign(record, publicAccount); accounts.set(record.id, record); current ||= record.id; return record;
}
function apiFor(account, category = "labour") { return new HelperAPI(client, account.id, category, ocr, message => log(account, message)); }
async function action(operation) {
  if (busy) return;
  busy = true; render(); renderProjects();
  try { await operation(); } catch (error) { log(active(), error.message, true); }
  finally { busy = false; render(); renderProjects(); }
}
$("pair").onclick = () => action(async () => {
  const candidate = new HelperClient($("pair-token").value.trim());
  const health = await candidate.call("/health");
  if (health.version !== "0.5.0") throw new Error("后台仍是旧版，请关闭旧后台并重新运行 start-helper.cmd，再复制新的配对码");
  client = candidate; accounts.clear(); current = undefined;
  health.accounts.forEach(remember); $("pair-token").value = "";
  for(const task of health.tasks||[]){const account=accounts.get(task.accountId);if(account){applyTask(account,task);await refreshTask(account);}}
  log(null, `后台 ${health.version} 已连接。任务由本机后台持续执行，关闭或重新打开控制台不影响挂机。`);
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
  const categories = category === "all" ? ["labour", "academic"] : [category];
  // Both lists are read-only. Preserve selections even when filters/categories change.
  const results = await Promise.all(categories.map(async key => (await apiFor(account, key).available()).map(row => ({...row, category: key}))));
  account.rows = account.rows.filter(row => !categories.includes(row.category)).concat(results.flat());
  for (const row of results.flat()) if (account.targets.has(projectKey(row))) account.targets.set(projectKey(row), {...row});
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
      const found = account.rows.filter(row => (category === "all" || row.category === category) && matches(row.mc, keyword));
      if (found.length !== 1) throw new Error(`匹配 ${found.length} 个项目，请点击账号后勾选需要的项目；已有选择保留`);
      account.targets.set(projectKey(found[0]), {...found[0]});
      log(account, "已加入选择：" + found[0].mc);
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
  const targets = [...account.targets.values()].map(({id,category,mc}) => ({id,category,mc}));
  const job = {requestId:crypto.randomUUID(),targets,settings,stopping:false};account.job=job;account.state={phase:"starting"};render();renderProjects();
  try {
    applyTask(account,await client.call("/tasks/start",{id:account.id,requestId:job.requestId,targets,settings}));
    if(job.stopping&&account.job)await stop(account);
  } catch (error) {
    if(error.code&&error.code!=="HELPER_UNAVAILABLE"){account.job=null;account.state={phase:"error"};}
    log(account,"启动回执未确认，将读取后台状态核对："+error.message,true);
  }
  render();renderProjects();
}
function applyTask(account,task){
  if(!task)return;
  const changed=account.taskJobId!==task.jobId;
  if(changed){account.taskJobId=task.jobId;account.taskCursor=0;account.targets=new Map(task.targets.map(row=>[projectKey(row),row]));}
  for(const entry of task.logs||[])if(entry.seq>(account.taskCursor||0)){log(account,entry.message,entry.error,entry.at);account.taskCursor=entry.seq;}
  account.state=task.state;account.connectionNotice=task.connectionNotice;
  account.ready=task.accountReady;
  account.job=task.active?{jobId:task.jobId,stopping:task.state.phase==="stopping"}:null;
}
async function refreshTask(account){
  let task=await client.call("/tasks/status",{id:account.id,jobId:account.taskJobId,after:account.taskCursor||0});
  const pending=account.job;
  if(!task&&pending?.requestId&&!pending.stopping){task=await client.call("/tasks/start",{id:account.id,requestId:pending.requestId,targets:pending.targets,settings:pending.settings});}
  applyTask(account,task);
}
let polling=false,pollWarning=false;
async function pollTasks(){
  if(!client||preview||polling||busy)return;
  polling=true;
  try{
    await Promise.all([...accounts.values()].map(account=>refreshTask(account)));
    if(pollWarning){log(null,"控制台与后台状态连接已恢复。");pollWarning=false;}
    render();renderProjects();
  }catch(error){if(!pollWarning){log(null,"暂时无法读取任务状态；已提交的后台任务继续运行，控制台会重试。"+error.message,true);pollWarning=true;}}
  finally{polling=false;}
}
$("start").onclick = () => action(async () => {
  const targets = selected().filter(a => !a.job), settings = options();
  if (!targets.length) throw new Error("请勾选尚未运行的账号");
  if (targets.some(a => !a.ready || !a.targets.size)) throw new Error("每个勾选账号都需要先登录并选择项目");
  for (const account of targets) void runAccount(account, {...settings});
  log(null, `已启动 ${targets.length} 个账号，分别使用独立会话。`);
});
async function stop(account) {
  const job = account?.job; if (!job) return;
  job.stopping=true;
  if(!job.jobId){log(account,"任务正在接管，将在收到后台编号后停止。");return;}
  try{applyTask(account,await client.call("/tasks/stop",{id:account.id,jobId:job.jobId}));log(account,"已请求停止；已发送到学校的请求仍需核验结果。");}
  catch(error){log(account,"停止指令尚未送达，后台任务仍可能运行；请重试或关闭本机后台窗口。"+error.message,true);}
  render();renderProjects();
}
$("stop").onclick = () => { void stop(active()); };
$("stop-all").onclick = () => { accounts.forEach(a => { void stop(a); }); };
$("keyword").oninput = renderProjects;
$("clear-projects").onclick = () => { if (active() && !active().job && !busy) { active().targets.clear(); render(); renderProjects(); } };
$("login-mode").onchange = () => {
  const sso = $("login-mode").value === "sso";
  $("password-label").textContent = sso ? "统一身份认证密码" : "GMIS 独立登录密码";
  $("password").placeholder = sso ? "sidportal.buct.edu.cn 的登录密码" : "GMIS /home/stulogin 的独立登录密码";
  $("username").placeholder = sso ? "统一身份认证学号" : "GMIS 独立登录学号";
  $("login-path").textContent = sso ? "统一身份认证 → i 北化 → 研究生系统 → 核验学号。" : "GMIS 独立登录 → 核验学号；仅用于该入口的独立密码。";
};
$("category").onchange = () => { renderProjects(); };
// Closing this status console intentionally leaves helper-owned tasks running.
setInterval(()=>{void pollTasks();},2000);
setInterval(() => { if ([...accounts.values()].some(a => a.job)) render(); }, 1000);
if (preview) {
  $("preview-banner").hidden = false;
  const row = {id: 101, mc: "前沿科学学术报告：从材料创新到绿色未来", bmkssj: "2026-10-18 14:00:00", bmjzsj: "2026-10-18 15:00:00", dd: "学术报告厅", rs: 120, bmrs: 32};
  for (const [index, name] of ["账号 A", "账号 B", "账号 C"].entries()) {
    const account = remember({id: "demo-" + index, label: name, masked: "DE••••0" + index, ready: true});
    account.rows = [{...row, category: "academic"}, {...row, id: 101, category: "labour", mc: "玉兰苑校园志愿服务", dd: "玉兰苑集合点"}];
    account.rows.forEach(row => account.targets.set(projectKey(row), {...row}));
    account.notice = index === 2 ? "等待匹配" : "项目已就绪";
  }
  $("category").value = "all";
  log(null, "多账号界面预览：同一控制台管理多个独立会话。");
  log(accounts.get("demo-0"), "已匹配学术报告；开始尝试时间默认提前 1 分钟。");
}
render(); renderProjects();
