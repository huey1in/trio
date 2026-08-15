// 浏览器启动验证:模拟 dsh-reef/browser 的通道探测逻辑(仅测试用)
import { chromium } from "playwright-core";

const candidates = [];
if (process.platform === "win32") {
  for (const channel of ["msedge", "chrome", "chromium"]) candidates.push({ channel });
} else {
  for (const channel of ["chrome", "msedge", "chromium"]) candidates.push({ channel });
}

let browser = null;
let used = null;
for (const options of candidates) {
  try {
    browser = await chromium.launch({ headless: true, ...options });
    used = options.channel;
    break;
  } catch (e) {
    console.log(`✗ ${options.channel}: ${e.message.split("\n")[0]}`);
  }
}
if (!browser) {
  console.log("✗ all channels failed — need `npx playwright install chromium`");
  process.exit(1);
}
const page = await browser.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
const title = await page.title();
const text = await page.evaluate("document.body.innerText");
console.log(`✓ launched via ${used}, title=${title}, text=${text.trim().slice(0, 40)}`);
await browser.close();
