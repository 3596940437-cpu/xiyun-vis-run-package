const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'output', 'poster');

function requirePlaywright() {
  const bundled = path.join(
    process.env.USERPROFILE || '',
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'node',
    'node_modules',
    '.pnpm',
    'playwright@1.61.1',
    'node_modules',
    'playwright',
  );
  if (fs.existsSync(bundled)) {
    return require(bundled);
  }
  return require('playwright');
}

function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Chrome or Edge was not found.');
  return found;
}

function findByExtension(ext) {
  const name = fs.readdirSync(OUT_DIR).find((entry) => entry.endsWith(ext));
  if (!name) throw new Error(`No ${ext} file found in output/poster.`);
  return path.join(OUT_DIR, name);
}

async function main() {
  const { chromium } = requirePlaywright();
  const htmlPath = findByExtension('.html');
  const pdfPath = path.join(OUT_DIR, 'A0_戏韵千秋海报.pdf');

  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-extensions',
      '--allow-file-access-from-files',
      '--hide-scrollbars',
    ],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 2263 },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    await page.pdf({
      path: pdfPath,
      width: '841mm',
      height: '1189mm',
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      printBackground: true,
      preferCSSPageSize: true,
    });
    console.log(JSON.stringify({ pdfPath }, null, 2));
  }
  finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
