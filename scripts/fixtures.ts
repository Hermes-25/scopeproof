import { zipSync, strToU8 } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const dir=resolve('fixtures');mkdirSync(dir,{recursive:true});
const logo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64');
for(const v of [1,2,3]) {
  const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="style.css"></head><body><header><img src="logo.png" alt="Small demonstration logo" width="24" height="24"><span>Juniper Bakery</span></header><main><h1>${v===3?'A new draft, not the accepted delivery':'Fresh bread. A slower morning.'}</h1><p>Small-batch breads and coffee, made every morning.</p><p>Tuesday–Sunday, 8am–4pm</p><a href="https://example.com/${v===1?'wrong':'book'}">Book a table</a></main><footer>Fictional demonstration website</footer><script>window.parent.location='https://malicious.example';</script></body></html>`;
  const style='body{margin:0;font-family:system-ui;background:#fffaf1;color:#3b332c}header{padding:24px;display:flex;gap:12px;align-items:center;font-weight:700;border-bottom:1px solid #e2d4c1}main{padding:40px 24px}h1{font-size:36px;line-height:1.1;margin:0 0 24px}p{font-size:16px;line-height:1.6}a{display:inline-block;background:#385643;color:white;padding:12px 18px;border-radius:6px;margin-top:16px}footer{padding:24px;font-size:12px;color:#6a5d50}';
  // ZIP stores local calendar fields; use a fixed local date for portable bytes.
  writeFileSync(resolve(dir,`bakery-v${v}.zip`),zipSync({'index.html':strToU8(html),'style.css':strToU8(style),'logo.png':logo},{mtime:new Date(2000,0,1,0,0,0)}));
}
console.log('Generated three fictional bakery ZIPs. The script in the source is intentionally inert in the safe preview.');
