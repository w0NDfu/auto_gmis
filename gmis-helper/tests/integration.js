import {test} from "node:test";
import assert from "node:assert/strict";
import {AccountManager} from "../manager.js";
import {HelperAPI, QueuedOCR} from "../../gmis-extension/helper-api.js";
import {Engine} from "../../gmis-extension/engine.js";

test("two full engine tasks share one browser but keep captcha, cookies and enrollment isolated", async () => {
  const contexts = [], submissions = [];
  const target = {id: 42, mc: "模拟学术报告", bmkssj: "2026-10-17 12:00:00", bmjzsj: "2026-10-17 14:00:00"};
  const now = () => Date.parse("2026-10-17T12:00:00+08:00");
  let launches = 0;
  const manager = new AccountManager(async () => {
    launches++;
    return {newContext: async () => {
      const context = {code: contexts.length ? "5678" : "1234", enrolled: false, reads: 0, writes: 0,
        newPage: async () => ({setDefaultTimeout() {}, on() {}}), close: async () => {},
        request: {fetch: async (url, options) => {
          await Promise.resolve(); context.reads++;
          let result, image = false;
          if (url.includes("VerificationCode")) { image = true; result = Buffer.from(context.code); }
          else if (url.includes("_sqlist")) result = {rows: [{...target}]};
          else if (url.includes("_cklist")) result = {rows: context.enrolled ? [{hdid: 42}] : []};
          else if (url.includes("sfkysq")) result = {sign: "1"};
          else if (url.endsWith("xshdbm_bm")) {
            assert.equal(options.form.VeriCode, context.code, "captcha must come from the submitting account's context");
            context.enrolled = true; context.writes++; submissions.push(context.code); result = {zt: "1"};
          } else throw new Error("unexpected route");
          return {status: () => 200, ok: () => true, headers: () => ({"content-type": image ? "image/png" : "application/json"}),
            json: async () => result, body: async () => result, dispose: async () => {}};
        }}};
      contexts.push(context); return context;
    }, close: async () => {}};
  }, {now});
  const publicAccounts = await Promise.all(["DEMO0001", "DEMO0002"].map(username => manager.create({username, password: "mock"})));
  publicAccounts.forEach(a => { manager.get(a.id).ready = true; });
  const ocr = new QueuedOCR({recognize: async image => Buffer.from(image.split(",")[1], "base64").toString()});
  const client = {call: (path, args) => {
    if (path !== "/request") throw new Error("unexpected helper route");
    return manager.request(args.id, args);
  }};
  const results = await Promise.all(publicAccounts.map(async account => {
    const api = new HelperAPI(client, account.id, "academic", ocr);
    api.runId = manager.start(account.id).runId;
    const engine = new Engine({api, ocr, now, sleep: async () => {}});
    try { return await engine.run(target, {intervalSeconds: .01}); }
    finally { manager.stop(account.id, api.runId); }
  }));
  assert.equal(launches, 1); assert.equal(contexts.length, 2);
  assert.ok(results.every(r => r.success));
  assert.deepEqual(submissions.sort(), ["1234", "5678"]);
  assert.ok(contexts.every(c => c.writes === 1 && c.enrolled));
});
