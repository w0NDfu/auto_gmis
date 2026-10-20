// ZIP distributions include this shared source snapshot; development uses the extension source.
import {existsSync} from "node:fs";
const base = existsSync(new URL("./task-runtime/core.js",import.meta.url)) ? "./task-runtime/" : "../gmis-extension/";
export const {MultiEngine, projectKey} = await import(base+"multi-engine.js");
export const {parseTime, classifyResult, hasEnrollment} = await import(base+"core.js");
