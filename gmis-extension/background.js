import {LeaseKeeper, leaseCall} from "./run-heartbeat.js";

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "gmis-run-heartbeat" || port.sender?.id !== chrome.runtime.id ||
    port.sender?.url !== chrome.runtime.getURL("multi.html")) { port.disconnect(); return; }
  let keeper, closed = false;
  const notify = message => { if (!closed) { try { port.postMessage(message); } catch { /* Port closure revokes the lease. */ } } };
  port.onMessage.addListener(message => {
    if (message?.type !== "start" || keeper || closed) return;
    if (typeof message.token !== "string" || message.token.length > 256 || !message.token ||
      ![message.id, message.runId].every(value => typeof value === "string" && /^[\w-]{1,80}$/.test(value))) {
      notify({type: "failed", message: "续租通道参数无效", code: "INVALID_REQUEST"}); port.disconnect(); return;
    }
    const token = message.token;
    keeper = new LeaseKeeper({call: (path, args) => leaseCall(token, path, args), notify});
    void keeper.start({id: message.id, runId: message.runId});
  });
  port.onDisconnect.addListener(() => { closed = true; void keeper?.close(); });
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("multi.html");
  const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, {active: true});
    await chrome.windows.update(existing.windowId, {focused: true});
  } else {
    await chrome.tabs.create({url});
  }
});
