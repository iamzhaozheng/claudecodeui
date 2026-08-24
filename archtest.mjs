import puppeteer from 'puppeteer-core';
const TOKEN = process.env.TOK, TARGET = process.env.TARGET;
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on('request', r => { const u=r.url(); if (/\/api\/(providers\/sessions|projects\/groups|projects$)/.test(u)) console.log('  >>', r.method(), u.replace('http://127.0.0.1:3001','')); });
await page.goto('http://127.0.0.1:3001/', { waitUntil: 'domcontentloaded' });
await page.evaluate((t) => localStorage.setItem('auth-token', t), TOKEN);
await page.goto('http://127.0.0.1:3001/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 4000));
await page.evaluate(() => [...document.querySelectorAll('button')].find(x => /^Projects/.test(x.innerText.trim()))?.click());
await new Promise(r => setTimeout(r, 1500));

// count occurrences of TARGET in the sidebar only
const sidebarText = () => page.evaluate(() => {
  const sa = document.querySelector('[data-radix-scroll-area-viewport], .overflow-y-auto');
  return sa ? sa.innerText : document.body.innerText;
});
const countTarget = async () => ((await sidebarText()).split(TARGET).length - 1);

// expand projects: click each project header button
const headers = await page.$$('button, div[role="button"]');
for (const h of headers) {
  const txt = await page.evaluate(el => el.innerText, h).catch(()=> '');
  if (/^(claude-workspace|ops)\n?/.test(txt.trim()) && txt.length < 80) { await h.click().catch(()=>{}); await new Promise(r=>setTimeout(r,600)); }
}
await new Promise(r => setTimeout(r, 1500));
console.log('sidebar sample:\n', (await sidebarText()).slice(0, 900));
console.log('TARGET count:', await countTarget());
await browser.close();
