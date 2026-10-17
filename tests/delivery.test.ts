import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, analyzeBundle, safePath, unpack } from '../server/bundle.ts';
import { inspectPreview } from '../server/preview-worker.ts';
import { zipSync, strToU8 } from 'fflate';
import type { Criterion } from '../server/types.ts';
import { parse } from 'parse5';
import {localAssetReference} from '../server/asset-reference.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
const check = (type: Criterion['type'], value: string): Criterion => ({ type, value, label: type });
function files(html: string, extra: Record<string, Buffer> = {}) { return new Map(Object.entries({ 'index.html': Buffer.from(html), ...extra })); }

test('dot-prefixed local CSS and image references retain rendering without widening unsafe URL resolution',async()=>{
 const bundle=files('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./assets/site.css"><img src="./assets/logo.png"><div class="wide">Delivery</div>',{'assets/site.css':Buffer.from('body{margin:0}.wide{width:900px;height:10px}'),'assets/logo.png':png});
 const result=await analyzeBundle(bundle,[check('IMAGE','assets/logo.png'),check('IMAGE','./assets/logo.png'),check('OVERFLOW','390')]);
 assert.deepEqual(result.evidence.map(e=>e.status),['PASS','PASS','FAIL']);assert.match(result.evidence[0].observed!,/\.\/assets\/logo\.png/);assert.match(result.preview,/width:900px/);
 for(const path of ['../assets/logo.png','/assets/logo.png','https://evil.example/logo.png','//evil.example/logo.png','assets/../logo.png','assets/%2e%2e/logo.png','assets/logo.png?x=1','assets/logo.png#x','assets\\logo.png'])assert.equal(localAssetReference(path),undefined);
 assert.throws(()=>safePath('./assets/logo.png'),/unsafe/);
});

test('restricted browser measures mobile overflow separately at both agreed widths', async () => {
  const result = await analyzeBundle(files('<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}.wide{width:500px;height:10px}</style><div class="wide">Delivery</div>'), [check('OVERFLOW','390'), check('OVERFLOW','640')]);
  assert.equal(result.evidence[0].status,'FAIL'); assert.match(result.evidence[0].observed!, /390px; document width 50[01]px/);
  assert.equal(result.evidence[1].status,'PASS'); assert.match(result.evidence[1].observed!, /640px/);
});
test('required visible text excludes CSS hidden and opacity hidden content', async () => {
  const result = await analyzeBundle(files('<style>.hidden{display:none}.transparent{opacity:0}</style><p class="hidden">Invisible promise</p><p class="transparent">Transparent promise</p><p>Real promise</p>'), [check('TEXT','Invisible promise'),check('TEXT','Transparent promise'),check('TEXT','Real promise')]);
  assert.deepEqual(result.evidence.map(e=>e.status), ['FAIL','FAIL','PASS']);
});
test('link mismatch exposes actual relative destination and permits corrected destination', async () => {
  const first = await analyzeBundle(files('<a href="/contact">Booking button</a>'), [check('LINK','/reserve')]);
  assert.equal(first.evidence[0].status,'FAIL'); assert.equal(first.evidence[0].agreed,'/reserve'); assert.equal(first.evidence[0].observed,'/contact');
  const second = await analyzeBundle(files('<a href="/reserve">Booking button</a><a hidden href="/contact">Hidden</a>'), [check('LINK','/reserve')]);
  assert.equal(second.evidence[0].status,'PASS'); assert.equal(second.evidence[0].observed,'/reserve');
});
test('image check requires browser decoding, not just raster magic bytes', async () => {
  const result = await analyzeBundle(files('<img src="real.png"><img src="fake.png">',{'real.png':png,'fake.png':Buffer.from([137,80,78,71,13,10,26,10])}), [check('IMAGE','real.png'),check('IMAGE','fake.png')]);
  assert.deepEqual(result.evidence.map(e=>e.status), ['PASS','FAIL']);
});
test('browser unavailable and deadline never become automated passes', async () => {
  const missing = await inspectPreview('<p>Ready</p>', [check('TEXT','Ready'),check('OVERFLOW','390')], {executablePath:'C:/definitely-not-installed-scopeproof-browser.exe'});
  assert.deepEqual(missing.map(e=>e.status), ['REVIEW_REQUIRED','REVIEW_REQUIRED']);
  const expired = await inspectPreview('<p>Ready</p>', [check('OVERFLOW','390')], {timeoutMs:1});
  assert.equal(expired[0].status,'REVIEW_REQUIRED'); assert.match(expired[0].detail, /deadline/);
});
test('preview strips active content, escaped CSS URLs and external stylesheet HTML injection', async () => {
  const result = analyze(files('<link rel="stylesheet" href="main.css"><script>fetch("https://evil.example")</script><form><input></form><iframe src="https://evil.example"></iframe><img src="https://evil.example/pixel"><p onclick="alert(1)">Safe</p>', {'main.css':Buffer.from('@import "https://evil.example"; p{background:u\\72l(https://evil.example)} </style><script>alert(1)</script>')}), [check('TEXT','Safe')]);
  assert.ok(!result.preview.includes('<script')); assert.ok(!result.preview.includes('<form')); assert.ok(!result.preview.includes('<iframe')); assert.ok(!result.preview.includes('onclick')); assert.ok(!result.preview.includes('evil.example'));
  assert.match(result.preview,/default-src 'none'/);
  const measured = await inspectPreview(result.preview,[check('TEXT','Safe')]); assert.equal(measured[0].status,'PASS');
});
test('ZIP safety rejects ambiguous paths and truncated archives', async () => {
  for(const path of ['../index.html','folder/../index.html','/index.html','C:/index.html','folder\\index.html','./index.html']) assert.throws(()=>safePath(path));
  const valid = Buffer.from(zipSync({'index.html':strToU8('<p>Safe</p>')}));
  await assert.rejects(unpack(valid.subarray(0,Math.max(1,valid.length-25))));
});
test('repeated inline assets cannot amplify a small ZIP into an unbounded preview', () => {
  const large = Buffer.concat([png.subarray(0,8),Buffer.alloc(1024*1024)]);
  assert.throws(()=>analyze(files('<img src="logo.png">'.repeat(20),{'logo.png':large}),[check('IMAGE','logo.png')]), /Sanitized preview is too large/);
  assert.throws(()=>analyze(files('<link rel="stylesheet" href="main.css">'.repeat(20),{'main.css':Buffer.from(' '.repeat(1024*1024))}),[check('TEXT','Ready')]), /Sanitized preview is too large/);
});
test('user head attributes cannot suppress the preview CSP', () => {
  const result=analyze(files('<html><head class="custom" title="a > b"><style>p{background:image-set("https://evil.example/pixel")}</style></head><body><p>Safe</p></body></html>'),[check('TEXT','Safe')]);
  assert.match(result.preview, /<head><meta http-equiv="Content-Security-Policy"/);
});
test('presence checks use the first agreed viewport, not a silently assumed mobile width', async () => {
  const result=await analyzeBundle(files('<meta name="viewport" content="width=device-width, initial-scale=1"><style>@media(max-width:500px){p{display:none}}</style><p>Agreed wide content</p>'),[check('TEXT','Agreed wide content'),check('OVERFLOW','640')]);
  assert.equal(result.evidence[0].status,'PASS'); assert.match(result.evidence[0].detail,/640px/);
});
test('SP004 comment head marker cannot displace the real CSP or retain URL-bearing CSS functions', () => {
  const result=analyze(files('<!-- <head> --><html><head class="custom"><style>p{background:image-set("https://seller.example/p.png" 1x);border-image:cross-fade(image-set("https://seller.example/n.png" 2x),url(https://seller.example/q.png),50%);list-style:-webkit-image-set("https://seller.example/w.png" 1x)}</style></head><body><p>Safe</p></body></html>'),[check('TEXT','Safe')]);
  const doc:any=parse(result.preview); const head=doc.childNodes.find((n:any)=>n.tagName==='html').childNodes.find((n:any)=>n.tagName==='head');
  assert.equal(head.childNodes[0].tagName,'meta'); assert.equal(head.childNodes[0].attrs.find((a:any)=>a.name==='http-equiv').value,'Content-Security-Policy');
  assert.ok(!result.preview.includes('seller.example')); assert.ok(!result.preview.includes('image-set(')); assert.ok(!result.preview.includes('cross-fade('));
});
test('SP005 benign HTML5 descendants survive sanitization while unsafe subtrees are discarded', async () => {
  const result=await analyzeBundle(files('<meta name="viewport" content="width=device-width, initial-scale=1"><address>Tuesday–Sunday, 8am–4pm</address><figure><img src="logo.png"><figcaption>Our logo</figcaption></figure><button><a href="/reserve">Book</a></button><dl><dt>Hours</dt><dd><time>Today</time></dd></dl><script><p>Unsafe script content</p></script><iframe><a href="/unsafe">Unsafe frame</a></iframe>',{'logo.png':png}),[check('TEXT','Tuesday–Sunday, 8am–4pm'),check('LINK','/reserve'),check('IMAGE','logo.png')]);
  assert.deepEqual(result.evidence.map(e=>e.status),['PASS','PASS','PASS']);
  assert.ok(result.preview.includes('<address>')); assert.ok(result.preview.includes('<figure>')); assert.ok(!result.preview.includes('Unsafe script content')); assert.ok(!result.preview.includes('Unsafe frame'));
});
test('SP006 missing and unsupported source viewport never acquire a fabricated mobile pass', async () => {
  for(const html of ['<p>Ready</p>','<meta name="viewport" content="width=980"><p>Ready</p>']) {
    const result=await analyzeBundle(files(html),[check('OVERFLOW','390')]);
    assert.equal(result.evidence[0].status,'REVIEW_REQUIRED'); assert.match(result.evidence[0].detail,/source viewport/i);
    assert.ok(!result.preview.includes('width=device-width'));
  }
});
test('SP007 missing browser retains wrong destinations as static failures and hidden literal presence as review only', async () => {
  const options={executablePath:'C:/definitely-not-installed-scopeproof-browser.exe'};
  const result=await analyzeBundle(files('<meta name="viewport" content="width=device-width, initial-scale=1"><style>.hidden{display:none}</style><p class="hidden">Ready</p><a href="/contact">Book</a>'),[check('TEXT','Ready'),check('LINK','/reserve'),check('OVERFLOW','390')],options);
  assert.deepEqual(result.evidence.map(e=>e.status),['REVIEW_REQUIRED','FAIL','REVIEW_REQUIRED']);
  assert.deepEqual(result.evidence.map(e=>e.measurement),['STATIC_ONLY','STATIC_ONLY','STATIC_ONLY']);
  assert.match(result.evidence[1].observed!,/Unrendered source-static DOM.*\/contact/); assert.match(result.evidence[1].detail,/not browser-measured/);
  const good=await analyzeBundle(files('<p>Ready</p><a href="/reserve">Book</a>'),[check('LINK','/reserve')],options);
  assert.equal(good.evidence[0].status,'REVIEW_REQUIRED'); assert.equal(good.evidence[0].measurement,'STATIC_ONLY');
});
test('SP004 escaped and nested CSS image functions are removed without dropping harmless text', () => {
  const result=analyze(files('<style>p{background:i\\6d age-set(cross-fade("https://seller.example/a.png",image-set("https://seller.example/b.png" 1x),50%) 1x);content:"Benign label"}</style><p>Safe</p>'),[check('TEXT','Safe')]);
  assert.ok(!result.preview.includes('seller.example')); assert.ok(result.preview.includes('Benign label')); assert.ok(!result.preview.includes('image-set('));
});
test('SP004 client iframe receives real CSP and produces no external request attempts', async () => {
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.PREVIEW_BROWSER_PATH});
  try {
    const context=await browser.newContext();let attempts=0;
    await context.route('**/*',route=>{attempts++;return route.abort();});
    const page=await context.newPage();await page.setContent('<iframe sandbox="" title="client preview"></iframe>');
    const result=analyze(files('<!-- <head> --><head title="original"><style>body{background:image-set("https://seller.example/p.png" 1x)}</style></head><p>Safe</p>'),[check('TEXT','Safe')]);
    await page.locator('iframe').evaluate((el,preview)=>{(el as HTMLIFrameElement).srcdoc=preview;},result.preview);
    const frame=page.frameLocator('iframe');await frame.locator('body').getByText('Safe',{exact:true}).waitFor();
    assert.equal(await frame.locator('head > :first-child').getAttribute('http-equiv'),'Content-Security-Policy');
    assert.equal(attempts,0);
  } finally {await browser.close();}
});
