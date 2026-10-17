import {test} from "node:test";
import assert from "node:assert/strict";
import {PortalAPI} from "../api.js";

test("expired read may re-login and retry once", async () => {
  const api = new PortalAPI(null, () => ({}), () => {});
  let reads = 0, logins = 0;
  api.login = async () => { logins++; };
  const result = await api.withAuth(async () => {
    reads++; if (reads === 1) throw new Error("SESSION_EXPIRED");
    return "rows";
  });
  assert.equal(result, "rows"); assert.equal(reads, 2); assert.equal(logins, 1);
});
test("submission is never automatically retried on expired session", async () => {
  const api = new PortalAPI(null, () => ({}), () => {});
  let writes = 0, logins = 0;
  api.request = async () => { writes++; throw new Error("SESSION_EXPIRED"); };
  api.assertIdentity = async () => "account-a";
  api.login = async () => { logins++; };
  await assert.rejects(api.submit("42", "1234"), /SESSION_EXPIRED/);
  assert.equal(writes, 1); assert.equal(logins, 0);
});
test("academic category uses its own lists and GET preflight route", async () => {
  const api = new PortalAPI(null, () => ({}), () => {});
  api.setCategory("academic");
  api.assertIdentity = async () => "account-a";
  const calls = [];
  api.request = async (route, data) => {
    calls.push([route, data]);
    if (route === "xshdbm_sfkysq") return {sign: "1"};
    return {rows: []};
  };
  await api.available(); await api.enrolled();
  assert.equal(await api.preflight("42"), true);
  assert.deepEqual(calls.map(c => c[0]), ["xshdbm_sqlist", "xshdbm_cklist", "xshdbm_sfkysq"]);
  assert.deepEqual(calls[2][1], {id: "42"});
});
test("account mismatch prevents a write entirely", async () => {
  const api = new PortalAPI(null, () => ({username: "account-a"}), () => {});
  api.boundAccount = "account-a"; api.identity = async () => "account-b";
  let writes = 0; api.request = async () => { writes++; };
  await assert.rejects(api.submit("42", "1234"), /不一致/);
  assert.equal(writes, 0);
});
test("unknown academic preflight response is not treated as permission", async () => {
  const api = new PortalAPI(null, () => ({}), () => {});
  api.setCategory("academic"); api.assertIdentity = async () => "account-a";
  api.request = async () => ({});
  await assert.rejects(api.preflight("42"), /预检没有返回明确许可/);
});
test("stop/deadline guard runs after asynchronous account check and before write", async () => {
  const api = new PortalAPI(null, () => ({}), () => {});
  let checked = false, writes = 0;
  api.assertIdentity = async () => { checked = true; };
  api.request = async () => { writes++; };
  await assert.rejects(api.submit("42", "1234", () => {
    assert.equal(checked, true); throw new Error("stopped");
  }), /stopped/);
  assert.equal(writes, 0);
});
test("ready ignores stale document replies during navigation", async t => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  globalThis.chrome = {tabs: {get: async () => ({status: "complete", url: "https://gmis.buct.edu.cn/home/stulogin"})}};
  const api = new PortalAPI(null, () => ({}), () => {});
  api.tabId = 1;
  let replies = 0;
  api.send = async () => ++replies === 1
    ? {state: "student", href: "https://gmis.buct.edu.cn/student/default/index"}
    : {state: "login", href: "https://gmis.buct.edu.cn/home/stulogin"};
  assert.equal((await api.ready(2000)).state, "login");
  assert.equal(replies, 2);
});
test("missing raw identity falls back to a freshly rendered home", async () => {
  const api = new PortalAPI(null, () => ({}), () => {});
  api.send = async () => { const error = new Error("missing"); error.code = "IDENTITY_NOT_FOUND"; throw error; };
  let rendered = 0;
  api.renderedIdentity = async () => { rendered++; return "account-a"; };
  assert.equal(await api.identity(), "account-a");
  assert.equal(rendered, 1);
});
test("expired authentication is not mistaken for missing markup", async () => {
  const api = new PortalAPI(null, () => ({}), () => {});
  api.send = async () => { throw new Error("SESSION_EXPIRED"); };
  let rendered = 0; api.renderedIdentity = async () => { rendered++; return "account-a"; };
  await assert.rejects(api.identity(), /SESSION_EXPIRED/);
  assert.equal(rendered, 0);
});
test("rendered identity never reuses stale documents and closes only its own tabs", async t => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  const created = [], removed = [];
  globalThis.chrome = {tabs: {
    create: async options => { created.push(options); return {id: 100 + created.length}; },
    get: async () => ({status: "complete"}),
    sendMessage: async (id, message) => {
      assert.equal(message.type, "GMIS_IDENTITY_DOM");
      return {ok: true, data: {account: id === 101 ? "account-a" : "account-b"}};
    },
    remove: async id => { removed.push(id); }
  }};
  const api = new PortalAPI(null, () => ({}), () => {});
  assert.equal(await api.renderedIdentity(), "account-a");
  assert.equal(await api.renderedIdentity(), "account-b");
  assert.deepEqual(removed, [101, 102]);
  assert.equal(created.length, 2);
  assert.equal(created[0].url, "https://gmis.buct.edu.cn/student/default/home");
});
test("message errors preserve the identity diagnostic code", async t => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  globalThis.chrome = {tabs: {sendMessage: async () => ({ok: false, error: "missing", code: "IDENTITY_NOT_FOUND"})}};
  const api = new PortalAPI(null, () => ({}), () => {}); api.tabId = 1;
  await assert.rejects(api.send({type: "GMIS_IDENTITY"}), error => error.code === "IDENTITY_NOT_FOUND");
});
