// Scrape FoSCoS "KOB wise Required Documents" for every kind of business (its API encrypts requests, so this drives the page).
// Usage: PLAYWRIGHT=/path/to/node_modules/playwright node tools/scrape-foscos-required-documents.cjs out.json
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const p = await b.newPage();
  await p.goto('https://foscos.fssai.gov.in/public/required-document', { timeout: 90000 });
  await p.waitForTimeout(8000);
  const sel = p.locator('select');
  const groups = await sel.nth(0).locator('option').evaluateAll(os => os.map(o => [o.value, o.text.trim()]).filter(o => o[0]));
  const out = [];
  for (const [gv, gname] of groups) {
    await sel.nth(0).selectOption(gv); await p.waitForTimeout(3000);
    const kobs = await sel.nth(1).locator('option').evaluateAll(os => os.map(o => [o.value, o.text.trim()]).filter(o => o[0]));
    for (const [kv, kname] of kobs) {
      await sel.nth(1).selectOption(kv);
      await p.getByText('submit', { exact: true }).click(); await p.waitForTimeout(2500);
      const docs = await p.$$eval('table tr', trs => trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim())).filter(r => r.length >= 2).map(r => r[1]));
      out.push({ group: gname, kobId: kv, kob: kname, docs });
      console.error(gname, '|', kname, docs.length);
    }
  }
  require('fs').writeFileSync(process.argv[2] || 'foscos-docs.json', JSON.stringify(out, null, 1));
  await b.close();
})();
