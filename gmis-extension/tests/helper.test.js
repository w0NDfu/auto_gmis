import {test} from "node:test";
import assert from "node:assert/strict";
import {HelperClient, HelperAPI, QueuedOCR} from "../helper-api.js";

test("helper adapter carries the account/run binding on every request", async () => {
  const calls = [], client = {call: async (path, args) => { calls.push({path, args}); return {rows: []}; }};
  const a = new HelperAPI(client, "account-a", "labour"), b = new HelperAPI(client, "account-b", "academic");
  a.runId = "run-a"; b.runId = "run-b";
  await Promise.all([a.available(), b.enrolled()]);
  assert.equal(calls[0].args.id, "account-a"); assert.equal(calls[0].args.runId, "run-a");
  assert.equal(calls[1].args.id, "account-b"); assert.equal(calls[1].args.category, "academic");
});
test("submit response loss never causes helper adapter to retry the write", async () => {
  let calls = 0;
  const api = new HelperAPI({call: async () => { calls++; throw Object.assign(new Error("expired"), {code: "SESSION_EXPIRED"}); }}, "a", "labour");
  await assert.rejects(api.submit(42, "1234")); assert.equal(calls, 1);
  await assert.rejects(api.submit(42, "1234", () => { throw new Error("cancelled"); }), /cancelled/);
  assert.equal(calls, 1);
});
test("shared OCR worker serializes recognition and survives a rejected job", async () => {
  let working = 0, peak = 0; const seen = [];
  const ocr = new QueuedOCR({recognize: async image => {
    working++; peak = Math.max(working, peak); await Promise.resolve(); working--; seen.push(image);
    if (image === "bad") throw new Error("mock OCR failure"); return image;
  }});
  const results = await Promise.allSettled([ocr.recognize("bad"), ocr.recognize("1234"), ocr.recognize("5678")]);
  assert.equal(peak, 1); assert.deepEqual(seen, ["bad", "1234", "5678"]);
  assert.equal(results[1].value, "1234"); assert.equal(results[2].value, "5678");
});
test("pairing token is only an Authorization header and credentials go only to loopback", async () => {
  let request;
  const client = new HelperClient("secret-pair", async (url, options) => { request = {url, options}; return {ok: true, json: async () => ({ok: true, data: {id: "a"}})}; });
  await client.call("/accounts/add", {username: "DEMO0001", password: "fake-pw"});
  assert.equal(request.url, "http://127.0.0.1:8767/accounts/add");
  assert.equal(request.options.headers.Authorization, "Bearer secret-pair");
  assert.ok(!request.url.includes("secret-pair"));
  assert.equal(JSON.parse(request.options.body).password, "fake-pw");
});

test("login warms OCR before fetching a short-lived challenge, passes its binding and retries only captcha errors", async () => {
  const order = []; let attempts = 0;
  const client = {call: async (path, args) => {
    if (path === "/login/challenge") { order.push("challenge"); return {image: "image", challengeId: "bound-image"}; }
    assert.equal(args.challengeId, "bound-image"); order.push("submit");
    if (++attempts === 1) throw Object.assign(new Error("验证码错误"), {code: "LOGIN_CAPTCHA"});
    return {ready: true};
  }};
  const ocr = {prepare: async () => order.push("warmup"), recognize: async () => { order.push("ocr"); return "1234"; }};
  const api = new HelperAPI(client, "a", "labour", ocr);
  assert.equal((await api.login()).ready, true);
  assert.deepEqual(order, ["warmup", "challenge", "ocr", "submit", "challenge", "ocr", "submit"]);
});

test("credential rejection and unknown timeout are not automatically repeated", async () => {
  for (const code of ["LOGIN_CREDENTIALS", "LOGIN_TIMEOUT", "LOGIN_REJECTED"]) {
    let writes = 0;
    const api = new HelperAPI({call: async path => {
      if (path === "/login/challenge") return {image: "image", challengeId: "c"};
      writes++; throw Object.assign(new Error("school notice"), {code});
    }}, "a", "labour", {recognize: async () => "1234"});
    await assert.rejects(api.login(), error => error.code === code);
    assert.equal(writes, 1);
  }
});

test("SSO without an image challenge never invokes OCR and passes the bound challenge", async () => {
  let images = 0, writes = 0;
  const api = new HelperAPI({call: async (path, args) => {
    if (path === "/login/challenge") return {image: null, requiresCaptcha: false, loginMode: "sso", challengeId: "sso-c"};
    assert.equal(args.challengeId, "sso-c"); assert.equal(args.code, ""); writes++; return {ready: true};
  }}, "account-a", "academic", {prepare: async () => {}, recognize: async () => { images++; return "1234"; }});
  assert.equal((await api.login()).ready, true);
  assert.equal(images, 0); assert.equal(writes, 1);
});
