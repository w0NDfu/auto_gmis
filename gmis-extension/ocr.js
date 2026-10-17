export class LocalOCR {
  constructor(progress = () => {}, resourceURL = path => chrome.runtime.getURL(path)) {
    this.progress = progress;
    this.resourceURL = resourceURL;
  }
  async prepare() {
    if (this.worker) return;
    if (!globalThis.Tesseract) throw new Error("OCR 文件缺失，请先运行打包脚本");
    this.progress("正在加载本地识别引擎…");
    this.worker = await Tesseract.createWorker("eng", 1, {
      workerPath: this.resourceURL("vendor/tesseract/worker.min.js"),
      corePath: this.resourceURL("vendor/core"),
      langPath: this.resourceURL("vendor/lang"),
      workerBlobURL: false, gzip: true, cacheMethod: "none"
    });
    await this.worker.setParameters({tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: "8", user_defined_dpi: "300"});
    this.progress("本地识别引擎就绪");
  }
  async recognize(dataURL) {
    await this.prepare();
    const image = new Image();
    image.src = dataURL;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width * 3; canvas.height = image.height * 3;
    const context = canvas.getContext("2d", {willReadFrequently: true});
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const gray = (pixels.data[i] * 30 + pixels.data[i+1] * 59 + pixels.data[i+2] * 11) / 100;
      const value = gray < 165 ? 0 : 255;
      pixels.data[i] = pixels.data[i+1] = pixels.data[i+2] = value;
      pixels.data[i+3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const {data} = await this.worker.recognize(canvas);
    return data.text.replace(/\D/g, "");
  }
}
