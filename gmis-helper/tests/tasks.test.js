import {test} from "node:test";
import assert from "node:assert/strict";
import {Tasks} from "../tasks.js";
import {AccountManager} from "../manager.js";
import {NodeOCR} from "../node-ocr.js";
import {createServer} from "../server.js";
import {once} from "node:events";

const base=Date.parse("2026-10-20T12:00:00+08:00");
function harness({future=false,mode="success",sleep}={}) {
  let now=base,reads=0,failReads=0,logins=0;
  const writes=[],enrolled=new Set();
  const rows=["labour","academic"].map(category=>({category,id:42,mc:category,
    bmkssj:future?"2026-10-21 12:00:00":"2026-10-20 12:00:00",bmjzsj:"2026-10-22 12:00:00"}));
  const manager=new AccountManager(async()=>{throw new Error("tests never launch a real browser");},{now:()=>now});
  manager.accounts.set("account-1",{id:"account-1",username:"DEMO0001",password:"fake-password",label:"demo",ready:true,queue:Promise.resolve(),page:{}});
  manager.request=async(id,{category,operation,runId})=>{
    manager.validateRun(manager.get(id),runId);reads++;
    if(failReads>0&&operation!=="submit"){failReads--;throw Object.assign(new Error("ERR_CONNECTION_RESET"),{code:"STEP_NETWORK"});}
    if(mode==="expired"&&logins===0)throw Object.assign(new Error("expired"),{code:"SESSION_EXPIRED"});
    if(operation==="available")return {rows:rows.filter(row=>row.category===category)};
    if(operation==="enrolled")return {rows:enrolled.has(category)?[{hdid:42}]:[]};
    if(operation==="preflight")return {sign:"1"};
    if(operation==="captcha")return {image:"image"};
    if(operation==="submit"){
      writes.push({category,at:now});
      if(mode==="uncertain")throw new Error("lost response");
      if(mode==="exhausted"&&category==="academic")return {msg:"验证码错误"};
      enrolled.add(category);return {zt:"1"};
    }
    throw new Error("unexpected operation");
  };
  manager.challenge=async()=>({challengeId:"challenge",requiresCaptcha:false});
  manager.login=async()=>{logins++;return {ready:true};};
  const tasks=new Tasks(manager,{now:()=>now,ocr:{prepare:async()=>{},recognize:async()=>"1234"},
    sleep:sleep|| (async ms=>{now+=ms;})});
  const start=(targets=rows,settings={maxAttempts:5,intervalSeconds:.01})=>tasks.start("account-1",{targets,settings,requestId:"test-request-1"});
  return {tasks,manager,rows,writes,start,now:()=>now,failReads:n=>{failReads=n;},reads:()=>reads,logins:()=>logins};
}
test("helper-owned task waits a full day without any UI heartbeat, consumes no attempts while waiting and then succeeds",async()=>{
  const h=harness({future:true});const start=h.start([h.rows[0]],{maxAttempts:1,intervalSeconds:.01,attemptAt:base+86400000});
  const job=h.tasks.jobs.get("account-1");await job.done;
  assert.equal(job.state.phase,"success");assert.equal(job.state.attempt,1);assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].at,base+86400000);assert.equal(job.active,false);
  assert.equal(h.manager.active(h.manager.get("account-1")),null);
  assert.equal(start.active,true);
});
test("a completed target exits while the other continues until the shared budget runs out",async()=>{
  const h=harness({mode:"exhausted"});h.start(h.rows,{maxAttempts:4,intervalSeconds:.01});await h.tasks.jobs.get("account-1").done;
  const job=h.tasks.jobs.get("account-1");assert.equal(job.state.phase,"exhausted");
  assert.equal(h.writes.filter(write=>write.category==="labour").length,1);assert.equal(h.writes.length,4);
});
test("query outages do not spend the attempt budget or cancel a waiting task",async()=>{
  const h=harness();h.failReads(10);h.start([h.rows[0]],{maxAttempts:1,intervalSeconds:.01});await h.tasks.jobs.get("account-1").done;
  assert.equal(h.tasks.jobs.get("account-1").state.phase,"success");assert.equal(h.writes.length,1);assert.ok(h.now()>=base+25000);
});
test("expired school sessions re-login automatically with the same managed task",async()=>{
  const h=harness({mode:"expired"});h.start([h.rows[0]]);await h.tasks.jobs.get("account-1").done;
  assert.equal(h.logins(),1);assert.equal(h.tasks.jobs.get("account-1").state.phase,"success");
});
test("an uncertain submission never gets resent and blocks the other queued target",async()=>{
  const h=harness({mode:"uncertain"});h.start();await h.tasks.jobs.get("account-1").done;
  assert.equal(h.writes.length,1);assert.equal(h.tasks.jobs.get("account-1").state.phase,"error");
});
test("a captcha invalidated by re-login is fetched again and never submitted with the old generation",async()=>{
  const h=harness(),{runId}=h.manager.start("account-1",{managed:true});
  const job={accountId:"account-1",runId,generation:0,stopping:false,targets:[]};let images=0;
  const request=h.manager.request;
  h.manager.request=async(id,args)=>{if(args.operation==="captcha"){if(++images===1){job.generation++;return {image:"stale"};}return {image:"fresh"};}return request(id,args);};
  const api=h.tasks.api(job,"labour");assert.equal(await api.captcha(),"fresh");assert.equal(images,2);
  job.generation++;const result=await api.submit("42","1234",()=>{});
  assert.match(result.msg,/失效/);assert.equal(h.writes.length,0);
});
test("session expiry while a write is awaiting verification never starts a new login",async()=>{
  const h=harness({mode:"expired"}),{runId}=h.manager.start("account-1",{managed:true});
  const job={accountId:"account-1",runId,generation:0,stopping:false,submitting:true};
  await assert.rejects(h.tasks.api(job,"labour").enrolled(),error=>error.code==="SESSION_EXPIRED");
  assert.equal(h.logins(),0);assert.equal(h.writes.length,0);
});
test("manual stop revokes a waiting task immediately and no later submission is sent",async()=>{
  let release,waiting;
  const barrier=new Promise(resolve=>{waiting=resolve;});
  const h=harness({future:true,sleep:()=>new Promise(resolve=>{release=resolve;waiting();})});
  const result=h.start([h.rows[0]]);await barrier;
  h.tasks.stop("account-1",result.jobId);release();await h.tasks.jobs.get("account-1").done;
  assert.equal(h.writes.length,0);assert.equal(h.tasks.jobs.get("account-1").state.phase,"stopped");
});
test("start acknowledgements are idempotent, status is bounded, and snapshots contain no credentials",async()=>{
  const h=harness();const first=h.start();const duplicate=h.start();assert.equal(first.jobId,duplicate.jobId);
  await h.tasks.jobs.get("account-1").done;
  const snapshot=h.tasks.status("account-1");assert.equal(snapshot.active,false);
  assert.ok(!/fake-password|DEMO0001|runId/.test(JSON.stringify(snapshot)));
  assert.deepEqual(h.tasks.status("account-1",snapshot.lastSeq).logs,[]);
  assert.throws(()=>h.tasks.stop("account-1","stale-job"),/编号/);
  assert.equal(h.start().jobId,first.jobId,"a delayed duplicate cannot start another completed task");
});
test("Node OCR uses a local language model and serializes work across accounts",async()=>{
  const seen=[];let inFlight=0,peak=0;
  const ocr=new NodeOCR({factory:async(lang,oem,options)=>{
    assert.equal(lang,"eng");assert.equal(oem,1);assert.ok(!options.langPath.startsWith("http"));assert.equal(options.cacheMethod,"none");
    return {setParameters:async params=>assert.equal(params.tessedit_char_whitelist,"0123456789"),
      recognize:async image=>{inFlight++;peak=Math.max(peak,inFlight);await Promise.resolve();inFlight--;seen.push(image);return {data:{text:"1 2 3 4\n"}};},terminate:async()=>{}};
  }});
  await Promise.all([ocr.recognize("a"),ocr.recognize("b")]);assert.equal(peak,1);assert.deepEqual(seen,["a","b"]);await ocr.close();
});

test("HTTP console can disconnect and reconnect while the managed backend task keeps waiting",async()=>{
  let release,waiting;const barrier=new Promise(resolve=>{waiting=resolve;});
  const h=harness({future:true,sleep:()=>new Promise(resolve=>{release=resolve;waiting();})});
  const server=createServer(h.manager,"test-token",{port:0,tasks:h.tasks});server.listen(0,"127.0.0.1");await once(server,"listening");
  const call=async(path,args={})=>{
    const response=await fetch("http://127.0.0.1:"+server.address().port+path,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer test-token"},body:JSON.stringify(args)});
    const result=await response.json();assert.equal(result.ok,true);return result.data;
  };
  try{
    const started=await call("/tasks/start",{id:"account-1",targets:[h.rows[0]],settings:{maxAttempts:1},requestId:"http-test-request"});await barrier;
    assert.equal(h.manager.get("account-1").run.managed,true);
    const restored=await call("/health");assert.equal(restored.tasks[0].jobId,started.jobId);assert.equal(restored.tasks[0].state.attempt,0);
    const status=await call("/tasks/status",{id:"account-1"});assert.equal(status.active,true);
    await call("/tasks/stop",{id:"account-1",jobId:started.jobId});release();await h.tasks.jobs.get("account-1").done;
    assert.equal((await call("/tasks/status",{id:"account-1"})).state.phase,"stopped");assert.equal(h.writes.length,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
