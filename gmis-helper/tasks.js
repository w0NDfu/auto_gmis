import {randomUUID} from "node:crypto";
import {MultiEngine, parseTime, classifyResult, hasEnrollment} from "./task-runtime.js";
import {NodeOCR} from "./node-ocr.js";
import {safeNotice} from "./login-result.js";
import {describeError} from "./operations.js";

const failure = message => Object.assign(new Error(message),{code:"INVALID_REQUEST"});
const retryable = error => ["STEP_NETWORK","STEP_TIMEOUT","HELPER_UNAVAILABLE"].includes(error.code) ||
  error.code === "UPSTREAM_ERROR" && /HTTP 5\d\d/.test(error.message) || /ECONNRESET|ETIMEDOUT|ERR_CONNECTION|ERR_NETWORK|Timeout \d+ms exceeded/.test(error.message);

export class Tasks {
  constructor(manager,{ocr=new NodeOCR(),now=Date.now,sleep,report=()=>{}}={}) {
    Object.assign(this,{manager,ocr,now,customSleep:sleep,report}); this.jobs=new Map();
  }
  cleanTargets(targets) {
    if (!Array.isArray(targets) || !targets.length || targets.length>50) throw failure("请选择 1–50 个项目");
    const seen=new Set();
    return targets.map(row=>{
      if (!row || !["labour","academic"].includes(row.category) || !/^\d{1,20}$/.test(String(row.id))) throw failure("项目类别或编号无效");
      const key=row.category+":"+row.id; if (seen.has(key)) throw failure("项目重复"); seen.add(key);
      return {id:String(row.id),category:row.category,mc:String(row.mc||row.id).slice(0,240)};
    });
  }
  cleanSettings(input={}) {
    const {maxAttempts=90,intervalSeconds=.01,attemptAt,retryFull=true}=input;
    if (!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>99999||!Number.isFinite(intervalSeconds)||intervalSeconds<.01||intervalSeconds>60||
      typeof retryFull!=="boolean"||attemptAt!==undefined&&!Number.isFinite(attemptAt)) throw failure("尝试次数、重试间隔或开始时间无效");
    return {maxAttempts,intervalSeconds,retryFull,...(attemptAt!==undefined?{attemptAt}:{})};
  }
  snapshot(job,after=0) {
    return {jobId:job.jobId,requestId:job.requestId,accountId:job.accountId,accountReady:this.manager.get(job.accountId).ready,active:job.active,state:job.state,
      targets:job.targets,settings:job.settings,connectionNotice:job.connectionNotice||"",lastSeq:job.seq,
      logs:job.logs.filter(entry=>entry.seq>after)};
  }
  list() { return [...this.jobs.values()].map(job=>this.snapshot(job,job.seq)); }
  status(id,after=0) {
    this.manager.get(id); const job=this.jobs.get(id);
    return job ? this.snapshot(job,Number.isFinite(after)?after:0) : null;
  }
  start(id,{targets,settings,requestId}) {
    if (typeof requestId!=="string"||!/^[-\w]{8,80}$/.test(requestId)) throw failure("任务请求编号无效");
    const previous=this.jobs.get(id);
    if (previous?.requestId===requestId) return this.snapshot(previous);
    if (previous?.active) throw failure("该账号已有后台任务在运行");
    const selected=this.cleanTargets(targets), config=this.cleanSettings(settings);
    const {runId}=this.manager.start(id,{managed:true});
    const job={jobId:randomUUID(),requestId,accountId:id,runId,active:true,stopping:false,targets:selected,settings:config,
      logs:[],seq:0,waiters:new Set(),state:{phase:"starting",attempt:0,maxAttempts:config.maxAttempts,total:selected.length},generation:0};
    job.wait=ms=>this.customSleep ? this.customSleep(ms) : new Promise(resolve=>{
      const waiter={resolve,timer:setTimeout(()=>{job.waiters.delete(waiter);resolve();},ms)}; job.waiters.add(waiter);
    });
    this.jobs.set(id,job);
    this.log(job,`后台挂机任务已接管 ${selected.length} 个项目；等待不扣次数，关闭控制台后继续执行。`);
    job.done=Promise.resolve().then(()=>this.execute(job));
    return this.snapshot(job);
  }
  log(job,message,error=false) {
    const account=this.manager.get(job.accountId);
    const entry={seq:++job.seq,at:this.now(),message:safeNotice(message,[account.username,account.password,account.loginCode]),error};
    job.logs.push(entry); if(job.logs.length>500)job.logs.shift();
    try { this.report({masked:this.manager.public(account).masked,...entry}); } catch { /* Logging cannot stop tasks. */ }
  }
  check(job) {
    if(job.stopping) throw Object.assign(new Error("任务已停止"),{code:"RUN_EXPIRED"});
    this.manager.validateRun(this.manager.get(job.accountId),job.runId);
  }
  async read(job,category,operation,data) {
    let warned=false;
    while(true) {
      this.check(job);
      try {
        const result=await this.manager.request(job.accountId,{category,operation,data,runId:job.runId});
        if(warned)this.log(job,"学校接口连接已恢复，继续后台任务。");
        job.connectionNotice=""; return result;
      } catch(error) {
        if(error.code==="SESSION_EXPIRED"){await this.login(job);continue;}
        if(!retryable(error))throw error;
        this.check(job);
        if(job.targets.every(target=>Number.isFinite(target.deadline))&&this.now()>=Math.max(...job.targets.map(target=>target.deadline)))throw failure("所选项目报名均已截止，后台任务结束");
        job.connectionNotice="学校接口暂时不可用，后台仍在等待恢复";
        if(!warned){this.log(job,job.connectionNotice);warned=true;}
        await job.wait(5000);
      }
    }
  }
  api(job,category) {
    const rows=async operation=>{
      const result=await this.read(job,category,operation,{});
      if(!Array.isArray(result?.rows))throw failure("学校接口未返回有效项目列表");
      if(operation==="available")for(const target of job.targets.filter(target=>target.category===category)){
        const row=result.rows.find(row=>String(row.id)===target.id);
        if(row){target.deadline=parseTime(row.bmjzsj);target.mc=String(row.mc||target.mc).slice(0,240);}
      }
      return result.rows;
    };
    return {
      available:()=>rows("available"),enrolled:async()=>{const result=await rows("enrolled");if(job.pendingId&&hasEnrollment(result,job.pendingId))job.submitting=false;return result;},
      preflight:async id=>{
        if(category!=="academic")return true;
        const result=await this.read(job,category,"preflight",{id});
        if(String(result?.sign)==="1")return true;
        if(String(result?.sign)==="0")return false;
        throw failure("学术报告预检未明确放行，已停止");
      },
      captcha:async()=>{
        while(true){
          const generation=job.generation,result=await this.read(job,category,"captcha",{});
          if(job.login)await job.login;
          this.check(job);
          if(generation!==job.generation)continue;
          job.captchaGeneration=generation;return result.image;
        }
      },
      submit:async(id,code,beforeSend)=>{
        if(job.login)await job.login;
        this.check(job); beforeSend();
        if(job.captchaGeneration!==job.generation)return {msg:"验证码已失效，请重新获取"};
        // Writes are sent once; ambiguous responses remain the shared engine's responsibility.
        job.submitting=true;job.pendingId=String(id);
        const result=await this.manager.request(job.accountId,{category,operation:"submit",data:{id,VeriCode:code},runId:job.runId});
        if(classifyResult(result)!=="unknown")job.submitting=false;
        return result;
      }
    };
  }
  async login(job) {
    if(job.submitting)throw Object.assign(new Error("提交结果待核验时登录失效，已停止，请查询成功报名列表"),{code:"SESSION_EXPIRED"});
    if(job.login)return job.login;
    job.generation++;
    job.login=(async()=>{
      this.log(job,"学校登录会话已过期，后台正在重新登录。");
      for(let attempt=1;attempt<=3;attempt++){
        this.check(job);
        const challenge=await this.manager.challenge(job.accountId,job.runId);
        const code=challenge.requiresCaptcha||challenge.image ? await this.ocr.recognize(challenge.image,this.manager.get(job.accountId).page) : "";
        this.check(job);
        if((challenge.requiresCaptcha||challenge.image)&&!/^\d{4}$/.test(code))continue;
        try {await this.manager.login(job.accountId,code,job.runId,challenge.challengeId);this.log(job,"后台重新登录成功，继续等待或报名。");return;}
        catch(error){if(error.code!=="LOGIN_CAPTCHA"||attempt===3)throw error;}
      }
      throw Object.assign(new Error("后台登录验证码识别失败，请重新登录后启动任务"),{code:"LOGIN_CAPTCHA"});
    })().finally(()=>{job.login=null;});
    return job.login;
  }
  async execute(job) {
    const engine=new MultiEngine({apiFor:category=>this.api(job,category),now:this.now,sleep:job.wait,
      ocr:{recognize:image=>this.ocr.recognize(image,this.manager.get(job.accountId).page)},
      log:message=>this.log(job,message),state:state=>{job.state=state;},journal:async entry=>{job.lastTask=entry;}});
    job.engine=engine;
    try {
      this.check(job); await this.ocr.prepare(); this.check(job);
      await engine.run(job.targets,job.settings);
    } catch(error) {
      const diagnostic=describeError(error,{step:"后台挂机任务",secrets:[this.manager.get(job.accountId).username,this.manager.get(job.accountId).password]});
      const exhausted=/达到重试上限/.test(error.message);
      job.state={...job.state,phase:job.stopping?"stopped":exhausted?"exhausted":"error"};
      this.log(job,job.stopping?"任务已手动停止。":exhausted?"该账号尝试次数已用完，后台任务结束。":diagnostic.message,!job.stopping&&!exhausted);
    } finally {
      job.active=false; this.manager.stop(job.accountId,job.runId);
      for(const waiter of job.waiters){clearTimeout(waiter.timer);waiter.resolve();}job.waiters.clear();
    }
  }
  stop(id,jobId) {
    this.manager.get(id); const job=this.jobs.get(id);
    if(!job||job.jobId!==jobId)throw failure("任务编号已变化，请刷新后再停止");
    if(job.active){job.stopping=true;job.state={...job.state,phase:"stopping"};job.engine?.stop();this.manager.stop(id,job.runId);
      for(const waiter of job.waiters){clearTimeout(waiter.timer);waiter.resolve();}job.waiters.clear();}
    return this.snapshot(job);
  }
  async close(){for(const job of this.jobs.values())if(job.active)this.stop(job.accountId,job.jobId);await Promise.all([...this.jobs.values()].map(job=>job.done));await this.ocr.close?.();}
}
