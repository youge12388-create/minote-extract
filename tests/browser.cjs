const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let playwright;
try { playwright = require('playwright-core'); }
catch (error) {
  const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright-core');
  if (!fs.existsSync(bundled)) throw error;
  playwright = require(bundled);
}

const browserCache = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
const cachedChromium = fs.existsSync(browserCache) ? fs.readdirSync(browserCache)
  .filter(name => /^chromium-\d+$/.test(name))
  .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  .flatMap(name => ['chrome-win64', 'chrome-win'].map(folder => path.join(browserCache, name, folder, 'chrome.exe'))) : [];
const firstExisting = paths => paths.find(candidate => candidate && fs.existsSync(candidate));

module.exports = {
  playwright,
  chromiumPath: process.env.MINOTE_TEST_BROWSER || firstExisting([playwright.chromium.executablePath(), ...cachedChromium]),
  chromePath: process.env.MINOTE_TEST_CHROME || firstExisting([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ]),
  edgePath: process.env.MINOTE_TEST_EDGE || firstExisting([
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ])
};
