import {matches, parseTime, inputTime, countdown} from "./core.js";
import {PortalAPI} from "./api.js";
import {LocalOCR} from "./ocr.js";
import {Engine, Cancelled} from "./engine.js";
import {getCategory, maskAccount} from "./categories.js";

const $ = id => document.getElementById(id);
const preview = new URLSearchParams(location.search).has("preview");
let rows = [], selected = null, busy = false, engine = null, taskState = null;
let locked = false;
let manualAttemptTime = false;
let categoryKey = "labour";
const categorySettings = {labour: {keyword: ""}, academic: {keyword: ""}};
const timestamp = () => new Date().toLocaleTimeString("zh-CN", {hour12: false});

function log(message, error = false) {
  $("logs").querySelector(".log-empty")?.remove();
  const entry = document.createElement("div"); entry.className = `log${error ? " error" : ""}`;
  const time = document.createElement("time"); time.textContent = timestamp();
  const content = document.createElement("span"); content.textContent = message;
  entry.append(time, content); $("logs").append(entry);
  if ($("logs").children.length > 150) $("logs").firstElementChild.remove();
  $("logs").scrollTop = $("logs").scrollHeight;
}
function notice(error) {
  const text = error.message === "SESSION_EXPIRED" ? "登录失效，请重新连接学校系统。" : error.message;
  log(text, true); $("progress-title").textContent = "需要处理";
  $("progress-description").textContent = text;
  $("phase").textContent = "已停止";
}
const ocr = new LocalOCR(text => { $("ocr-status").textContent = text; });
const api = preview ? null : new PortalAPI(ocr,
  () => ({username: $("username").value.trim(), password: $("password").value}), log);

function updateButtons() {
  $("connect").disabled = busy || preview;
  $("connect-account").disabled = busy || preview;
  $("keyword").disabled = busy;
  $("category").disabled = busy;
  $("profile-label").disabled = busy;
  $("attempt-at").disabled = busy || !selected;
  $("default-at").disabled = busy || !selected;
  for (const id of ["retry-interval", "max-attempts", "retry-full"]) $(id).disabled = busy;
  $("start").disabled = busy || !selected || preview;
  $("check").disabled = busy || !selected || preview;
  $("stop").disabled = !locked;
  $("username").disabled = busy; $("password").disabled = busy;
}
function showTarget(row, preserveTiming = false) {
  const keepTime = preserveTiming && manualAttemptTime && row && String(row.id) === String(selected?.id);
  selected = row;
  if (!keepTime) {
    manualAttemptTime = false;
    $("attempt-at").value = row ? inputTime(parseTime(row.bmkssj) - 60000) : "";
  }
  $("target-name").textContent = row?.mc || "从右侧列表选择一个项目";
  $("target-start").textContent = row?.bmkssj || "—";
  if (!busy && row) {
    taskState = {phase: "ready", start: parseTime(row.bmkssj), attemptAt: parseTime($("attempt-at").value)};
    $("phase").textContent = "目标已选";
    $("progress-title").textContent = "已准备好，等待启动";
    $("progress-description").textContent = "默认在开放前 1 分钟进入尝试，也可修改下方时间。";
  } else if (!busy && !row) {
    taskState = null;
    $("countdown").textContent = "--:--:--";
    $("phase").textContent = "等待选择";
    $("progress-title").textContent = "准备好后，交给助手";
    $("progress-description").textContent = "从匹配结果中选择你想参加的活动。";
  }
  updateButtons();
}
function renderProjects() {
  const query = $("keyword").value;
  const filtered = query.trim() ? rows.filter(row => matches(row.mc, query)) : rows;
  $("result-count").textContent = String(filtered.length);
  $("projects").replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "empty";
    const title = document.createElement("h3"); title.textContent = rows.length ? "没有匹配的项目" : "还没有项目列表";
    const hint = document.createElement("p"); hint.textContent = "试试更短的关键词，或连接后重新查询。";
    empty.append(title, hint); $("projects").append(empty);
  }
  for (const row of filtered) {
    const button = document.createElement("button"); button.type = "button";
    button.className = `project${String(selected?.id) === String(row.id) ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(String(selected?.id) === String(row.id)));
    button.disabled = busy;
    const radio = document.createElement("span"); radio.className = "radio";
    const content = document.createElement("div"); content.className = "project-content";
    const title = document.createElement("h3"); title.textContent = row.mc;
    const description = document.createElement("p"); description.textContent = `${row.dd || "地点待定"} · ID ${row.id}`;
    const meta = document.createElement("div"); meta.className = "meta";
    for (const text of [`开放 ${row.bmkssj}`, `名额 ${row.bmrs ?? "—"} / ${row.rs ?? "—"}`]) {
      const span = document.createElement("span"); span.textContent = text; meta.append(span);
    }
    content.append(title, description, meta);
    const tag = document.createElement("span"); tag.className = "tag";
    try {
      const full = Number(row.bmrs) >= Number(row.rs);
      const open = Date.now() >= parseTime(row.bmkssj);
      tag.textContent = Date.now() >= parseTime(row.bmjzsj) ? "已截止" : full ? "已满额" : open ? "报名中" : "待开放";
      if (full) tag.classList.add("full"); else if (open) tag.classList.add("open");
    } catch { tag.textContent = "时间待核对"; }
    button.append(radio, content, tag);
    button.addEventListener("click", () => {
      if (busy) return;
      try { showTarget(row); renderProjects(); }
      catch (error) { notice(error); }
    });
    $("projects").append(button);
  }
}
function setState(state) {
  taskState = {...taskState, ...state};
  const labels = {waiting: "等待开放", running: "正在报名", success: "报名成功"};
  $("phase").textContent = labels[state.phase] || state.phase;
  if (state.phase === "waiting") {
    $("progress-title").textContent = "目标已锁定，等待尝试时间";
    $("progress-description").textContent = state.project.mc;
    $("target-start").textContent = state.project.bmkssj;
    if (!manualAttemptTime) $("attempt-at").value = inputTime(state.attemptAt);
  } else if (state.phase === "running") {
    $("progress-title").textContent = `${state.early ? "提前尝试" : "正在报名"} · ${state.attempt}/${state.maxAttempts}`;
    $("progress-description").textContent = state.early ? "尚未到页面标注的开放时间，继续按间隔尝试，以服务器结果为准。" : "识别验证码、提交报名，并核验学校系统的结果。";
  } else if (state.phase === "success") {
    $("progress-title").textContent = "报名成功";
    $("progress-description").textContent = "已在学校系统的成功报名列表中确认目标项目。";
    document.title = "✓ 报名成功 · 北化报名助手";
  }
}
async function connect() {
  busy = true; updateButtons(); renderProjects();
  $("session-status").textContent = "正在连接…";
  try {
    rows = await api.connect();
    $("session-status").textContent = "会话有效 · 已连接";
    $("session-dot").classList.add("on");
    $("bound-account").textContent = maskAccount(api.boundAccount);
    log(`${getCategory(categoryKey).label}已连接，账号 ${maskAccount(api.boundAccount)}，读取到 ${rows.length} 个项目。`);
    const previous = selected && rows.find(row => String(row.id) === String(selected.id));
    showTarget(previous || null, true);
  } catch (error) {
    rows = []; selected = null;
    $("target-name").textContent = "从右侧列表选择一个项目";
    $("target-start").textContent = "—";
    $("bound-account").textContent = "尚未验证";
    $("attempt-at").value = "";
    taskState = null; $("countdown").textContent = "--:--:--";
    $("session-status").textContent = "连接未完成";
    $("session-dot").classList.remove("on");
    notice(error);
  } finally { busy = false; updateButtons(); renderProjects(); }
}
async function checkProject() {
  if (busy || !selected || preview) return;
  busy = true; updateButtons(); renderProjects();
  try {
    const id = String(selected.id);
    const current = (await api.available()).find(row => String(row.id) === id);
    const enrolled = (await api.enrolled()).some(row => String(row.hdid) === id);
    if (!current && !enrolled) throw new Error("目标已不在当前账号的可报名列表中");
    const allowed = current ? await api.preflight(id) : true;
    log(`只读检查完成：账号 ${maskAccount(api.boundAccount)} · ${getCategory(categoryKey).label} · ${enrolled ? "已报名" : allowed ? "预检通过" : "预检尚未放行"}。未获取报名验证码、未提交报名。`);
    $("phase").textContent = "检查完成";
    $("progress-title").textContent = enrolled ? "目标已在成功报名列表" : "账号和项目已核对";
    $("progress-description").textContent = allowed ? "只读检查完成，未提交报名。" : "服务器预检尚未放行，未提交报名。";
  } catch (error) { notice(error); }
  finally { busy = false; updateButtons(); renderProjects(); }
}
async function start() {
  if (busy || !selected || preview) return;
  const settings = {maxAttempts: Number($("max-attempts").value), intervalSeconds: Number($("retry-interval").value),
    retryFull: $("retry-full").checked};
  if (manualAttemptTime) settings.attemptAt = parseTime($("attempt-at").value);
  if (!Number.isInteger(settings.maxAttempts) || settings.maxAttempts < 1 || settings.maxAttempts > 99999 ||
      !Number.isFinite(settings.intervalSeconds) || settings.intervalSeconds < 0.01 || settings.intervalSeconds > 60) {
    throw new Error("最多尝试须为 1–99999 次，重试间隔须为 0.01–60 秒");
  }
  // Locks protect against multiple dashboards without persisting credentials.
  await navigator.locks.request("gmis-registration", {ifAvailable: true}, async lock => {
    if (!lock) { notice(new Error("另一个控制台正在执行任务，请先停止那个任务")); return; }
    locked = true; busy = true;
    document.title = "执行中 · 北化报名助手";
    engine = new Engine({api, ocr, log, state: setState,
      journal: record => chrome.storage.local.set({lastTask: {...record, category: categoryKey,
        account: maskAccount(api.boundAccount), at: Date.now()}})});
    const self = await chrome.tabs.getCurrent();
    try {
      updateButtons(); renderProjects();
      chrome.power.requestKeepAwake("system");
      if (self?.id) await chrome.tabs.update(self.id, {autoDiscardable: false});
      log("正在预热本地 OCR，请保持控制台打开。");
      log(`执行配置：${$("profile-label").value.trim() || "未命名配置"} · ${getCategory(categoryKey).label} · 账号 ${maskAccount(api.boundAccount)}`);
      // Load the model before waiting for the opening time.
      await ocr.prepare();
      if (engine.cancelled) throw new Cancelled();
      const task = engine.run(selected, settings);
      updateButtons();
      await task;
    } catch (error) {
      if (error instanceof Cancelled) {
        $("phase").textContent = "已停止"; $("progress-title").textContent = "任务已停止";
        $("progress-description").textContent = "不会再发起新的报名提交；已发送的请求无法撤回。";
        log("已停止后续操作。若已有请求发出，请在学校页面核对结果。");
      } else notice(error);
    } finally {
      locked = false; busy = false;
      chrome.power.releaseKeepAwake();
      if (self?.id) await chrome.tabs.update(self.id, {autoDiscardable: true}).catch(() => {});
      updateButtons(); renderProjects();
    }
  });
}

$("connect").addEventListener("click", () => { if (!preview) connect(); });
$("connect-account").addEventListener("click", () => {
  if (preview || busy) return;
  if (!$("username").value.trim() || !$("password").value) {
    notice(new Error("请在自动登录设置中填写学号和独立登录密码")); return;
  }
  connect();
});
$("password").addEventListener("keydown", event => {
  if (event.key === "Enter" && !busy && !preview) $("connect-account").click();
});
$("keyword").addEventListener("input", () => {
  showTarget(null); renderProjects();
  categorySettings[categoryKey].keyword = $("keyword").value;
  if (!preview) chrome.storage.local.set({categorySettings});
});
$("category").addEventListener("change", () => {
  if (busy) return;
  categorySettings[categoryKey].keyword = $("keyword").value;
  categoryKey = $("category").value;
  getCategory(categoryKey);
  if (api) api.setCategory(categoryKey);
  rows = preview ? sampleRows(categoryKey) : [];
  $("keyword").value = categorySettings[categoryKey].keyword;
  $("keyword").placeholder = categoryKey === "academic" ? "例如：人工智能 科研" : "例如：昌平 场地维护";
  showTarget(null); renderProjects();
  log(`已切换到${getCategory(categoryKey).label}，请重新查询并选择项目。`);
  if (!preview) chrome.storage.local.set({categoryKey, categorySettings});
});
$("profile-label").addEventListener("input", () => {
  if (!preview) chrome.storage.local.set({profileLabel: $("profile-label").value.trim()});
});
$("attempt-at").addEventListener("input", () => {
  manualAttemptTime = true;
  try { if (taskState) taskState.attemptAt = parseTime($("attempt-at").value); }
  catch { if (taskState) taskState.attemptAt = null; $("countdown").textContent = "--:--:--"; }
});
$("default-at").addEventListener("click", () => {
  if (!selected || busy) return;
  manualAttemptTime = false;
  $("attempt-at").value = inputTime(parseTime(selected.bmkssj) - 60000);
  if (taskState) taskState.attemptAt = parseTime($("attempt-at").value);
});
for (const id of ["retry-interval", "max-attempts", "retry-full"]) $(id).addEventListener("change", () => {
  if (!preview) chrome.storage.local.set({retrySettings: {intervalSeconds: Number($("retry-interval").value),
    maxAttempts: Number($("max-attempts").value), retryFull: $("retry-full").checked}});
});
$("profile-help-button").addEventListener("click", () => {
  $("profile-help").hidden = !$("profile-help").hidden;
  $("profile-help-button").setAttribute("aria-expanded", String(!$("profile-help").hidden));
});
$("keyword").addEventListener("keydown", event => { if (event.key === "Enter" && !busy && !preview) connect(); });
$("open-site").addEventListener("click", () => { if (!preview) api.open(); });
$("start").addEventListener("click", () => start().catch(notice));
$("check").addEventListener("click", () => checkProject().catch(notice));
$("stop").addEventListener("click", () => { if (engine) engine.stop(); });
window.addEventListener("beforeunload", event => {
  if (locked) { event.preventDefault(); event.returnValue = ""; }
});
setInterval(() => {
  const waiting = taskState?.phase === "waiting" || taskState?.phase === "ready";
  $("clock-label").textContent = waiting ? "距离开始尝试" : "距离报名开放";
  const time = waiting ? taskState?.attemptAt : taskState?.start;
  if (time) $("countdown").textContent = countdown(time - Date.now());
}, 250);

function sampleRows(key) {
  const date = new Date(Date.now() + 3600000).toLocaleString("sv-SE", {timeZone: "Asia/Shanghai"});
  const end = new Date(Date.now() + 86400000).toLocaleString("sv-SE", {timeZone: "Asia/Shanghai"});
  if (key === "academic") return [
    {id: 90001, mc: "人工智能与科研创新学术报告（演示）", dd: "昌平校区求真讲堂", bmkssj: date, bmjzsj: end, bmrs: 80, rs: 200},
    {id: 90002, mc: "科研写作与学术交流专题讲座（演示）", dd: "朝阳校区会议中心", bmkssj: date, bmjzsj: end, bmrs: 100, rs: 100}
  ];
  return [
    {id: 14415, mc: "昌平校区室内场地维护与保养实践活动", dd: "昌平校区体育馆 1 号门", bmkssj: date, bmjzsj: end, bmrs: 0, rs: 10},
    {id: 14428, mc: "玉兰苑垃圾下楼（限男生）", dd: "昌平校区 · 紫竹苑学生公寓", bmkssj: date, bmjzsj: end, bmrs: 0, rs: 15},
    {id: 14425, mc: "昌平校区教学楼控烟巡查", dd: "第二教学楼 C 座一层值班室", bmkssj: date, bmjzsj: end, bmrs: 20, rs: 20}
  ];
}
if (preview) {
  $("preview-banner").hidden = false;
  $("keyword").value = "昌平";
  categorySettings.labour.keyword = "昌平";
  rows = sampleRows(categoryKey);
  $("profile-label").value = "账号 A · 独立 Chrome 配置";
  $("bound-account").textContent = "演示账号 · 未连接";
  $("session-status").textContent = "预览数据 · 未连接学校";
  $("session-dot").classList.add("on");
  showTarget(rows[0]); renderProjects();
  log("界面预览已就绪。实际使用时，连接后读取学校项目列表。");
  log("选择项目后，可编辑开始尝试时间与重试参数。");
  $("open-site").disabled = true;
} else {
  const saved = await chrome.storage.local.get(["keyword", "lastTask", "categoryKey", "categorySettings", "profileLabel", "retrySettings"]);
  for (const key of ["labour", "academic"]) {
    categorySettings[key].keyword = String(saved.categorySettings?.[key]?.keyword || (key === "labour" ? saved.keyword || "" : ""));
  }
  categoryKey = ["labour", "academic"].includes(saved.categoryKey) ? saved.categoryKey : "labour";
  $("category").value = categoryKey; api.setCategory(categoryKey);
  $("keyword").value = categorySettings[categoryKey].keyword;
  $("keyword").placeholder = categoryKey === "academic" ? "例如：人工智能 科研" : "例如：昌平 场地维护";
  $("profile-label").value = saved.profileLabel || "";
  $("retry-interval").value = saved.retrySettings?.intervalSeconds ?? 2;
  $("max-attempts").value = saved.retrySettings?.maxAttempts ?? 90;
  $("retry-full").checked = Boolean(saved.retrySettings?.retryFull);
  if (saved.lastTask && saved.lastTask.phase !== "success") {
    log("上次任务已中断，不会自动恢复提交。重新连接后请核对学校报名结果。");
  }
  updateButtons();
}
