import {createWorker} from "tesseract.js";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";

// Same preprocessing as the extension OCR, performed in the account's existing isolated page.
export async function prepareDigits(dataURL) {
  const image = new Image(); image.src = dataURL; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = image.width * 3; canvas.height = image.height * 3;
  const context = canvas.getContext("2d", {willReadFrequently:true});
  context.fillStyle = "white"; context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(image,0,0,canvas.width,canvas.height);
  const pixels = context.getImageData(0,0,canvas.width,canvas.height);
  for (let i=0;i<pixels.data.length;i+=4) {
    const value = (pixels.data[i]*30+pixels.data[i+1]*59+pixels.data[i+2]*11)/100 < 165 ? 0 : 255;
    pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=value; pixels.data[i+3]=255;
  }
  context.putImageData(pixels,0,0); return canvas.toDataURL("image/png");
}
export class NodeOCR {
  constructor({factory=createWorker}={}) { this.factory=factory; this.queue=Promise.resolve(); }
  enqueue(operation) { const pending=this.queue.then(operation); this.queue=pending.catch(()=>{}); return pending; }
  async initialize() {
    if (this.worker) return;
    const local = new URL("./ocr-data/eng.traineddata.gz",import.meta.url);
    const language = existsSync(local) ? new URL("./ocr-data/",import.meta.url) : new URL("../gmis-extension/vendor/lang/",import.meta.url);
    const worker = await this.factory("eng",1,{langPath:fileURLToPath(language),gzip:true,cacheMethod:"none"});
    try { await worker.setParameters({tessedit_char_whitelist:"0123456789",tessedit_pageseg_mode:"8",user_defined_dpi:"300"}); this.worker=worker; }
    catch (error) { await worker.terminate().catch(()=>{}); throw error; }
  }
  prepare() { return this.enqueue(()=>this.initialize()); }
  recognize(image,page) {
    return this.enqueue(async()=>{
      await this.initialize();
      const prepared=page ? await page.evaluate(prepareDigits,image) : image;
      const {data}=await this.worker.recognize(prepared);
      return data.text.replace(/\D/g,"");
    });
  }
  async close() { await this.queue; await this.worker?.terminate(); this.worker=null; }
}
