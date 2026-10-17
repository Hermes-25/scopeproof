import yauzl from 'yauzl';
import { parse, parseFragment, serialize } from 'parse5';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Criterion, Evidence } from './types.ts';
import { inspectPreview, inspectSourceViewport, type PreviewOptions } from './preview-worker.ts';
import { localAssetReference } from './asset-reference.ts';
const MAX = 8 * 1024 * 1024;
export function safePath(name: string) {
  if (!name || name.length > 180 || name.includes('\\') || name.startsWith('/') || /(^|\/)\.\.($|\/)/.test(name) || /[:\x00-\x1f]/.test(name) || posix.normalize(name) !== name) throw new Error('ZIP contains an unsafe file path. Use ordinary relative paths.');
  return name;
}
export async function unpack(buffer: Buffer): Promise<Map<string, Buffer>> {
  if (!buffer.length || buffer.length > 4 * 1024 * 1024) throw new Error('Upload a ZIP smaller than 4 MB.');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, value) => error || !value ? reject(error) : resolve(value)));
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>(); let size = 0; let entries = 0; let finished = false;
    const fail = (error: Error) => { if (!finished) { finished = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      try {
        if (++entries > 64) throw new Error('ZIP may contain at most 64 entries.');
        const name = safePath(entry.fileName);
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0xf000) === 0xa000) throw new Error('Symbolic links are not allowed.');
        if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted ZIPs are not supported.');
        if (name.endsWith('/')) { zip.readEntry(); return; }
        if (!/\.(html?|css|png|jpe?g|gif|webp|txt)$/i.test(name)) throw new Error(`Unsupported file: ${name}. Use HTML, CSS and raster images only.`);
        if (files.has(name)) throw new Error('ZIP contains duplicate file names.');
        if (entry.uncompressedSize > MAX || size + entry.uncompressedSize > MAX) throw new Error('Expanded ZIP must be smaller than 8 MB.');
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(error || new Error('Cannot read ZIP.')); return; }
          const chunks: Buffer[] = []; let count = 0;
          stream.on('data', (chunk: Buffer) => { count += chunk.length; if (count > MAX || size + count > MAX) { stream.destroy(); fail(new Error('Expanded ZIP is too large.')); } else chunks.push(chunk); });
          stream.on('error', fail);
          stream.on('end', () => { if (!finished) { size += count; files.set(name, Buffer.concat(chunks)); zip.readEntry(); } });
        });
      } catch (error) { fail(error as Error); }
    });
    zip.on('end', () => { if (!finished) { finished = true; if (!files.has('index.html')) reject(new Error('ZIP must contain index.html at its root.')); else resolve(files); } });
    zip.readEntry();
  });
}
type Node = any;
function attr(node: Node, name: string): string { return node.attrs?.find((a: any) => a.name === name)?.value || ''; }
function walk(node: Node, fn: (node: Node) => void) { fn(node); for (const child of node.childNodes || []) walk(child, fn); }
function text(node: Node): string {
  // Source-static presence includes hidden text. Without a browser it is an
  // observation, never a visibility pass or a reason to fail hidden content.
  if (['script', 'style', 'head', 'template'].includes(node.tagName)) return '';
  return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join(' ');
}
function imageMime(bytes?: Buffer): string | undefined {
  if (!bytes) return;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
}
function css(value: string) {
  // Decode escapes before removing network-bearing CSS tokens. CSP and the
  // worker's request blocker remain independent defences for malformed CSS.
  const decoded = value.replace(/\\(?:\r\n|\r|\n)/g,'').replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff))).replace(/\\([^\r\n])/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;?/gi, '');
  // Remove the entire nested expression, including string-based image-set and
  // cross-fade URLs. This is conservative; the DOM-inserted CSP is separate.
  const functions = /(?:^|\b)(?:url|image|image-set|-webkit-image-set|cross-fade|-webkit-cross-fade|src)\s*\(/gi;
  let result = ''; let last = 0; let match: RegExpExecArray | null;
  while ((match = functions.exec(decoded))) {
    result += decoded.slice(last, match.index) + 'none';
    let end = functions.lastIndex, depth = 1, quote = '';
    for (; end < decoded.length && depth; end++) {
      const ch = decoded[end];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++; else if (ch === ')') depth--;
    }
    last = end; functions.lastIndex = end;
  }
  return (result + decoded.slice(last)).replace(/</g, '\\3c ');
}
export function analyze(files: Map<string, Buffer>, criteria: Criterion[]) {
  let previewBytes = files.get('index.html')!.length;
  const addPreviewBytes = (bytes: number) => { previewBytes += bytes; if (previewBytes > 12 * 1024 * 1024) throw new Error('Sanitized preview is too large. Reduce repeated image references or stylesheets.'); };
  const document = parse(files.get('index.html')!.toString('utf8')) as Node;
  const sourceViewport = inspectSourceViewport(files.get('index.html')!.toString('utf8'));
  const nodes: Node[] = []; walk(document, (n) => nodes.push(n));
  const normal = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
  const asset = (reference:string) => {const name=localAssetReference(reference);return name?files.get(name):undefined;};
  const evidence: Evidence[] = criteria.map((c) => {
    let pass = false; let detail = '';
    if (c.type === 'HUMAN_REVIEW') return { type: c.type, label: c.label, criterionId: c.id, agreed: c.value, status: 'REVIEW_REQUIRED', measurement:'HUMAN', detail: 'This requirement has no supported objective check. Review it manually.' };
    if (c.type === 'TEXT') { const parts=nodes.filter(n=>n.nodeName==='#text'&&!['script','style','head','template'].some(tag=>{let p=n.parentNode;while(p){if(p.tagName===tag)return true;p=p.parentNode;}return false;})).map(n=>n.value); pass = !!normal(c.value) && (normal(text(document)).includes(normal(c.value)) || normal(parts.join('')).includes(normal(c.value))); detail = pass ? `Unrendered source-static DOM contains literal “${c.value}”. Visibility, CSS and browser behavior were not measured.` : `Literal “${c.value}” was not found in unrendered source-static DOM text. This is not a live-site or visual assessment.`; }
    if (c.type === 'LINK') { pass = nodes.some(n => n.tagName === 'a' && attr(n, 'href') === c.value && normal(text(n))); detail = pass ? `Anchor destination matches ${c.value}. We did not visit the destination or test its availability.` : `No nonempty anchor has the agreed destination ${c.value}.`; }
    if (c.type === 'IMAGE') { const agreed=localAssetReference(c.value);pass = !!agreed&&nodes.some(n => n.tagName === 'img' && localAssetReference(attr(n, 'src')) === agreed && !!imageMime(asset(c.value))); detail = pass ? `Image ${c.value} is referenced and has a supported raster signature. Its visual appearance needs review.` : `Image ${c.value} is missing, unreferenced or not a supported raster image.`; }
    if (c.type === 'OVERFLOW') return { type:c.type,label:c.label,criterionId:c.id,agreed:c.value,measurement:'STATIC_ONLY',status: 'REVIEW_REQUIRED', observed:sourceViewport.content||'Source viewport meta missing.',detail:`Mobile overflow has not been browser-measured. ${sourceViewport.reason}` };
    return { type: c.type, label: c.label, criterionId: c.id, status: pass ? 'REVIEW_REQUIRED' : 'FAIL', measurement:'STATIC_ONLY', detail:`Unrendered source-static observation: ${detail}`, agreed: c.value, observed: c.type === 'LINK' ? [...new Set(nodes.filter(n => n.tagName === 'a').map(n => attr(n, 'href')))].join(', ') || 'No anchor destinations found.' : pass ? c.value : 'Not found.' };
  });
  const allowed = new Set('html head body title div section article main header footer nav aside address figure figcaption picture p span small time dl dt dd button label details summary mark abbr cite q samp kbd var sub sup s del ins u wbr h1 h2 h3 h4 h5 h6 a img ul ol li strong em b i br hr table caption colgroup col thead tbody tfoot tr th td blockquote pre code style'.split(' '));
  const discard = new Set('script iframe frame frameset object embed portal svg math template noscript form input source audio video canvas base'.split(' '));
  function clean(node: Node) {
    if (node.childNodes) node.childNodes = node.childNodes.flatMap((child: Node) => {
      if (child.namespaceURI && child.namespaceURI !== 'http://www.w3.org/1999/xhtml' || discard.has(child.tagName)) return [];
      if (child.tagName === 'meta') {
        if (attr(child,'name').toLowerCase() !== 'viewport') return [];
        child.attrs=[{name:'name',value:'viewport'},{name:'content',value:attr(child,'content')}];child.parentNode=node;return [child];
      }
      if (child.tagName === 'link' && attr(child,'rel').toLowerCase() !== 'stylesheet') return [];
      if (child.tagName && !allowed.has(child.tagName) && child.tagName !== 'link') {
        clean(child);return (child.childNodes||[]).map((descendant:Node)=>{descendant.parentNode=node;return descendant;});
      }
      if (child.tagName === 'link') { const source = asset(attr(child, 'href')); const value = css(source?.toString('utf8') || ''); addPreviewBytes(Buffer.byteLength(value)); child.tagName = child.nodeName = 'style'; child.attrs = []; child.childNodes = [{ nodeName: '#text', value, parentNode: child }]; }
      if (child.tagName === 'style') for (const n of child.childNodes || []) if (n.nodeName === '#text') n.value = css(n.value);
      if (child.attrs) {
        const sourceName = attr(child, 'src'); const destination = attr(child, 'href');
        const image = child.tagName === 'img' ? asset(sourceName) : undefined; const mime = imageMime(image);
        child.attrs = child.attrs.filter((a: any) => ['class','id','title','alt','width','height','style','colspan','rowspan','lang','hidden','datetime','open'].includes(a.name)).map((a: any) => a.name === 'style' ? {...a, value: css(a.value)} : a);
        if(child.tagName==='button') child.attrs.push({name:'type',value:'button'});
        if (mime && image) { addPreviewBytes(Math.ceil(image.length / 3) * 4 + 40); child.attrs.push({name:'src', value:`data:${mime};base64,${image.toString('base64')}`}); }
        if (child.tagName === 'img' && mime && image) child.attrs.push({name:'data-scopeproof-source',value:sourceName});
        if (child.tagName === 'a') { child.attrs.push({name:'href',value:'#'}); child.attrs.push({name:'data-scopeproof-destination',value:destination}); }
      }
      clean(child); child.parentNode=node;return [child];
    });
  }
  clean(document);
  // Insert real tree nodes: a comment containing '<head>' cannot displace CSP.
  const head = document.childNodes?.find((n: Node) => n.tagName === 'html')?.childNodes?.find((n: Node) => n.tagName === 'head');
  if (head) head.attrs = [];
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">`;
  const policyNode=(parseFragment(policy) as Node).childNodes[0];policyNode.parentNode=head;head.childNodes.unshift(policyNode);
  const preview = serialize(document);
  if (Buffer.byteLength(preview) > 12 * 1024 * 1024) throw new Error('Sanitized preview is too large. Reduce repeated image references or stylesheets.');
  return { evidence, preview, sourceViewport };
}
export async function analyzeBundle(files: Map<string, Buffer>, criteria: Criterion[], options: PreviewOptions = {}) {
  const { preview, evidence:staticEvidence, sourceViewport } = analyze(files, criteria);
  const evidence = await inspectPreview(preview, criteria,{...options,staticEvidence,sourceViewport});
  return { evidence, preview };
}
export const hashBundle = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
