import {test} from "node:test";
import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import {inspectSSOForm} from "../sso-form.js";

const element = (attributes={}, text="") => ({id:"",name:"",type:"text",placeholder:"",disabled:false,
  ...attributes, textContent:text, innerText:text, getClientRects:()=>attributes.hidden?[]:[{}],
  getAttribute:name=>attributes[name]??null});
function inspect({inputs=[],tabs=[],images=[],dialogs=[],buttons=[]}) {
  const selectors={input:inputs,'[role=\'tab\']':tabs,'img,canvas':images,"button,input[type='submit'],[role='button']":buttons,
    "[role='dialog'],.ant-modal,.el-dialog,.geetest_panel,.yidun_modal":dialogs};
  return runInNewContext(`(${inspectSSOForm.toString()})()`,{document:{querySelectorAll:selector=>selectors[selector]||[]},
    getComputedStyle:()=>({visibility:"visible"})});
}
test("SMS verification input is interactive and never selected as an image captcha",()=>{
  const form=inspect({inputs:[element({name:"username",placeholder:"请输入手机号"}),
    element({name:"password",placeholder:"请输入短信验证码",autocomplete:"new-password"})],
    tabs:[element({"aria-controls":"password"},"用户名密码"),element({"aria-selected":"true"},"短信验证码")]});
  assert.equal(form.captcha,undefined); assert.equal(form.interactive,true);
  assert.equal(form.interactiveChallenge,false); assert.equal(form.selectedTab,"短信验证码");
  assert.match(form.passwordTabSelector,/aria-controls="password"/);
});

test("the school's code-img blob image is bound to the visible verification component",()=>{
  const picture=element({className:"code-img",src:"blob:https://sidportal.buct.edu.cn/test"});
  const decoy=element({className:"captcha"});
  const input=element({name:"captcha_code"});
  const component={contains:el=>el===picture};
  input.closest=selector=>selector.startsWith("app-verification")?component:null;
  const form=inspect({inputs:[input],images:[decoy,picture],buttons:[element({id:"submitBtn"},"立即登录")]});
  assert.equal(form.captchaImage,1);assert.equal(form.captchaSubmit,0);
});

test("a supplemental captcha binds its own confirm button instead of a different login method",()=>{
  const confirm=element({id:"verify-confirm"},"确定"),other=element({id:"lbpSubmitBtn"},"立即登录");
  const input=element({name:"captcha_code"});const scope={contains:el=>el===confirm};
  input.closest=selector=>selector.startsWith("app-verification")?null:scope;
  const form=inspect({inputs:[input],buttons:[other,confirm]});
  assert.equal(form.captchaSubmit,1);assert.match(form.captchaSubmitSelector,/verify-confirm/);
});
test("visible password tab binding excludes hidden duplicate tabs and never reads input values",()=>{
  const input=element({placeholder:"请输入学工号"}); Object.defineProperty(input,"value",{get(){throw new Error("secret read");}});
  const form=inspect({inputs:[input,element({type:"password"}),element({id:"captchaInput",placeholder:"图形验证码"})],
    tabs:[element({hidden:true,"aria-controls":"stale"},"用户名密码"),element({"aria-controls":"active"},"用户名 密码")]});
  assert.match(form.passwordTabSelector,/"active"/); assert.equal(form.captcha,2);
});
test("a visible SMS second-factor dialog is distinguished from choosing the primary SMS tab",()=>{
  assert.equal(inspect({dialogs:[element({},"请输入短信验证码完成二次认证")]}).interactiveChallenge,true);
});
