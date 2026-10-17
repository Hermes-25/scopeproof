import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unpack, analyzeBundle, hashBundle } from './bundle.ts';
import { amount, ProviderError, CaptureNotSubmittedError, CaptureHistoryUnverifiedError } from './payments.ts';
import type { Project, Scope, Artifact, Acceptance, Payment, Criterion, DraftExclusion, Adapter, Verified, RecoveryAuditInput } from './types.ts';
const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(join(directory,'bundles'),{recursive:true}); this.db=new DatabaseSync(join(directory,'scopeproof.db'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS confirmations(scope_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scope_confirmations(scope_id TEXT NOT NULL,role TEXT NOT NULL,project_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope_id,role));
      CREATE TABLE IF NOT EXISTS entitlements(id TEXT PRIMARY KEY,payment_id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL,acceptance_id TEXT NOT NULL,artifact_id TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL,capture_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_lifecycle(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS entitlement_acceptance_unique ON entitlements(acceptance_id);`);
    for (const row of this.db.prepare("SELECT body FROM records WHERE kind='payment'").all() as any[]) {
      let p=JSON.parse(row.body) as Payment;
      if(!p.financialSubmission) p=this.update('payment',{...p,financialSubmission:['UNKNOWN','CAPTURING','PAID'].includes(p.status)||(p.status==='FAILED'&&p.orderId)?'MAY_HAVE_SUBMITTED':'LEGACY_UNKNOWN'});
      if(['UNKNOWN','CAPTURING','PAID','CLOSED'].includes(p.status)||(p.status==='FAILED'&&p.orderId)) p=this.update('payment',{...p,recoveryBlocked:true});
      if(p.status==='CAPTURING') this.update('payment',{...p,status:'UNKNOWN',error:'The application restarted during capture. Check payment status before retrying.'});
      if(p.status==='FAILED'&&p.orderId)this.update('payment',{...p,status:'UNKNOWN',error:'A historical failure may have occurred after capture submission. Check provider status; another capture is disabled.'});
      if(p.status==='CREATING') this.update('payment',{...p,status:'CREATE_UNKNOWN',error:'The application restarted during order creation. Resume the same request.'});
    }
  }
  close() { this.db.close(); }
  get<T>(kind:string,id:string): T { const row=this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id) as any; if (!row) throw new Error(`${kind} not found.`); return JSON.parse(row.body); }
  list<T>(kind:string,projectId:string): T[] { return (this.db.prepare('SELECT body FROM records WHERE kind=? AND project_id=? ORDER BY rowid').all(kind,projectId) as any[]).map(row=>JSON.parse(row.body)); }
  insert(kind:string,value:any) { this.db.prepare('INSERT INTO records(kind,id,project_id,body) VALUES(?,?,?,?)').run(kind,value.id,value.projectId||value.id,JSON.stringify(value)); return value; }
  update(kind:string,value:any) { this.db.prepare('UPDATE records SET body=? WHERE kind=? AND id=?').run(JSON.stringify(value),kind,value.id); return value; }
  readProvider = (id:string) => { const row=this.db.prepare('SELECT body FROM provider WHERE id=?').get(id) as any; return row?JSON.parse(row.body):undefined; };
  writeProvider = (id:string,value:any) => { this.db.prepare('INSERT INTO provider(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id,JSON.stringify(value)); };
  createProject(input:any) {
    const title = String(input.title||'').trim(), brief=String(input.brief||'').trim();
    if (!title || title.length>120 || !brief || brief.length>10000) throw new Error('Provide a project name (up to 120 characters) and brief (up to 10,000).');
    return this.insert('project',{id:randomUUID(),title,brief,amount:amount(input.amount),currency:'USD',createdAt:now()} satisfies Project);
  }
  saveDraft(projectId:string,result:any) { const p=this.get<Project>('project',projectId); if(this.list('acceptance',projectId).length) throw new Error('An accepted scope cannot be replaced by AI.'); return this.insert('aidraft',{...result,id:randomUUID(),projectId,brief:p.brief,createdAt:now()}); }
  setScope(projectId:string,criteria:Criterion[],draftId?:string,excludedDraftRequirements:DraftExclusion[]=[]) {
    const project=this.get<Project>('project',projectId);
    if (this.list('acceptance',projectId).length) throw new Error('This project already has an accepted agreement. Create a new project to change its scope.');
    if (!Array.isArray(criteria)||criteria.length<1||criteria.length>12||criteria.some(c=>!c||!['TEXT','LINK','IMAGE','OVERFLOW','HUMAN_REVIEW'].includes(c.type)||typeof c.value!=='string'||(c.type!=='HUMAN_REVIEW'&&!c.value.trim())||c.value.length>400||typeof c.label!=='string'||!c.label.trim()||c.label.length>140)) throw new Error('Provide 1–12 requirements with a supported check, label and explicit objective value.');
    const draft=draftId?this.get<any>('aidraft',draftId):undefined;
    if(draft&&(draft.projectId!==projectId||draft.brief!==project.brief)) throw new Error('AI draft does not belong to this brief.');
    if(!Array.isArray(excludedDraftRequirements)||excludedDraftRequirements.length>12||(!draft&&excludedDraftRequirements.length))throw new Error('Draft exclusions must belong to the selected AI draft.');
    const exclusions:DraftExclusion[]=excludedDraftRequirements.map(e=>{
      if(!e||typeof e.index!=='number'||!Number.isInteger(e.index)||!draft||e.index<0||e.index>=draft.requirements.length||typeof e.reason!=='string'||!e.reason.trim()||e.reason.length>1000)throw new Error('Explain each removed AI requirement, using its original numeric index.');
      const row=draft.requirements[e.index];return {index:e.index,reason:e.reason.trim(),sourceQuote:row.sourceQuote,label:row.label};
    });
    if(draft){
      const retained=criteria.filter(c=>c.draftRequirementIndex!==undefined);
      const indices=[...retained.map(c=>c.draftRequirementIndex!),...exclusions.map(e=>e.index)];
      if(indices.some(i=>typeof i!=='number'||!Number.isInteger(i)||i<0||i>=draft.requirements.length)||indices.length!==draft.requirements.length||new Set(indices).size!==indices.length)throw new Error('Review every AI requirement or record its removal reason before saving the corrected checklist.');
    }else if(criteria.some(c=>c.draftRequirementIndex!==undefined))throw new Error('Select the original AI draft for source-linked requirements.');
    const clean=criteria.map(c=>{
      const source=draft&&c.draftRequirementIndex!==undefined?draft.requirements[c.draftRequirementIndex]:undefined;
      const quote=source?.sourceQuote??c.sourceQuote;
      if(quote!==undefined&&(typeof quote!=='string'||!quote||!project.brief.includes(quote))) throw new Error('Requirement quotation must appear exactly in the original brief.');
      const resolution=String(c.resolution||'').trim();if(resolution.length>2000)throw new Error('Keep each clarification under 2,000 characters.');
      if(c.type==='HUMAN_REVIEW'&&!c.value.trim()&&!resolution)throw new Error('Describe the agreed human-review expectation or record its clarification.');
      if(source&&(source.value===null||source.ambiguities.length)&&!resolution)throw new Error('Answer each AI ambiguity explicitly before agreeing on the scope.');
      if(c.type==='LINK'&&!/^(https?:\/\/|mailto:|tel:|\/(?!\/)|\.\.?\/|#)/i.test(c.value.trim()))throw new Error('Use a safe absolute or relative link destination, such as /reserve.');
      if(c.type==='OVERFLOW'){const width=Number(c.value);if(!Number.isInteger(width)||width<320||width>1440)throw new Error('Layout check width must be 320–1440 CSS pixels.');}
      if(c.type==='IMAGE'&&(!/^[a-zA-Z0-9_./-]+\.(png|jpe?g|gif|webp)$/i.test(c.value)||c.value.includes('..')))throw new Error('Name a relative PNG, JPEG, GIF or WebP asset.');
      return {id:c.id&&/^[a-zA-Z0-9_-]{1,80}$/.test(c.id)?c.id:randomUUID(),type:c.type,label:c.label.trim(),value:c.value.trim(),sourceQuote:quote,sourceStart:source?.sourceStart,sourceEnd:source?.sourceEnd,ambiguities:source?.ambiguities||[],resolution,humanReviewRequired:c.type==='HUMAN_REVIEW'||!!source?.humanReviewRequired||!!c.humanReviewRequired,draftRequirementIndex:source?c.draftRequirementIndex:undefined} satisfies Criterion;
    });
    if(new Set(clean.map(c=>c.id)).size!==clean.length)throw new Error('Each requirement must have a unique identifier.');
    const scope=this.insert('scope',{id:randomUUID(),projectId,version:this.list('scope',projectId).length+1,criteria:clean,agreementVersion:2,draftId,excludedDraftRequirements:exclusions,createdAt:now()} satisfies Scope);
    this.update('project',{...project,scopeId:scope.id}); return scope;
  }
  confirm(projectId:string,expectedScopeId:string,role:'seller'|'client'='client') { const p=this.get<Project>('project',projectId); if(!p.scopeId) throw new Error('Seller must save the criteria first.'); if(!expectedScopeId||expectedScopeId!==p.scopeId) throw new Error('The scope changed since you reviewed it. Refresh and confirm the new scope explicitly.'); if(!['seller','client'].includes(role))throw new Error('Unknown confirming role.');this.db.prepare('INSERT OR IGNORE INTO scope_confirmations(scope_id,role,project_id,created_at) VALUES(?,?,?,?)').run(expectedScopeId,role,projectId,now());if(role==='client')this.db.prepare('INSERT OR IGNORE INTO confirmations(scope_id,project_id,created_at) VALUES(?,?,?)').run(expectedScopeId,projectId,now()); }
  async upload(projectId:string,bytes:Buffer) {
    const project=this.get<Project>('project',projectId); if(!project.scopeId) throw new Error('Save the scope before uploading a bundle.');
    const scope=this.get<Scope>('scope',project.scopeId), files=await unpack(bytes), hash=hashBundle(bytes), key=`${hash}.zip`;
    const checked=await analyzeBundle(files,scope.criteria);
    try { writeFileSync(join(this.directory,'bundles',key),bytes,{flag:'wx',mode:0o600}); } catch(error:any) { if(error.code!=='EEXIST') throw error; if(hashBundle(readFileSync(join(this.directory,'bundles',key)))!==hash) throw new Error('Private bundle integrity check failed.'); }
    return this.insert('artifact',{id:randomUUID(),projectId,scopeId:scope.id,version:this.list('artifact',projectId).length+1,hash,key,evidence:checked.evidence,preview:checked.preview,createdAt:now()} satisfies Artifact);
  }
  accept(projectId:string,input:any) {
    const project=this.get<Project>('project',projectId), artifact=this.get<Artifact>('artifact',String(input.artifactId||''));
    if(artifact.projectId!==projectId || artifact.scopeId!==project.scopeId) throw new Error('This artifact does not belong to the current project scope.');
    const existing=this.list<Acceptance>('acceptance',projectId)[0]; if(existing) { if(existing.artifactId===artifact.id) return existing; throw new Error('An exact version has already been accepted. The agreement cannot silently change.'); }
    if (!this.view(projectId).confirmed) throw new Error('Confirm the scope agreement on both sides before accepting delivery.');
    if(input.visualConfirmed!==true) throw new Error('Review the design and layout, then explicitly confirm your visual approval.');
    if(artifact.evidence.some(e=>e.status==='FAIL')) throw new Error('A required check failed. Request a revised bundle before acceptance.');
    const unmeasured=artifact.evidence.filter(e=>e.type!=='HUMAN_REVIEW'&&e.status==='REVIEW_REQUIRED').map(e=>e.criterionId||e.label);
    if(unmeasured.length&&input.unmeasuredConfirmed!==true)throw new Error('Explicitly acknowledge the objective checks that could not be measured before accepting this version.');
    const latest=this.list<Artifact>('artifact',projectId).at(-1); if(latest?.id!==artifact.id) throw new Error('A newer draft is available. Review it before accepting.');
    return this.insert('acceptance',{id:randomUUID(),projectId,scopeId:artifact.scopeId,artifactId:artifact.id,hash:artifact.hash,amount:project.amount,currency:project.currency,unmeasuredCriterionIds:unmeasured,createdAt:now()} satisfies Acceptance);
  }
  activePayment(projectId:string) { return this.list<Payment>('payment',projectId).at(-1); }
  assertActivePayment(paymentId:string) {
    const p=this.get<Payment>('payment',paymentId);
    if(p.retiredAt||this.activePayment(p.projectId)?.id!==p.id) throw new Error('This checkout was retired. Refresh to use the current attempt.');
    return p;
  }
  private lifecycle(paymentId:string,kind:string) { this.db.prepare('INSERT INTO payment_lifecycle(id,payment_id,kind,created_at) VALUES(?,?,?,?)').run(randomUUID(),paymentId,kind,now()); }
  private blockOtherAttempts(p:Payment,kind:string) {
    if(!this.list<any>('paymentincident',p.projectId).some(i=>i.paymentId===p.id&&i.kind===kind))this.insert('paymentincident',{id:randomUUID(),projectId:p.projectId,paymentId:p.id,kind,createdAt:now()});
    for(const other of this.list<Payment>('payment',p.projectId))if(other.id!==p.id&&other.status!=='PAID')this.update('payment',{...other,status:other.retiredAt?other.status:'UNKNOWN',recoveryBlocked:true,error:'A retained order unexpectedly reports financial history. Another charge is disabled; operator review is required.'});
  }
  paymentUpdate(p:Payment):Payment {
    const current=this.get<Payment>('payment',p.id);
    for(const field of ['projectId','acceptanceId','mode','createKey','captureKey','replacesAttemptId','createdAt'] as const) if(p[field]!==current[field]) throw new Error('Payment attempt identity cannot change.');
    if(current.orderId&&p.orderId!==current.orderId)throw new Error('Retained provider order cannot change.');
    if(current.status==='PAID'||current.retiredAt)return current;
    const blocked=!!(current.recoveryBlocked||p.recoveryBlocked),status=blocked&&['NEW','CREATING','CREATE_UNKNOWN','ORDER_CREATED','CANCELLED','FAILED'].includes(p.status)?'UNKNOWN':p.status;
    return this.update('payment',{...p,status,financialSubmission:current.financialSubmission==='MAY_HAVE_SUBMITTED'?'MAY_HAVE_SUBMITTED':current.financialSubmission==='LEGACY_UNKNOWN'?'LEGACY_UNKNOWN':p.financialSubmission,recoveryBlocked:blocked});
  }
  // Trusted server/operator import only. No HTTP client may provide this proof.
  registerRecoveryAudit(paymentId:string,input:RecoveryAuditInput) {
    const p=this.assertActivePayment(paymentId);
    if(p.mode!=='PAYPAL_SANDBOX'||!p.orderId||p.orderId!==input.expectedOrderId||!['ORDER_CREATED','CANCELLED'].includes(p.status)||p.recoveryBlocked||p.financialSubmission==='MAY_HAVE_SUBMITTED'||p.captureId||this.entitlement(p.projectId))throw new Error('This attempt is not eligible for an unsubmitted-checkout audit.');
    if(!['noFinancialSubmission','noBuyerApproval','noExternalMerchantActions','allRuntimesControlled','walletSeparateCapture'].every(k=>(input as any)[k]===true)||typeof input.operator!=='string'||!input.operator.trim()||input.operator.length>120||!Array.isArray(input.evidenceRefs)||!input.evidenceRefs.length||input.evidenceRefs.length>12||input.evidenceRefs.some(r=>typeof r!=='string'||!r.trim()||r.length>200))throw new Error('A bounded trusted audit must establish lifetime non-submission and exclusive runtime control.');
    const audit=this.insert('recoveryaudit',{id:randomUUID(),projectId:p.projectId,paymentId:p.id,acceptanceId:p.acceptanceId,orderId:p.orderId,operator:input.operator,evidenceRefs:input.evidenceRefs,createdAt:now(),kind:'UNSUBMITTED_SANDBOX_WALLET',...Object.fromEntries(['noFinancialSubmission','noBuyerApproval','noExternalMerchantActions','allRuntimesControlled','walletSeparateCapture'].map(k=>[k,true]))});
    this.lifecycle(p.id,'RECOVERY_AUDIT_REGISTERED'); return audit;
  }
  private recoveryAudit(p:Payment) { return this.list<any>('recoveryaudit',p.projectId).findLast(a=>a.paymentId===p.id&&a.acceptanceId===p.acceptanceId&&a.orderId===p.orderId&&a.kind==='UNSUBMITTED_SANDBOX_WALLET'); }
  recoveryEligible(paymentId:string) { const p=this.get<Payment>('payment',paymentId); return p.mode==='PAYPAL_SANDBOX'&&!!p.orderId&&this.activePayment(p.projectId)?.id===p.id&&!p.retiredAt&&!p.recoveryBlocked&&p.financialSubmission!=='MAY_HAVE_SUBMITTED'&&!p.captureId&&['ORDER_CREATED','CANCELLED'].includes(p.status)&&!this.entitlement(p.projectId)&&!!this.recoveryAudit(p); }
  async restartUnsubmitted(paymentId:string,adapter:Adapter) {
    const old=this.get<Payment>('payment',paymentId), active=this.activePayment(old.projectId);
    if(old.mode!==adapter.mode||!adapter.configured)throw new Error('Use the configured adapter for this payment attempt.');
    if(old.retiredAt) { if(active?.replacesAttemptId!==old.id)throw new Error('This retirement already has a later checkout. Refresh.'); return this.createPayment(old.projectId,adapter); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(!this.recoveryEligible(old.id))throw new Error('Restart requires a trusted audit proving no financial submission and control of all merchant runtimes.');
      const fresh=this.get<Payment>('payment',old.id),audit=this.recoveryAudit(fresh);
      this.update('payment',{...fresh,status:'RETIRED_UNSUBMITTED',retiredAt:now(),retirementAuditId:audit.id,error:'Unavailable checkout retired locally after trusted non-submission audit. This is not a provider void or expiry confirmation.'});
      this.lifecycle(old.id,'RETIRED_UNSUBMITTED');
      const successor=this.insert('payment',{id:randomUUID(),projectId:old.projectId,acceptanceId:old.acceptanceId,mode:old.mode,status:'NEW',financialSubmission:'NEVER_SUBMITTED',replacesAttemptId:old.id,createKey:randomUUID(),captureKey:randomUUID(),createdAt:now()} satisfies Payment);
      this.lifecycle(successor.id,'ATTEMPT_CREATED');this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK');throw error; }
    return this.createPayment(old.projectId,adapter);
  }
  async createPayment(projectId:string,adapter:Adapter) {
    if(!adapter.configured) throw new Error('PayPal sandbox is not configured. Follow README setup; no payment or delivery has occurred.');
    const a=this.list<Acceptance>('acceptance',projectId)[0]; if(!a) throw new Error('Accept an exact deliverable version before paying.');
    let p=this.activePayment(projectId);
    if(p && p.mode!==adapter.mode) throw new Error('This project belongs to a different payment mode. Start a new project.');
    if(p && !['NEW','CREATE_UNKNOWN','FAILED'].includes(p.status)) return p;
    if(this.entitlement(projectId)) { if(!p)throw new Error('Paid acceptance has no retained payment.');return p; }
    if(!p) { const added:Payment=this.insert('payment',{id:randomUUID(),projectId,acceptanceId:a.id,mode:adapter.mode,status:'NEW',financialSubmission:'NEVER_SUBMITTED',createKey:randomUUID(),captureKey:randomUUID(),createdAt:now()} satisfies Payment);p=added;this.lifecycle(added.id,'ATTEMPT_CREATED'); }
    if(!p)throw new Error('Payment attempt could not be established.');
    this.assertActivePayment(p.id);
    if(p.orderId) return p;
    // Create idempotency is documented for six hours by default. The original
    // attempt's creation time is a conservative lower bound for first use;
    // outside it, do not rotate the key or silently create another checkout.
    if(['CREATE_UNKNOWN','FAILED'].includes(p.status)) {
      const created=Date.parse(p.createdAt),age=Date.now()-created;
      if(!Number.isFinite(created)||age<0||age>=6*60*60*1000)throw new Error('Order creation remains unresolved beyond the verified six-hour retry window. Keep this attempt and ask the operator to investigate; no replacement or key rotation was performed.');
    }
    p=this.paymentUpdate({...p,status:'CREATING',error:undefined});
    try { const result=await adapter.create(p,a); return this.paymentUpdate({...p,...result,status:'ORDER_CREATED'}); }
    catch(error) { return this.paymentUpdate({...p,status:error instanceof ProviderError&&error.definitive?'FAILED':'CREATE_UNKNOWN',error:(error as Error).message}); }
  }
  finish(p:Payment,a:Acceptance,result:Verified,eventId?:string) {
    if(!result.completed) return this.get<Payment>('payment',p.id);
    if(!result.captureId || result.orderId!==p.orderId || result.amount!==a.amount || result.currency!==a.currency || (p.mode==='PAYPAL_SANDBOX' && (result.orderId.startsWith('LOCAL-')||result.captureId.startsWith('LOCAL-')))) throw new Error('Payment does not match the accepted order. Delivery remains locked.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const paid=this.get<Payment>('payment',p.id);
      if(paid.status!=='PAID') {
        this.db.prepare('INSERT INTO events(id,payment_id,capture_id,created_at) VALUES(?,?,?,?)').run(eventId||`capture:${result.captureId}`,p.id,result.captureId,now());
        this.update('payment',{...paid,status:'PAID',captureId:result.captureId,financialSubmission:'MAY_HAVE_SUBMITTED',recoveryBlocked:true,error:undefined});
        this.lifecycle(p.id,'FINANCIAL_OUTCOME_VERIFIED');
        const existing=this.db.prepare('SELECT payment_id FROM entitlements WHERE acceptance_id=?').get(a.id) as any;
        if(!existing)this.db.prepare('INSERT INTO entitlements(id,payment_id,project_id,acceptance_id,artifact_id,hash) VALUES(?,?,?,?,?,?)').run(randomUUID(),p.id,p.projectId,a.id,a.artifactId,a.hash);
        if(paid.retiredAt||existing&&existing.payment_id!==p.id) {
          this.blockOtherAttempts(paid,'UNEXPECTED_RETAINED_ORDER_COMPLETION');
        }
      }
      this.db.exec('COMMIT'); return this.get<Payment>('payment',p.id);
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async capture(paymentId:string,adapter:Adapter) {
    let p=this.get<Payment>('payment',paymentId); const a=this.get<Acceptance>('acceptance',p.acceptanceId);
    if(p.mode!==adapter.mode) throw new Error('Payment adapter mismatch.');
    this.assertActivePayment(p.id);
    if(p.status==='PAID'||p.status==='CAPTURING'||p.status==='CLOSED') return p;
    if(p.status==='UNKNOWN'||p.financialSubmission==='MAY_HAVE_SUBMITTED'||p.recoveryBlocked||(p.status==='FAILED'&&p.orderId)) return this.reconcile(paymentId,adapter);
    if(!p.orderId) throw new Error('Resume order creation before capture.');
    if(!['ORDER_CREATED','CANCELLED'].includes(p.status)) throw new Error('This payment cannot be captured.');
    if(this.entitlement(p.projectId))throw new Error('This acceptance already has verified payment. Another charge is disabled.');
    p=this.paymentUpdate({...p,status:'CAPTURING',error:undefined});
    const beforeFinancialSubmit=()=>{
      const fresh=this.assertActivePayment(p.id);
      if(fresh.status!=='CAPTURING'||fresh.recoveryBlocked||fresh.financialSubmission==='MAY_HAVE_SUBMITTED'||this.entitlement(fresh.projectId))throw new Error('Financial submission is no longer authorized. Check the retained payment history.');
      this.db.exec('BEGIN IMMEDIATE');
      try{this.update('payment',{...fresh,financialSubmission:'MAY_HAVE_SUBMITTED',recoveryBlocked:true});this.lifecycle(p.id,'FINANCIAL_SUBMISSION_STARTED');this.db.exec('COMMIT');}
      catch(error){this.db.exec('ROLLBACK');throw error;}
    };
    try { const result=await adapter.capture(p,a,beforeFinancialSubmit); if(result.completed) return this.finish(p,a,result); if(result.terminal)return this.closePayment(p,result); const fresh=this.get<Payment>('payment',p.id); return this.paymentUpdate({...fresh,status:'UNKNOWN',financialSubmission:'MAY_HAVE_SUBMITTED',recoveryBlocked:true,error:`Confirmation pending (${result.state}). Check status; no further capture will be submitted for an unknown outcome.`}); }
    catch(error) {
      const fresh=this.get<Payment>('payment',p.id);
      // Do not overwrite a terminal/completed state established while awaiting
      // the provider. Only this still-active attempt may return to unsubmitted.
      if(fresh.status!=='CAPTURING')return fresh;
      const noSubmission=error instanceof CaptureNotSubmittedError&&fresh.financialSubmission!=='MAY_HAVE_SUBMITTED'&&!fresh.recoveryBlocked;
      this.lifecycle(p.id,noSubmission?'CAPTURE_NOT_SUBMITTED':'FINANCIAL_OUTCOME_UNCERTAIN');
      return this.paymentUpdate({...fresh,status:noSubmission?'ORDER_CREATED':'UNKNOWN',financialSubmission:noSubmission?fresh.financialSubmission:'MAY_HAVE_SUBMITTED',recoveryBlocked:!noSubmission,error:noSubmission?(error as Error).message:'Confirmation pending. '+(error as Error).message});
    }
  }
  closePayment(p:Payment,result:Verified) {
    const fresh=this.get<Payment>('payment',p.id);
    if(fresh.retiredAt&&result.captureId){this.lifecycle(p.id,'OBSERVED_FINANCIAL_HISTORY');this.blockOtherAttempts(fresh,'UNEXPECTED_RETAINED_FINANCIAL_HISTORY');return this.update('payment',{...fresh,financialSubmission:'MAY_HAVE_SUBMITTED',recoveryBlocked:true,captureId:result.captureId,error:'Retained order reports a negative capture result. Its financial history requires operator review.'});}
    return this.paymentUpdate({...fresh,status:'CLOSED',recoveryBlocked:true,financialSubmission:result.captureId?'MAY_HAVE_SUBMITTED':fresh.financialSubmission,captureId:result.captureId||p.captureId,error:`Provider reports ${result.state}. No completed payment was verified; delivery stays locked. Automatic retries and replacement orders are disabled. Ask the seller to inspect this order in the PayPal sandbox dashboard. Keep this record and check status again if the provider corrects it.`});
  }
  async reconcile(paymentId:string,adapter:Adapter,eventId?:string) {
    const p=this.get<Payment>('payment',paymentId), a=this.get<Acceptance>('acceptance',p.acceptanceId);
    if(p.mode!==adapter.mode) throw new Error('Payment adapter mismatch.'); if(p.status==='PAID') return p;
    if(!p.orderId) return p;
    try {
      const result=await adapter.status(p,a); if(result.completed) return this.finish(p,a,result,eventId);
      if(result.terminal)return this.closePayment(p,result);
      const fresh=this.get<Payment>('payment',p.id);
      if(result.captureId){this.lifecycle(p.id,'OBSERVED_FINANCIAL_HISTORY');if(fresh.retiredAt)this.blockOtherAttempts(fresh,'UNEXPECTED_RETAINED_FINANCIAL_HISTORY');return this.update('payment',{...fresh,status:fresh.retiredAt?fresh.status:'UNKNOWN',financialSubmission:'MAY_HAVE_SUBMITTED',recoveryBlocked:true,error:'Provider reports financial history. Only status retrieval is permitted.'});}
      return this.paymentUpdate({...fresh,error:`${fresh.status==='UNKNOWN'?'Confirmation pending. ':''}Provider status: ${result.state}. No completed payment has been verified.`});
    } catch(error) { const fresh=this.get<Payment>('payment',p.id); if(error instanceof CaptureHistoryUnverifiedError){this.lifecycle(p.id,'UNVERIFIED_FINANCIAL_HISTORY');if(fresh.retiredAt)this.blockOtherAttempts(fresh,'UNEXPECTED_RETAINED_FINANCIAL_HISTORY');return this.update('payment',{...fresh,status:fresh.retiredAt?fresh.status:'UNKNOWN',financialSubmission:'MAY_HAVE_SUBMITTED',recoveryBlocked:true,error:error.message});}return this.paymentUpdate({...fresh,error:(error as Error).message}); }
  }
  async webhook(adapter:Adapter,raw:string,headers:Record<string,unknown>) {
    const event=await adapter.verifyWebhook(raw,headers);
    const p=(this.db.prepare("SELECT body FROM records WHERE kind='payment'").all() as any[]).map(row=>JSON.parse(row.body) as Payment).find(p=>p.orderId===event.orderId && p.mode===adapter.mode);
    if(!p) throw new Error('Webhook order is not associated with this application.');
    return this.reconcile(p.id,adapter,event.eventId);
  }
  entitlement(projectId:string) { return this.db.prepare('SELECT * FROM entitlements WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(projectId) as any; }
  download(projectId:string,entitlementId:string) {
    const e=this.db.prepare('SELECT * FROM entitlements WHERE id=? AND project_id=?').get(entitlementId,projectId) as any;
    if(!e) throw new Error('No authorized delivery was found.');
    const p=this.get<Payment>('payment',e.payment_id),a=this.get<Acceptance>('acceptance',e.acceptance_id),artifact=this.get<Artifact>('artifact',e.artifact_id);
    if(p.status!=='PAID'||a.artifactId!==artifact.id||a.hash!==e.hash||artifact.hash!==e.hash) throw new Error('Delivery record integrity check failed.');
    const bytes=readFileSync(join(this.directory,'bundles',artifact.key)); if(hashBundle(bytes)!==e.hash) throw new Error('Bundle hash does not match the accepted version.');
    return {bytes,hash:e.hash,version:artifact.version};
  }
  view(projectId:string) {
    const project=this.get<Project>('project',projectId),scopes=this.list<Scope>('scope',projectId),artifacts=this.list<Artifact>('artifact',projectId),acceptance=this.list<Acceptance>('acceptance',projectId)[0],attempts=this.list<Payment>('payment',projectId),entitlement=this.entitlement(projectId),payment=entitlement?attempts.find(p=>p.id===entitlement.payment_id):attempts.at(-1);
    const scope=scopes.find(s=>s.id===project.scopeId),legacyConfirmed=!!(project.scopeId&&this.db.prepare('SELECT scope_id FROM confirmations WHERE scope_id=?').get(project.scopeId));
    const confirmations=project.scopeId?this.db.prepare('SELECT role FROM scope_confirmations WHERE scope_id=? AND project_id=?').all(project.scopeId,projectId) as {role:string}[]:[];
    const sellerConfirmed=confirmations.some(c=>c.role==='seller')||!!(scope&&!scope.agreementVersion),clientConfirmed=confirmations.some(c=>c.role==='client')||!!(scope&&!scope.agreementVersion&&legacyConfirmed);
    const latest=artifacts.at(-1)?.id;
    return {project,scope,sellerConfirmed,clientConfirmed,confirmed:sellerConfirmed&&clientConfirmed,aiDraft:this.list<any>('aidraft',projectId).at(-1),artifacts:artifacts.map(({key,...a})=>({...a,preview:a.id===latest||a.id===acceptance?.artifactId?a.preview:''})),acceptance,payment,recoveryEligible:!!payment&&this.recoveryEligible(payment.id),paymentAttempts:attempts.map(p=>({id:p.id,status:p.status,orderId:p.orderId,createdAt:p.createdAt,replacesAttemptId:p.replacesAttemptId,retiredAt:p.retiredAt})),entitled:!!entitlement};
  }
}
