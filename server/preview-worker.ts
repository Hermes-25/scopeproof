import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Criterion, Evidence } from './types.ts';
import { parse } from 'parse5';
import { localAssetReference } from './asset-reference.ts';

const DEADLINE = 18_000;
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
type Observation = { text: string; links: string[]; images: string[]; viewport: number; scrollWidth: number };
type WorkerResult = { observations: Record<string, Observation> };
const MAX_DIAGNOSTIC_CHARACTERS = 8192;
const FAILURE_MESSAGES = {
  SANDBOX_PERMISSIONS: 'Chromium sandbox or process permissions prevented measurement. On Linux, run the app as a non-root user and verify that the host permits Chromium sandboxing. Keep the browser sandbox enabled',
  MISSING_EXECUTABLE: 'The browser or worker executable is unavailable. Install Chromium or verify the configured browser executable',
  MISSING_LINUX_DEPENDENCIES: 'Chromium cannot start because Linux browser system dependencies are missing. Install the supported browser system dependencies on the host',
  DEADLINE: 'The restricted browser worker exceeded its measurement deadline. Check host resources and retry the measurement',
  UNKNOWN: 'The restricted browser worker could not complete measurement for an unidentified reason. No browser pass is recorded',
} as const;
export type PreviewFailureCategory = keyof typeof FAILURE_MESSAGES;
const failureCategory = (value:unknown):value is PreviewFailureCategory => typeof value==='string'&&Object.hasOwn(FAILURE_MESSAGES,value);
/** Inspect internal diagnostics only; callers receive a fixed category, never the diagnostic text. */
export function classifyPreviewFailure(error:unknown):PreviewFailureCategory {
  const raw=typeof error==='string'?error:error instanceof Error?`${'code' in error?String(error.code):''} ${error.message}`:'';
  const diagnostic=raw.length>MAX_DIAGNOSTIC_CHARACTERS?raw.slice(0,MAX_DIAGNOSTIC_CHARACTERS/2)+raw.slice(-MAX_DIAGNOSTIC_CHARACTERS/2):raw;
  if(/running as root without --no-sandbox|chromium sandboxing failed|no usable sandbox|failed to move to new namespace|(?:sandbox|namespace).{0,120}(?:operation not permitted|permission denied)|\b(?:EPERM|EACCES)\b/i.test(diagnostic))return 'SANDBOX_PERMISSIONS';
  if(/host system is missing dependencies|error while loading shared libraries|cannot open shared object file/i.test(diagnostic))return 'MISSING_LINUX_DEPENDENCIES';
  if(/executable doesn['’]t exist|executable does not exist|executable.*(?:not found|no such file)|failed to launch.*(?:doesn['’]t exist|not found)|\bENOENT\b/i.test(diagnostic))return 'MISSING_EXECUTABLE';
  if(/worker deadline exceeded|\btimeout\s*\d*\s*ms?\s*exceeded|timed out|\bTimeoutError\b/i.test(diagnostic))return 'DEADLINE';
  return 'UNKNOWN';
}
class PreviewFailure extends Error {
  constructor(readonly category:PreviewFailureCategory){super(FAILURE_MESSAGES[category]);}
}
export type SourceViewport = { valid:boolean; content?:string; reason:string };
export type PreviewOptions = { executablePath?:string; timeoutMs?:number; staticEvidence?:Evidence[]; sourceViewport?:SourceViewport };

export function inspectSourceViewport(html:string):SourceViewport {
  const metas:any[]=[];const walk=(n:any)=>{if(n.tagName==='meta'&&n.attrs?.find((a:any)=>a.name==='name')?.value.toLowerCase()==='viewport') metas.push(n);for(const c of n.childNodes||[])walk(c);};walk(parse(html));
  if(!metas.length)return {valid:false,reason:'Source viewport meta is missing; mobile overflow cannot be established. No viewport has been invented.'};
  const content=String(metas[0].attrs?.find((a:any)=>a.name==='content')?.value||'');
  if(metas.length!==1)return {valid:false,content:content.slice(0,300),reason:'Source viewport has multiple conflicting declarations; resolve them before claiming mobile overflow.'};
  const pairs=content.split(/[,;]/).map(p=>p.trim().toLowerCase().split(/\s*=\s*/));
  const keys=pairs.map(([k])=>k);const viewport=new Map(pairs.map(([k,v])=>[k,v]));
  const allowed=new Set(['width','initial-scale','minimum-scale','maximum-scale','user-scalable','viewport-fit']);
  const unsafe=content.length>300||pairs.some(p=>p.length!==2)||new Set(keys).size!==keys.length||keys.some(k=>!allowed.has(k))||viewport.get('width')!=='device-width'||['initial-scale','minimum-scale','maximum-scale'].some(k=>viewport.has(k)&&Number(viewport.get(k))!==1)||viewport.has('user-scalable')&&!['yes','no','1','0'].includes(viewport.get('user-scalable')!)||viewport.has('viewport-fit')&&!['auto','cover','contain'].includes(viewport.get('viewport-fit')!);
  if(unsafe)return {valid:false,content:content.slice(0,300),reason:'Source viewport is unsupported or unsafe for this mobile check; require one width=device-width declaration with scale 1 if provided. It was not replaced.'};
  return {valid:true,content,reason:`Genuine source viewport preserved: ${content}.`};
}

function unavailable(criteria: Criterion[], reason: string, staticEvidence:Evidence[]=[]): Evidence[] {
  return criteria.map((c,i) => {
    const source=staticEvidence[i];
    if(c.type==='HUMAN_REVIEW')return {type:c.type,label:c.label,criterionId:c.id,agreed:c.value,measurement:'HUMAN',observed:'Human decision required.',status:'REVIEW_REQUIRED',detail:'This unsupported or subjective requirement always requires explicit human review.'};
    return {type:c.type,label:c.label,criterionId:c.id,agreed:c.value,measurement:'STATIC_ONLY',observed:`Unrendered source-static DOM: ${source?.observed||'No browser measurement or static observation available.'}`,status:source?.status==='FAIL'?'FAIL':'REVIEW_REQUIRED',detail:`Restricted browser measurement unavailable: ${reason}. ${source?.detail||'No browser pass is recorded.'} Objective checks were not browser-measured; separate acknowledgment is required.`};
  });
}

/** Each upload is measured in a disposable process. Uploaded scripts never run. */
export async function inspectPreview(preview: string, criteria: Criterion[], options: PreviewOptions = {}): Promise<Evidence[]> {
  if (Buffer.byteLength(preview) > MAX_PREVIEW_BYTES) return unavailable(criteria, 'sanitized preview is too large',options.staticEvidence);
  const sourceViewport=options.sourceViewport||inspectSourceViewport(preview);
  const widths = [...new Set(criteria.filter(c => c.type === 'OVERFLOW').map(c => Number(c.value)).filter(n => Number.isInteger(n) && n >= 320 && n <= 1440))];
  if (!widths.includes(390)) widths.push(390);
  const presenceWidth = widths[0];
  try {
    const output = await new Promise<WorkerResult>((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=256', '--experimental-transform-types', fileURLToPath(import.meta.url), '--scopeproof-preview-child'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
        // Do not expose application/payment/AI credentials to the rendering process.
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','PLAYWRIGHT_BROWSERS_PATH'].includes(k))),
      });
      let stdout = ''; let stderr = ''; let settled = false;
      const stop = () => {
        if (child.pid && process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.on('error', () => child.kill());
        } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const timer = setTimeout(() => { if (!settled) { settled = true; stop(); reject(new PreviewFailure('DEADLINE')); } }, options.timeoutMs ?? DEADLINE);
      const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); stop(); reject(new PreviewFailure(classifyPreviewFailure(error))); } };
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('data', bytes => { stdout += bytes.toString(); if (stdout.length > 1024 * 1024) fail(new Error('worker output limit exceeded')); });
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-MAX_DIAGNOSTIC_CHARACTERS); });
      child.on('close', code => {
        if (settled) return; settled = true; clearTimeout(timer);
        try {
          const result = JSON.parse(stdout);
          if(failureCategory(result.failure)){reject(new PreviewFailure(result.failure));return;}
          if(code!==0){reject(new PreviewFailure(classifyPreviewFailure(stderr)));return;}
          if(!result.observations)throw new Error('invalid worker result');resolve(result);
        } catch { reject(new PreviewFailure(code!==0?classifyPreviewFailure(stderr):'UNKNOWN')); }
      });
      child.stdin.end(JSON.stringify({ preview, widths, executablePath: options.executablePath || process.env.PREVIEW_BROWSER_PATH }));
    });
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    return criteria.map(c => {
      const o = output.observations[c.type === 'OVERFLOW' ? String(Number(c.value)) : String(presenceWidth)];
      const base = { type: c.type, label: c.label, criterionId: c.id, agreed: c.value,measurement:'BROWSER' as const };
      if (!o) return unavailable([c], 'the requested viewport was not measured')[0];
      if (c.type === 'TEXT') {
        const pass = !!normalize(c.value) && normalize(o.text).includes(normalize(c.value));
        return { ...base, status: pass ? 'PASS' : 'FAIL', observed: pass ? c.value : 'Required text run not found.', detail: `Sanitized script-free render at CSS layout viewport ${o.viewport}px ${pass ? 'contains' : 'does not contain'} literal “${c.value}” in nonempty computed-visible text runs. This does not prove contrast, on-screen position, original-source behavior or appearance.` };
      }
      if (c.type === 'LINK') {
        const pass = o.links.includes(c.value);
        return { ...base, status: pass ? 'PASS' : 'FAIL', observed: o.links.length ? o.links.join(', ') : 'No computed-visible, nonempty anchor destinations.', detail: pass ? `A nonempty computed-visible anchor in the sanitized static render (CSS layout viewport ${o.viewport}px) has original destination ${c.value}. It was not visited. This does not identify the booking button or prove on-screen position, contrast or original-source behavior.` : `Agreed destination ${c.value} was not found among nonempty computed-visible anchors in the sanitized static render at CSS layout viewport ${o.viewport}px. Observed: ${o.links.join(', ') || 'none'}.` };
      }
      if (c.type === 'IMAGE') {
        const agreed=localAssetReference(c.value);
        const pass = !!agreed&&o.images.some(reference=>localAssetReference(reference)===agreed);
        return { ...base, status: pass ? 'PASS' : 'FAIL', observed: o.images.join(', ') || 'No computed-visible decoded bundle images.', detail: pass ? `Image ${c.value} is referenced, decoded and computed-visible in the sanitized static render at CSS layout viewport ${o.viewport}px. On-screen position, content, contrast and original-source behavior require human review.` : `Image ${c.value} is missing, hidden, unreferenced or could not be decoded in the sanitized static render at CSS layout viewport ${o.viewport}px.` };
      }
      if (c.type === 'OVERFLOW') {
        if(!sourceViewport.valid)return {...base,measurement:'STATIC_ONLY',status:'REVIEW_REQUIRED',observed:`Source viewport: ${sourceViewport.content||'missing'}.`,detail:sourceViewport.reason+' No mobile overflow pass is recorded; objective measurement acknowledgment is required.'};
        if(o.viewport!==Number(c.value))return {...base,measurement:'STATIC_ONLY',status:'REVIEW_REQUIRED',observed:`Agreed width ${c.value}px; actual CSS layout viewport ${o.viewport}px.`,detail:'The genuine source viewport did not establish the agreed CSS layout width. No mobile overflow pass is recorded; review the source viewport and separately acknowledge the unmeasured objective check.'};
        const pass = o.scrollWidth <= o.viewport;
        return { ...base, status: pass ? 'PASS' : 'FAIL', observed: `Viewport ${o.viewport}px; document width ${o.scrollWidth}px. Source meta: ${sourceViewport.content}.`, detail: `Mobile-emulated sanitized static render at agreed device width ${c.value}px uses genuine source viewport; CSS layout viewport ${o.viewport}px and document width ${o.scrollWidth}px${pass ? '; no horizontal document overflow detected.' : `; ${o.scrollWidth - o.viewport}px horizontal overflow detected.`} Clipped content, dynamic behavior and original-source visual quality still require human approval.` };
      }
      return { ...base,measurement:'HUMAN', status: 'REVIEW_REQUIRED', observed: 'Human decision required.', detail: 'This requirement has no supported objective check. Review the delivered preview and explicitly confirm it.' };
    });
  } catch (error) { return unavailable(criteria,FAILURE_MESSAGES[error instanceof PreviewFailure?error.category:classifyPreviewFailure(error)],options.staticEvidence); }
}

async function runChild() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk.toString(); if (Buffer.byteLength(input) > 14 * 1024 * 1024) throw new Error('Input limit exceeded'); }
  const { preview, widths, executablePath } = JSON.parse(input);
  if (typeof preview !== 'string' || !Array.isArray(widths) || widths.length > 13 || widths.some((n: number) => !Number.isInteger(n) || n < 320 || n > 1440)) throw new Error('Invalid worker input');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true, args: ['--disable-background-networking', '--disable-extensions', '--disable-component-update', '--no-first-run', '--js-flags=--max-old-space-size=128'], timeout: 10_000 });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, permissions: [], isMobile:true, viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage(); page.setDefaultTimeout(2500);
    await page.setContent(preview, { waitUntil: 'load', timeout: 5000 });
    const observations: Record<string, Observation> = {};
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      observations[String(width)] = await page.evaluate(() => {
        const visible = (el: HTMLElement) => {
          const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
          if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.opacity === '0' || s.visibility === 'hidden' || s.display === 'none') return false; }
          return true;
        };
        const links = [...document.querySelectorAll<HTMLAnchorElement>('a')].filter(el => visible(el) && el.innerText.trim()).map(el => el.dataset.scopeproofDestination || '').filter(Boolean);
        const images = [...document.querySelectorAll<HTMLImageElement>('img')].filter(el => visible(el) && el.complete && el.naturalWidth > 0).map(el => el.dataset.scopeproofSource || '').filter(Boolean);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const textParts: string[] = [];
        while (walker.nextNode()) {
          const node = walker.currentNode; const parent = node.parentElement;
          if (!parent || ['SCRIPT','STYLE','TEMPLATE'].includes(parent.tagName) || !visible(parent) || !node.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          if ([...range.getClientRects()].some(r => r.width && r.height)) textParts.push(node.textContent);
        }
        return { text: textParts.join(' ').slice(0, 500000), links: [...new Set(links)].slice(0, 100), images: [...new Set(images)].slice(0, 100), viewport: document.documentElement.clientWidth, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) };
      });
    }
    process.stdout.write(JSON.stringify({ observations }));
  } finally { await browser.close(); }
}
if (process.argv.includes('--scopeproof-preview-child')) runChild().catch(error => {
  // Launch errors can contain paths and process details. Emit only a whitelisted category.
  process.stdout.write(JSON.stringify({failure:classifyPreviewFailure(error)}));process.exitCode = 1;
});
