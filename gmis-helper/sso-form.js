// Pure rendered-DOM inspection, shared by the helper and browser regression checks.
// Never read input values, passwords, hidden execution tokens or cookies here.
export function inspectSSOForm() {
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const inputs = [...document.querySelectorAll("input")];
  const selectorFor = el => {
    if (el.id) return `[id=${JSON.stringify(el.id)}]:visible`;
    if (el.type === "password") return 'input[type="password"]:visible';
    if (el.name) return `input[name=${JSON.stringify(el.name)}][type=${JSON.stringify(el.type)}]:visible`;
    if (el.placeholder) return `input[placeholder=${JSON.stringify(el.placeholder)}]:visible`;
    return null;
  };
  const fields = inputs.map((el, index) => ({index, type: el.type, visible: visible(el), disabled: el.disabled,
    selector: selectorFor(el),
    hint: [el.id, el.name, el.placeholder, el.getAttribute("formcontrolname"), el.getAttribute("autocomplete"),
      el.getAttribute("aria-label")].filter(Boolean).join(" ")})).filter(el => el.visible && !el.disabled);
  const password = fields.find(el => el.type === "password");
  const smsField = el => /sms|otp|短信|动态口令|一次性|one-time-code/i.test(el.hint);
  // SMS login also calls its input "验证码"; it is not an image challenge.
  const captcha = fields.find(el => !smsField(el) && /captcha|veri.?code|验证码|图形码|校验码/i.test(el.hint));
  const candidates = fields.filter(el => ["text", "tel", "email", "number", ""].includes(el.type) && el !== captcha);
  const username = candidates.find(el => /user|account|login.?name|学号|工号|学工号|账号|用户名|XH_GH/i.test(el.hint)) ||
    (password && [...candidates].reverse().find(el => el.index < password.index));
  const buttons = [...document.querySelectorAll("button,input[type='submit'],[role='button']")];
  // A submit button can be disabled until valid values are filled; it still identifies the form.
  const submit = buttons.findIndex(el => visible(el) && (el.id === "submitBtn" ||
    /^(?:立即)?登\s*录$|^sign\s*in$|^login$/i.test((el.textContent || el.value || "").trim())));
  const images = [...document.querySelectorAll("img,canvas")];
  const captchaImage = captcha ? images.findIndex(el => visible(el) && /captcha|veri.?code|验证码|校验码/i.test([el.id, el.className, el.getAttribute("src"), el.getAttribute("alt")].join(" "))) : -1;
  const notice = [...document.querySelectorAll(".ant-message-error,.ant-form-explain,.ant-form-item-explain-error,.el-message--error,.el-form-item__error,[role='alert'],#login-error-msg")]
    .filter(el => visible(el) || el.id === "login-error-msg").map(el => el.textContent).join(" ").trim();
  const interactiveChallenge =
    [...document.querySelectorAll("[role='dialog'],.ant-modal,.el-dialog,.geetest_panel,.yidun_modal")].filter(visible)
      .some(el => /拖动.{0,12}(滑块|拼图)|向右滑动|滑动.{0,12}验证|短信验证码|动态口令|人脸验证|扫码确认|二次认证/.test(el.innerText || ""));
  const interactive = fields.some(smsField) || interactiveChallenge;
  const passwordName = text => /^(用户名\s*密码|账号\s*密码(?:登录)?|用户名\s*密码登录|密码登录|账号登录)$/.test(text.trim());
  const tabs = [...document.querySelectorAll("[role='tab']")].filter(visible);
  const visibleTabs = tabs.map(el => el.textContent.trim().slice(0, 30));
  const passwordTab = tabs.find(el => passwordName(el.textContent));
  const passwordTabSelector = passwordTab?.getAttribute("aria-controls") ?
    `[role="tab"][aria-controls=${JSON.stringify(passwordTab.getAttribute("aria-controls"))}]:visible` : null;
  const selectedTab = [...document.querySelectorAll("[role='tab']")]
    .find(el => el.getAttribute("aria-selected") === "true")?.textContent.trim().slice(0, 30) || "";
  return {username: username?.index, password: password?.index, captcha: captcha?.index,
    usernameSelector: username?.selector, passwordSelector: password?.selector,
    captchaSelector: captcha?.selector, submitSelector: submit >= 0 && buttons[submit].id ? `[id=${JSON.stringify(buttons[submit].id)}]:visible` : null,
    captchaImage, submit, notice, interactive, interactiveChallenge, visibleTabs, passwordTabSelector,
    captchaHint: captcha?.hint || "", selectedTab};
}
