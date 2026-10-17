import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Force the same honest fallback on machines with and without a browser cache.
// These tests never claim browser-measured PASS; the full suite still requires it.
const unavailableBrowser=fileURLToPath(new URL('../tests/__intentionally_unavailable_chromium__',import.meta.url));
if(existsSync(unavailableBrowser))throw new Error('The unit suite requires its deliberate missing-browser path to be absent.');
const files=['ai-config','compiler','core','external-feedback','followup-payment','lifecycle','preview-diagnostics','reliability']
  .map(name=>fileURLToPath(new URL(`../tests/${name}.test.ts`,import.meta.url)));
console.log('Running non-browser checks with Chromium deliberately unavailable. Provider calls use controlled test responses.');
const child=spawn(process.execPath,['--experimental-transform-types','--test',...files],{
  stdio:'inherit',windowsHide:true,
  env:{...process.env,PREVIEW_BROWSER_PATH:unavailableBrowser},
});
child.on('error',()=>{console.error('Could not start the unit test process.');process.exitCode=1;});
child.on('close',code=>{process.exitCode=code??1;});
