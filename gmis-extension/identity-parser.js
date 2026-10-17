// Runs in both the content script and offline browser regression test.
(() => {
  const clean = value => String(value || "").normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]/g, "");
  function uniqueAccount(values) {
    const candidates = [...new Set(values.map(clean).filter(value => /^[A-Za-z0-9_-]{4,32}$/.test(value)))];
    if (candidates.length > 1) throw new Error("学校主页返回多个不同学号，已停止账号识别");
    return candidates[0] || "";
  }
  function readDocument(doc) {
    if (doc.getElementById("UserId") && doc.getElementById("Password")) {
      throw new Error("SESSION_EXPIRED");
    }
    // The real student home uses <dd id="xh">. Do not depend on translated labels.
    const explicit = uniqueAccount([...doc.querySelectorAll("#xh")]
      .map(element => element.textContent?.trim() || element.value));
    if (explicit) return explicit;
    const labeled = [];
    for (const dl of doc.querySelectorAll("dl")) {
      const label = clean(dl.querySelector("dt")?.textContent).replace(/[:：]/g, "");
      if (label !== "学号" && label !== "学生学号") continue;
      for (const dd of dl.querySelectorAll("dd")) labeled.push(dd.textContent);
    }
    const account = uniqueAccount(labeled);
    if (account) return account;
    const error = new Error("学校主页未返回可识别的学号字段");
    error.code = "IDENTITY_NOT_FOUND";
    throw error;
  }
  function decodeHtml(buffer, contentType = "") {
    const bytes = new Uint8Array(buffer);
    const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
    const declared = /charset\s*=\s*["']?([^\s;"'/>]+)/i.exec(contentType)?.[1]
      || /<meta\b[^>]*charset\s*=\s*["']?([^\s;"'/>]+)/i.exec(head)?.[1]
      || "utf-8";
    try { return new TextDecoder(declared).decode(bytes); }
    catch { return new TextDecoder("utf-8").decode(bytes); }
  }
  Object.defineProperty(globalThis, "GMIS_IDENTITY_PARSER", {value: Object.freeze({readDocument, decodeHtml}),
    configurable: false, writable: false});
})();
