import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPreviewFailure, inspectPreview } from '../server/preview-worker.ts';
import type { Criterion, Evidence } from '../server/types.ts';

test('launch diagnostics classify known causes into fixed categories',()=>{
  const cases:[string,string][]=[
    ['Chromium sandboxing failed!','SANDBOX_PERMISSIONS'],
    ['Running as root without --no-sandbox is not supported.','SANDBOX_PERMISSIONS'],
    ['Failed to move to new namespace: Operation not permitted','SANDBOX_PERMISSIONS'],
    ['spawn chromium EACCES','SANDBOX_PERMISSIONS'],
    ["browserType.launch: Executable doesn't exist at /private/user/browser",'MISSING_EXECUTABLE'],
    ['spawn chrome ENOENT','MISSING_EXECUTABLE'],
    ['Host system is missing dependencies to run browsers.','MISSING_LINUX_DEPENDENCIES'],
    ['chrome: error while loading shared libraries: libX11.so: cannot open shared object file','MISSING_LINUX_DEPENDENCIES'],
    ['browserType.launch: Timeout 10000ms exceeded.','DEADLINE'],
    ['worker deadline exceeded','DEADLINE'],
    ['uploaded-private-marker /private/payment.env unexplained renderer error','UNKNOWN'],
  ];
  for(const [message,category] of cases)assert.equal(classifyPreviewFailure(new Error(message)),category);
  assert.equal(classifyPreviewFailure(Object.assign(new Error('launch'),{code:'EPERM'})),'SANDBOX_PERMISSIONS');
  assert.equal(classifyPreviewFailure(null),'UNKNOWN');
});

test('diagnostic classification is bounded and retains beginning and end causes',()=>{
  assert.equal(classifyPreviewFailure('Chromium sandboxing failed!'+'.'.repeat(100_000)),'SANDBOX_PERMISSIONS');
  assert.equal(classifyPreviewFailure('.'.repeat(100_000)+"Executable doesn't exist"),'MISSING_EXECUTABLE');
  assert.equal(classifyPreviewFailure('.'.repeat(5000)+'Chromium sandboxing failed!'+'.'.repeat(5000)),'UNKNOWN');
});

const criteria:Criterion[]=[{id:'present',type:'TEXT',label:'Required text',value:'Present'},{id:'wrong-link',type:'LINK',label:'Booking destination',value:'/reserve'},{id:'human',type:'HUMAN_REVIEW',label:'Visual approval',value:'Review design'}];
const staticEvidence:Evidence[]=[{type:'TEXT',label:'Required text',status:'PASS',observed:'Literal source text exists.',detail:'Static presence only.'},{type:'LINK',label:'Booking destination',status:'FAIL',observed:'/contact',detail:'Required destination is absent.'}];
test('actual unavailable executable gives safe useful fallback and preserves source FAIL',async()=>{
  const privatePath=process.platform==='win32'?'C:/scopeproof-private-marker/not-installed/chrome.exe':'/scopeproof-private-marker/not-installed/chrome';
  const evidence=await inspectPreview('<p>Present</p><a href="/contact">Booking</a>',criteria,{executablePath:privatePath,staticEvidence});
  assert.deepEqual(evidence.map(e=>[e.status,e.measurement]),[['REVIEW_REQUIRED','STATIC_ONLY'],['FAIL','STATIC_ONLY'],['REVIEW_REQUIRED','HUMAN']]);
  assert.match(evidence[0].detail,/browser or worker executable is unavailable/);
  assert.match(evidence[0].detail,/separate acknowledgment is required/);
  assert.doesNotMatch(JSON.stringify(evidence),/scopeproof-private-marker|not-installed|browserType\.launch|Call log/);
  assert.match(evidence[1].observed||'',/\/contact/);
});

test('actual worker deadline remains unmeasured and uses a fixed diagnostic',async()=>{
  const evidence=await inspectPreview('<p>Present</p>',criteria,{timeoutMs:1,staticEvidence});
  assert.equal(evidence[0].measurement,'STATIC_ONLY');assert.equal(evidence[0].status,'REVIEW_REQUIRED');
  assert.equal(evidence[1].status,'FAIL');
  assert.match(evidence[0].detail,/exceeded its measurement deadline/);
  assert.doesNotMatch(evidence[0].detail,/install Chromium/);
});
