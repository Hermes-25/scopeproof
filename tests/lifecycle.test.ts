import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.ts';
import { PayPalAdapter, CaptureNotSubmittedError } from '../server/payments.ts';
import type { Payment, Acceptance, RecoveryAuditInput } from '../server/types.ts';

function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'scopeproof-lifecycle-')),store=new Store(directory);
  const project=store.createProject({title:'Lifecycle fixture',brief:'Accepted static bundle',amount:'1.00'});
  const bytes=Buffer.from('immutable accepted version2 bytes'),hash=createHash('sha256').update(bytes).digest('hex');
  const artifact:any={id:'artifact-v2',projectId:project.id,scopeId:'agreed',version:2,hash,key:hash+'.zip',evidence:[],preview:'',createdAt:new Date().toISOString()};
  store.insert('artifact',artifact);writeFileSync(join(directory,'bundles',artifact.key),bytes);
  const acceptance:Acceptance={id:'accepted-v2',projectId:project.id,scopeId:'agreed',artifactId:artifact.id,hash,amount:'1.00',currency:'USD',createdAt:new Date().toISOString()};store.insert('acceptance',acceptance);
  return {store,project,acceptance,directory,bytes,cleanup(current=store){current.close();const target=realpathSync(directory),inside=relative(realpathSync(tmpdir()),target);if(!inside||isAbsolute(inside)||inside.startsWith('..')||!basename(target).startsWith('scopeproof-lifecycle-'))throw Error('Unsafe cleanup path');rmSync(target,{recursive:true,force:true});}};
}
function audit(p:Payment):RecoveryAuditInput{return {expectedOrderId:p.orderId!,operator:'mock-operator',evidenceRefs:['mock-complete-lifetime-trace','mock-exclusive-runtime-control'],noFinancialSubmission:true,noBuyerApproval:true,noExternalMerchantActions:true,allRuntimesControlled:true,walletSeparateCapture:true};}
function remote(f:ReturnType<typeof fixture>) {
  const units=new Map<string,any>(),states=new Map<string,string>(),posts:string[]=[],createKeys:string[]=[];
  let createFailure=false,postFailure=false,beforePost:((id:string)=>void)|undefined;
  let blockGet:string|undefined, releaseGet:(()=>void)|undefined,enteredGet:(()=>void)|undefined;
  let createGate:Promise<void>|undefined,releaseCreate:(()=>void)|undefined,enteredCreate:(()=>void)|undefined;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith('/token'))return Response.json({access_token:'fixture-only',expires_in:3600});
    if(url.endsWith('/orders')&&init?.method==='POST'){
      const key=(init.headers as any)['PayPal-Request-Id'];createKeys.push(key);if(createFailure)throw Error('mock create timeout');
      if(createGate){enteredCreate?.();await createGate;createGate=undefined;}
      const body=JSON.parse(String(init.body)),id='ORDER-'+body.purchase_units[0].invoice_id;
      units.set(id,body.purchase_units[0]);if(!states.has(id))states.set(id,'PAYER_ACTION_REQUIRED');return Response.json({id,links:[{rel:'payer-action',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]});
    }
    const id=decodeURIComponent(url.split('/orders/')[1]?.split('/')[0]||'');
    if(url.endsWith('/capture')){
      // Observe the actual durable database at the financial network boundary.
      const db=new DatabaseSync(join(f.directory,'scopeproof.db'));const row=db.prepare("SELECT body FROM records WHERE kind='payment' AND id=?").get(units.get(id).invoice_id) as any;const saved=JSON.parse(row.body);assert.equal(saved.financialSubmission,'MAY_HAVE_SUBMITTED');assert.equal(saved.recoveryBlocked,true);assert.ok((db.prepare("SELECT COUNT(*) AS n FROM payment_lifecycle WHERE payment_id=? AND kind='FINANCIAL_SUBMISSION_STARTED'").get(saved.id) as any).n>0);db.close();
      posts.push(id);beforePost?.(id);if(postFailure)throw Error('mock timeout after request invocation');states.set(id,'COMPLETED');return Response.json({status:'COMPLETED'});
    }
    if(blockGet===id){enteredGet?.();await new Promise<void>(resolve=>{releaseGet=resolve;});blockGet=undefined;}
    const state=states.get(id)||'MISSING';
    if(state==='MISSING')return Response.json({name:'RESOURCE_NOT_FOUND'},{status:404});
    const unit=structuredClone(units.get(id));
    if(['PENDING','COMPLETED','DECLINED','FAILED'].includes(state))unit.payments={captures:[{id:'CAPTURE-'+id,status:state,amount:{value:'1.00',currency_code:'USD'},final_capture:true}]};
    if(state==='MALFORMED')unit.payments={captures:null};
    return Response.json({id,status:['PENDING','MALFORMED','DECLINED','FAILED'].includes(state)?'APPROVED':state,purchase_units:[unit]});
  };
  const adapter=new PayPalAdapter({clientId:'fixture-id',secret:'fixture-secret',merchantId:'fixture-merchant',publicUrl:'http://localhost',diagnostic:()=>{}},fetcher);
  return {adapter,posts,createKeys,state:(id:string,state:string)=>states.set(id,state),failCreate:(value:boolean)=>{createFailure=value;},failPost:(value:boolean)=>{postFailure=value;},onPost:(callback:(id:string)=>void)=>{beforePost=callback;},block:(id:string)=>{blockGet=id;return new Promise<void>(resolve=>{enteredGet=resolve;});},release:()=>releaseGet?.(),blockCreate:()=>{createGate=new Promise<void>(resolve=>{releaseCreate=resolve;});return new Promise<void>(resolve=>{enteredCreate=resolve;});},releaseCreate:()=>releaseCreate?.()};
}

test('lifecycle: 404 alone cannot restart; trusted audit appends one immutable successor on the same acceptance',async()=>{
 const f=fixture(),r=remote(f);try{
  const old=await f.store.createPayment(f.project.id,r.adapter);r.state(old.orderId!,'MISSING');await f.store.reconcile(old.id,r.adapter);
  assert.equal(f.store.recoveryEligible(old.id),false);await assert.rejects(f.store.restartUnsubmitted(old.id,r.adapter),/trusted audit/);
  f.store.registerRecoveryAudit(old.id,audit(old));assert.equal(f.store.view(f.project.id).recoveryEligible,true);
  const [next,repeated]=await Promise.all([f.store.restartUnsubmitted(old.id,r.adapter),f.store.restartUnsubmitted(old.id,r.adapter)]);
  assert.equal(next.id,repeated.id);assert.equal(next.replacesAttemptId,old.id);assert.equal(next.acceptanceId,old.acceptanceId);assert.notEqual(next.createKey,old.createKey);assert.notEqual(next.captureKey,old.captureKey);assert.equal(f.store.list('payment',f.project.id).length,2);
  const retained=f.store.get<Payment>('payment',old.id);assert.equal(retained.status,'RETIRED_UNSUBMITTED');assert.equal(retained.orderId,old.orderId);assert.equal(retained.createKey,old.createKey);assert.equal(retained.captureKey,old.captureKey);assert.ok(retained.retirementAuditId);
  assert.equal(f.store.view(f.project.id).payment?.id,next.id);assert.deepEqual(f.store.get('acceptance',f.acceptance.id),f.acceptance);assert.equal(r.posts.length,0);
 }finally{f.cleanup();}
});

test('lifecycle: old capture/cancel authority stays quarantined across restart; status remains available',async()=>{
 const f=fixture(),r=remote(f);let s=f.store;try{
  const old=await s.createPayment(f.project.id,r.adapter);s.registerRecoveryAudit(old.id,audit(old));const next=await s.restartUnsubmitted(old.id,r.adapter);
  s.close();s=new Store(f.directory);assert.throws(()=>s.assertActivePayment(old.id),/retired/);await assert.rejects(s.capture(old.id,r.adapter),/retired/);await s.reconcile(old.id,r.adapter);
  assert.equal(s.get<Payment>('payment',old.id).status,'RETIRED_UNSUBMITTED');assert.equal(s.activePayment(f.project.id)?.id,next.id);assert.equal(r.posts.length,0);
 }finally{f.cleanup(s);}
});

test('lifecycle: legacy missing provenance needs audit, but UNKNOWN/FAILED/CAPTURING never receive an override',async()=>{
 for(const status of ['ORDER_CREATED','UNKNOWN','FAILED','CAPTURING'] as const){
  const f=fixture(),r=remote(f);let s=f.store;try{
   const p=await s.createPayment(f.project.id,r.adapter);s.update('payment',{...p,status,financialSubmission:undefined});s.close();s=new Store(f.directory);
   assert.equal(s.recoveryEligible(p.id),false);
   if(status==='ORDER_CREATED'){assert.equal(s.get<Payment>('payment',p.id).financialSubmission,'LEGACY_UNKNOWN');s.registerRecoveryAudit(p.id,audit(p));assert.equal(s.recoveryEligible(p.id),true);}
   else {assert.throws(()=>s.registerRecoveryAudit(p.id,audit(p)),/not eligible/);await assert.rejects(s.restartUnsubmitted(p.id,r.adapter),/trusted audit/);}
   assert.equal(r.posts.length,0);
  }finally{f.cleanup(s);}
 }
});

test('lifecycle: audit binding/boolean checks and active CAPTURING exclude retirement',async()=>{
 const f=fixture(),r=remote(f);try{
  const p=await f.store.createPayment(f.project.id,r.adapter);
  assert.throws(()=>f.store.registerRecoveryAudit(p.id,{...audit(p),expectedOrderId:'wrong'}),/not eligible/);
  assert.throws(()=>f.store.registerRecoveryAudit(p.id,{...audit(p),allRuntimesControlled:false} as any),/trusted audit/);
  f.store.registerRecoveryAudit(p.id,audit(p));r.state(p.orderId!,'APPROVED');const entered=r.block(p.orderId!);const capturing=f.store.capture(p.id,r.adapter);await entered;
  await assert.rejects(f.store.restartUnsubmitted(p.id,r.adapter),/trusted audit/);r.release();assert.equal((await capturing).status,'PAID');assert.equal(r.posts.length,1);
 }finally{f.cleanup();}
});

test('lifecycle: actual pre-submit refusal remains resumable; actual financial send persists through crash and cannot be reset',async()=>{
 const f=fixture(),r=remote(f);let s=f.store;try{
  const p=await s.createPayment(f.project.id,r.adapter);assert.equal((await s.capture(p.id,r.adapter)).status,'ORDER_CREATED');assert.equal(s.get<Payment>('payment',p.id).financialSubmission,'NEVER_SUBMITTED');
  r.state(p.orderId!,'APPROVED');r.failPost(true);assert.equal((await s.capture(p.id,r.adapter)).status,'UNKNOWN');assert.equal(r.posts.length,1);
  s.close();s=new Store(f.directory);const saved=s.get<Payment>('payment',p.id);assert.equal(saved.financialSubmission,'MAY_HAVE_SUBMITTED');assert.throws(()=>s.registerRecoveryAudit(p.id,audit(p)),/not eligible/);
  s.paymentUpdate({...saved,status:'ORDER_CREATED',financialSubmission:'NEVER_SUBMITTED',recoveryBlocked:false});
  r.adapter.capture=async()=>{throw new CaptureNotSubmittedError('subsequent local refusal');};assert.equal((await s.capture(p.id,r.adapter)).status,'UNKNOWN');assert.equal(s.get<Payment>('payment',p.id).financialSubmission,'MAY_HAVE_SUBMITTED');assert.equal(r.posts.length,1);
 }finally{f.cleanup(s);}
});

test('lifecycle: successor create timeout retains keys and intent; retries cannot append a third attempt',async()=>{
 const f=fixture(),r=remote(f);try{
  const old=await f.store.createPayment(f.project.id,r.adapter);f.store.registerRecoveryAudit(old.id,audit(old));r.failCreate(true);
  const next=await f.store.restartUnsubmitted(old.id,r.adapter);assert.equal(next.status,'CREATE_UNKNOWN');r.failCreate(false);
  const resumed=await f.store.restartUnsubmitted(old.id,r.adapter);assert.equal(resumed.id,next.id);assert.equal(resumed.createKey,next.createKey);assert.equal(resumed.captureKey,next.captureKey);assert.deepEqual(r.createKeys,[old.createKey,next.createKey,next.createKey]);assert.equal(f.store.list('payment',f.project.id).length,2);
 }finally{f.cleanup();}
});

test('lifecycle: unresolved successor create retry is refused exactly at six hours without key rotation or a third attempt',async()=>{
 const f=fixture(),r=remote(f),originalNow=Date.now;try{
  const old=await f.store.createPayment(f.project.id,r.adapter);f.store.registerRecoveryAudit(old.id,audit(old));r.failCreate(true);const next=await f.store.restartUnsubmitted(old.id,r.adapter);
  const created=Date.parse(next.createdAt);Date.now=()=>created+6*60*60*1000-1;
  const inside=await f.store.restartUnsubmitted(old.id,r.adapter);assert.equal(inside.status,'CREATE_UNKNOWN');assert.deepEqual(r.createKeys,[old.createKey,next.createKey,next.createKey]);
  Date.now=()=>created+6*60*60*1000;
  await assert.rejects(f.store.restartUnsubmitted(old.id,r.adapter),/six-hour retry window/);assert.equal(r.createKeys.length,3);
  const saved=f.store.get<Payment>('payment',next.id);assert.equal(saved.status,'CREATE_UNKNOWN');assert.equal(saved.createKey,next.createKey);assert.equal(saved.captureKey,next.captureKey);assert.equal(f.store.list('payment',f.project.id).length,2);assert.equal(r.posts.length,0);
  f.store.update('payment',{...saved,status:'FAILED'});await assert.rejects(f.store.createPayment(f.project.id,r.adapter),/six-hour retry window/);assert.equal(r.createKeys.length,3);
 }finally{Date.now=originalNow;f.cleanup();}
});

for(const state of ['COMPLETED','PENDING','MALFORMED','DECLINED','FAILED'])test(`lifecycle: in-flight old GET returning ${state} after retirement freezes successor before financial POST`,async()=>{
 const f=fixture(),r=remote(f);try{
  const old=await f.store.createPayment(f.project.id,r.adapter);f.store.registerRecoveryAudit(old.id,audit(old));const enteredOld=r.block(old.orderId!);const checking=f.store.reconcile(old.id,r.adapter);await enteredOld;
  const next=await f.store.restartUnsubmitted(old.id,r.adapter);r.state(old.orderId!,state);r.release();await checking;
  assert.equal(f.store.get<Payment>('payment',next.id).status,'UNKNOWN');r.state(next.orderId!,'APPROVED');await f.store.capture(next.id,r.adapter);assert.equal(r.posts.length,0);assert.equal(f.store.recoveryEligible(next.id),false);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get() as any).n,state==='COMPLETED'?1:0);
 }finally{f.cleanup();}
});

test('lifecycle: late old completion during successor preflight stops its already-admitted capture at fetch boundary',async()=>{
 const f=fixture(),r=remote(f);try{
  const old=await f.store.createPayment(f.project.id,r.adapter);f.store.registerRecoveryAudit(old.id,audit(old));const next=await f.store.restartUnsubmitted(old.id,r.adapter);r.state(next.orderId!,'APPROVED');const entered=r.block(next.orderId!);const capturing=f.store.capture(next.id,r.adapter);await entered;
  r.state(old.orderId!,'COMPLETED');await f.store.reconcile(old.id,r.adapter);r.release();await capturing;assert.equal(r.posts.length,0);assert.equal(f.store.get<Payment>('payment',next.id).status,'UNKNOWN');assert.equal(f.store.view(f.project.id).payment?.id,old.id);
 }finally{f.cleanup();}
});

test('lifecycle: late old financial history during successor create cannot restore capture authority via stale create result',async()=>{
 const f=fixture(),r=remote(f);try{
  const old=await f.store.createPayment(f.project.id,r.adapter);f.store.registerRecoveryAudit(old.id,audit(old));const entered=r.blockCreate();const restarting=f.store.restartUnsubmitted(old.id,r.adapter);await entered;
  r.state(old.orderId!,'PENDING');await f.store.reconcile(old.id,r.adapter);assert.equal(f.store.activePayment(f.project.id)?.status,'UNKNOWN');r.releaseCreate();const next=await restarting;
  assert.equal(next.status,'UNKNOWN');assert.equal(next.recoveryBlocked,true);assert.ok(next.orderId);r.state(next.orderId!,'APPROVED');assert.equal((await f.store.capture(next.id,r.adapter)).status,'UNKNOWN');assert.equal(r.posts.length,0);assert.equal(f.store.recoveryEligible(next.id),false);
 }finally{f.cleanup();}
});

test('lifecycle: successor pays accepted v2 after v3; late second completion records incident but creates one entitlement',async()=>{
 const f=fixture(),r=remote(f);try{
  const old=await f.store.createPayment(f.project.id,r.adapter);f.store.registerRecoveryAudit(old.id,audit(old));const next=await f.store.restartUnsubmitted(old.id,r.adapter);
  f.store.insert('artifact',{id:'artifact-v3',projectId:f.project.id,scopeId:'agreed',version:3,hash:'different',key:'v3.zip',evidence:[],preview:'',createdAt:new Date().toISOString()});
  r.state(next.orderId!,'APPROVED');assert.equal((await f.store.capture(next.id,r.adapter)).status,'PAID');assert.equal(r.posts.length,1);const e=f.store.entitlement(f.project.id);assert.equal(e.acceptance_id,f.acceptance.id);assert.deepEqual(f.store.download(f.project.id,e.id).bytes,f.bytes);
  r.state(old.orderId!,'COMPLETED');await f.store.reconcile(old.id,r.adapter);assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get() as any).n,1);assert.equal(f.store.entitlement(f.project.id).payment_id,next.id);assert.equal(f.store.list('paymentincident',f.project.id).length,1);
  assert.equal(f.store.get<Payment>('payment',old.id).status,'PAID');assert.equal(f.store.view(f.project.id).payment?.id,next.id);assert.equal(r.posts.length,1);
 }finally{f.cleanup();}
});
