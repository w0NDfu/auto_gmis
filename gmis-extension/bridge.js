/* Only the extension can send these messages. No window/postMessage bridge. */
(() => {
  const controllers = new Set();
  const isLogin = () => /\/home\/stulogin\/?$/i.test(location.pathname);

  async function request(url, options) {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {...options, credentials: "same-origin",
        cache: "no-store", redirect: "follow", signal: controller.signal});
      if (response.redirected && !new URL(response.url).pathname.startsWith("/student/")) {
        throw new Error("SESSION_EXPIRED");
      }
      if ([401, 403].includes(response.status)) throw new Error("SESSION_EXPIRED");
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return response;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  const toDataURL = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取验证码图片"));
    reader.readAsDataURL(blob);
  });

  function imageSnapshot(image) {
    if (!image?.complete || !image.naturalWidth) throw new Error("登录验证码尚未加载");
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function setInput(id, value) {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLInputElement)) throw new Error(`未找到登录字段 ${id}`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", {bubbles: true}));
    element.dispatchEvent(new Event("change", {bubbles: true}));
  }

  async function handle(message) {
    if (message.type === "GMIS_STATUS") {
      if (document.getElementById("UserId") && document.getElementById("Password")) {
        const notices = [...document.querySelectorAll(".messager-body, .validation-summary-errors")]
          .filter(e => e.getClientRects().length).map(e => e.textContent).join(" ");
        return {state: "login", href: location.href, notice: notices,
          image: imageSnapshot(document.getElementById("imgVerifi"))};
      }
      if (location.pathname.startsWith("/student/")) return {state: "student", href: location.href};
      return {state: "other", href: location.href};
    }
    if (message.type === "GMIS_LOGIN_REFRESH") {
      if (!isLogin()) throw new Error("当前不是独立登录页");
      for (const alert of document.querySelectorAll(".messager-body")) {
        if (!alert.getClientRects().length) continue;
        const button = [...alert.querySelectorAll(".messager-button a")]
          .find(element => element.textContent.trim() === "确定");
        button?.click();
      }
      const image = document.getElementById("imgVerifi");
      if (!image) throw new Error("未找到登录验证码");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("登录验证码加载超时")), 10000);
        image.onload = () => { clearTimeout(timer); resolve(); };
        image.onerror = () => { clearTimeout(timer); reject(new Error("登录验证码加载失败")); };
        image.src = `/Home/VerificationCode?t=${Date.now()}`;
      });
      return {image: imageSnapshot(image)};
    }
    if (message.type === "GMIS_LOGIN_SUBMIT") {
      if (!isLogin()) throw new Error("当前不是独立登录页");
      if (!/^\d{4}$/.test(message.code)) throw new Error("验证码格式无效");
      if (imageSnapshot(document.getElementById("imgVerifi")) !== message.image) {
        throw new Error("登录验证码发生变化，请重试");
      }
      const button = document.querySelector(".btn");
      if (!button) throw new Error("未找到登录按钮");
      setInput("UserId", message.username);
      setInput("Password", message.password);
      setInput("VeriCode", message.code);
      // Reply before the navigation tears down the message channel.
      setTimeout(() => button.click(), 40);
      return {submitted: true};
    }
    if (message.type === "GMIS_CANCEL_READS") {
      for (const controller of controllers) controller.abort();
      return {cancelled: true};
    }
    if (message.type === "GMIS_IDENTITY") {
      const response = await request("/student/default/home", {});
      const html = globalThis.GMIS_IDENTITY_PARSER.decodeHtml(await response.arrayBuffer(), response.headers.get("content-type"));
      const doc = new DOMParser().parseFromString(html, "text/html");
      const account = globalThis.GMIS_IDENTITY_PARSER.readDocument(doc);
      return {account};
    }
    if (message.type === "GMIS_IDENTITY_DOM") {
      if (isLogin()) throw new Error("SESSION_EXPIRED");
      if (location.pathname.toLowerCase().replace(/\/$/, "") !== "/student/default/home") {
        throw new Error("账号渲染核验仅允许读取学校主页");
      }
      const account = globalThis.GMIS_IDENTITY_PARSER.readDocument(document);
      return {account};
    }
    if (message.type !== "GMIS_REQUEST") throw new Error("不支持的命令");
    if (!location.pathname.startsWith("/student/")) throw new Error("SESSION_EXPIRED");
    const categoryKey = message.category || "labour";
    if (!Object.hasOwn(globalThis.GMIS_CATALOG, categoryKey)) throw new Error("未知的报名类别");
    const category = globalThis.GMIS_CATALOG[categoryKey];
    if (message.route === "captcha") {
      const response = await request(`/Home/VerificationCode?t=${Date.now()}`, {});
      if (!(response.headers.get("content-type") || "").startsWith("image/")) {
        throw new Error("SESSION_EXPIRED");
      }
      return {image: await toDataURL(await response.blob())};
    }
    if (![category.available, category.enrolled, category.submit, category.preflight].filter(Boolean).includes(message.route)) {
      throw new Error("接口不属于当前报名类别");
    }
    let data = {};
    if (message.route === category.submit) {
      if (!/^\d+$/.test(String(message.data?.id)) || !/^\d{4}$/.test(message.data?.VeriCode)) {
        throw new Error("报名参数无效");
      }
      data = {id: String(message.data.id), VeriCode: message.data.VeriCode};
    }
    let url = `/student/yggl/${message.route}`;
    const options = {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"}, body: new URLSearchParams(data).toString()};
    if (message.route === category.preflight) {
      if (!/^\d+$/.test(String(message.data?.id))) throw new Error("预检项目参数无效");
      url += "?" + new URLSearchParams({id: String(message.data.id)});
      options.method = "GET"; delete options.body;
    }
    const response = await request(url, options);
    try { return await response.json(); }
    catch { throw new Error("SESSION_EXPIRED"); }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message?.type?.startsWith("GMIS_")) return;
    handle(message).then(data => respond({ok: true, data}),
      error => respond({ok: false, error: error.message || "页面请求失败", code: error.code}));
    return true;
  });
})();
