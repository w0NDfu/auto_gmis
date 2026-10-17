const {readDocument, decodeHtml} = globalThis.GMIS_IDENTITY_PARSER;
const doc = html => new DOMParser().parseFromString(html, "text/html");
const lines = [];
function check(name, callback) {
  try { if (!callback()) throw new Error("结果不符"); lines.push(`PASS: ${name}`); }
  catch (error) { lines.push(`FAIL: ${name}: ${error.message}`); }
}
function rejects(html, expected) {
  try { readDocument(doc(html)); return false; } catch (e) { return expected.test(e.message); }
}
check("真实主页的 dd#xh 结构", () => readDocument(doc('<div id="userinfo"><dl><dt>学号：</dt><dd id="xh">2026000001</dd></dl></div>')) === "2026000001");
check("中文标签乱码不影响固定字段", () => readDocument(doc('<dl><dt>???</dt><dd id="xh">2026000001</dd></dl>')) === "2026000001");
check("清理不可见字符与全角数字", () => readDocument(doc('<dl><dd id="xh">２０２６\u200b０００００１</dd></dl>')) === "2026000001");
check("兼容嵌套中文标签", () => readDocument(doc('<dl><dt><span>学&nbsp;号 ：</span></dt><dd>2026000002</dd></dl>')) === "2026000002");
check("登录输入框不能充当登录身份", () => rejects('<input id="UserId" value="2026000001"><input id="Password"><dd id="xh">2026000001</dd>', /SESSION_EXPIRED/));
check("不从脚本或无关数字猜测学号", () => rejects('<script>const xh="2026000001";</script><p>2026000001</p>', /未返回/));
check("多个不同学号时停止", () => rejects('<dd id="xh">2026000001</dd><dd id="xh">2026000002</dd>', /多个不同/));
check("占位文本不能成为账号", () => rejects('<dd id="xh">暂无学号</dd>', /未返回/));
const encoder = new TextEncoder();
const makeGBK = prefix => new Uint8Array([...encoder.encode(prefix + '<dl><dt>'), 0xD1,0xA7,0xBA,0xC5,
  ...encoder.encode(':</dt><dd>2026000003</dd></dl>')]);
check("按响应 charset 解码 GB2312", () => readDocument(doc(decodeHtml(makeGBK("").buffer, "text/html;charset=gb2312"))) === "2026000003");
check("按 meta charset 解码 GBK", () => readDocument(doc(decodeHtml(makeGBK('<meta charset="gbk">').buffer, "text/html"))) === "2026000003");
document.getElementById("results").textContent = lines.join("\n") + `\n${lines.filter(s=>s.startsWith("PASS")).length}/${lines.length} passed`;
