import {LocalOCR} from "../ocr.js";
const results = document.getElementById("results");
const ocr = new LocalOCR(text => { results.textContent = text; },
  path => new URL("../" + path, location.href).href);
try {
  await ocr.prepare();
  const lines = [];
  for (const text of ["1234", "6872"]) {
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 60;
    const c = canvas.getContext("2d"); c.fillStyle = "white"; c.fillRect(0, 0, 160, 60);
    c.fillStyle = "#367cab"; c.font = "40px Georgia"; c.fillText(text, 10, 45);
    const actual = await ocr.recognize(canvas.toDataURL());
    lines.push(`${actual === text ? "PASS" : "FAIL"}: ${text} -> ${actual}`);
    results.textContent = lines.join("\n");
  }
  await ocr.worker.terminate();
} catch (error) { results.textContent = `ERROR: ${error.message}`; }
