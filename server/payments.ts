import type { Adapter, Payment, Acceptance, Verified } from './types.ts';
export function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,5}(\.\d{1,2})?$/.test(value)) throw new Error('Enter a USD amount from 0.01 to 10,000.00, using at most two decimal places.');
  const [whole, fraction = ''] = value.split('.'); const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 1000000n) throw new Error('Amount must be from 0.01 to 10,000.00 USD.');
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}
export class ProviderError extends Error { constructor(message: string, public definitive = false) { super(message); } }
// This phase is asserted only by trusted adapter paths that failed before the
// capture POST was invoked. An HTTP status or generic definitive error is not
// evidence that a financial request was never submitted.
export class CaptureNotSubmittedError extends ProviderError {
  readonly capturePhase = 'NOT_SUBMITTED' as const;
  constructor(message: string) { super(message); }
}
// Unverifiable capture evidence may describe a financial operation performed
// elsewhere. The absence of a POST in this call cannot make that history safe
// to retry; keep the retained order retrieval-only until completion is verified.
export class CaptureHistoryUnverifiedError extends ProviderError {}
async function readProviderJson(response:Response) {
  if(!response.body)throw new ProviderError('PayPal returned no response body. Check payment status.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256*1024){await reader.cancel().catch(()=>{});throw new ProviderError('PayPal response exceeded the allowed size. Check payment status.');}chunks.push(value);}}
  finally{reader.releaseLock();}
  try{const data:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error('shape');return data as Record<string,any>;}
  catch{throw new ProviderError('PayPal returned an invalid response. Check payment status.');}
}
export class PayPalAdapter implements Adapter {
  mode = 'PAYPAL_SANDBOX' as const;
  private token?: { value: string; expires: number };
  constructor(private config: {clientId?: string; secret?: string; merchantId?: string; webhookId?: string; publicUrl: string; diagnostic?: (event: Record<string, string | number>) => void}, private fetcher: typeof fetch = fetch) {}
  get configured() { return !!(this.config.clientId && this.config.secret && this.config.merchantId); }
  private async request(path: string, method = 'GET', body?: unknown, key?: string, basic = false, beforeFinancialSubmit?: () => void) {
    if (!this.configured) throw new ProviderError('PayPal sandbox is not configured. Add the seller credentials and merchant ID to .env, then restart.', true);
    const headers: Record<string,string> = { 'Content-Type':'application/json', Prefer:'return=representation' };
    if (basic) { headers.Authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.secret}`).toString('base64')}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else {
      try {
        if (!this.token || this.token.expires < Date.now()) { const t = await this.request('/v1/oauth2/token', 'POST', 'grant_type=client_credentials', undefined, true);if(typeof t.access_token!=='string'||!t.access_token||typeof t.expires_in!=='number'||!Number.isFinite(t.expires_in)||t.expires_in<=0||t.expires_in>604800)throw new ProviderError('PayPal authentication response could not be verified. Check setup and payment status.'); this.token = {value:t.access_token, expires:Date.now()+Math.max(0,t.expires_in-60)*1000}; }
      } catch (error) {
        // Authentication for this request failed before its fetcher was invoked.
        // OAuth POST is not a financial capture POST, even after a status GET.
        if (method === 'POST' && path.endsWith('/capture')) throw new CaptureNotSubmittedError((error as Error).message);
        throw error;
      }
      headers.Authorization = `Bearer ${this.token.value}`;
    }
    if (key) headers['PayPal-Request-Id'] = key;
    // Store must persist admission before a financial fetch can be invoked.
    // The callback is deliberately outside the network catch: a failed guard
    // must stop submission rather than be classified as provider uncertainty.
    if (method === 'POST' && path.endsWith('/capture')) beforeFinancialSubmit?.();
    let response: Response;
    try { response = await this.fetcher(`https://api-m.sandbox.paypal.com${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(12000) }); }
    catch { this.diagnostic(path,0,'NETWORK_OR_TIMEOUT'); throw new ProviderError('PayPal response is unknown. Check payment status before trying another charge.'); }
    let data:Record<string,any>;
    try{data=await readProviderJson(response);}catch(error){this.diagnostic(path,response.status,'INVALID_OR_OVERSIZED_RESPONSE');throw error instanceof ProviderError?error:new ProviderError('PayPal response could not be confirmed. Check payment status.');}
    // An HTTP error does not prove that a capture was never submitted or settled.
    // Never expose provider-controlled messages; diagnostics contain bounded enums only.
    if (!response.ok) { this.diagnostic(path,response.status,'HTTP_ERROR',data); throw new ProviderError(`PayPal request could not be verified (HTTP ${response.status}). Check configuration or payment status.`); }
    return data;
  }
  private diagnostic(path:string,httpStatus:number,category:string,data?:any) {
    const issue=data?.details?.[0]?.issue, allowed=['ORDER_ALREADY_CAPTURED','ORDER_NOT_APPROVED','INSTRUMENT_DECLINED','DUPLICATE_INVOICE_ID','INVALID_PARAMETER_VALUE','PERMISSION_DENIED'];
    const event={provider:'PAYPAL',operation:path==='/v1/oauth2/token'?'TOKEN':path.endsWith('/capture')?'CAPTURE':path==='/v2/checkout/orders'?'CREATE':path.includes('webhook')?'WEBHOOK':'STATUS',httpStatus,category,code:allowed.includes(issue)?issue:'UNSPECIFIED'};
    try {(this.config.diagnostic||((e)=>console.warn(JSON.stringify(e))))(event);}catch{/* Diagnostics cannot change a financial outcome. */}
  }
  async create(p: Payment, a: Acceptance) {
    const data = await this.request('/v2/checkout/orders', 'POST', { intent:'CAPTURE', purchase_units:[{ reference_id:p.id, custom_id:a.id, invoice_id:p.id, payee:{merchant_id:this.config.merchantId}, amount:{value:a.amount,currency_code:a.currency}, description:'Accepted static website deliverable' }], payment_source:{paypal:{experience_context:{shipping_preference:'NO_SHIPPING',user_action:'PAY_NOW', return_url:`${this.config.publicUrl}/?payment=${p.id}&paypalReturn=1`, cancel_url:`${this.config.publicUrl}/?payment=${p.id}&paypalCancel=1`}}} }, p.createKey);
    const url = data.links?.find((l: any) => ['payer-action','approve'].includes(l.rel))?.href;
    if (!data.id || !url || new URL(url).hostname !== 'www.sandbox.paypal.com' || new URL(url).protocol!=='https:' || new URL(url).username || new URL(url).password) throw new ProviderError('PayPal returned no valid sandbox approval link. Reconcile this order.');
    return {orderId:data.id, approvalUrl:url};
  }
  async status(p: Payment, a: Acceptance): Promise<Verified> {
    if (!p.orderId) throw new ProviderError('Order creation is still unresolved. Resume the same payment request.');
    const data = await this.request(`/v2/checkout/orders/${encodeURIComponent(p.orderId)}`);
    const unit = data.purchase_units?.length === 1 ? data.purchase_units[0] : null;
    // A mismatched binding must not hide financial evidence in this or another
    // returned unit. Later empty history cannot establish that evidence vanished.
    const observedFinancialHistory = !['CREATED','SAVED','APPROVED','PAYER_ACTION_REQUIRED','VOIDED'].includes(data.status) ||
      !Array.isArray(data.purchase_units) || data.purchase_units.some((returned: any) => {
        if (!returned || typeof returned !== 'object') return true;
        const payments = returned.payments;
        if (payments === undefined) return false;
        if (!payments || typeof payments !== 'object' || Array.isArray(payments)) return true;
        const captures = payments.captures;
        return captures !== undefined && (!Array.isArray(captures) || captures.length > 0);
      });
    let unitAmountMatches = false;
    try { unitAmountMatches = amount(unit?.amount?.value) === a.amount; } catch { /* Classify together with any observed financial history. */ }
    if (data.id !== p.orderId || !unit || unit.custom_id !== a.id || unit.invoice_id !== p.id || unit.amount?.currency_code !== a.currency || !unitAmountMatches || unit.payee?.merchant_id !== this.config.merchantId) {
      const message = 'Payment verification failed: order, seller or agreed amount does not match. Source stays locked.';
      if (observedFinancialHistory) throw new CaptureHistoryUnverifiedError(message);
      throw new ProviderError(message);
    }
    if (unit.payments !== undefined && (!unit.payments || typeof unit.payments !== 'object' || Array.isArray(unit.payments))) throw new CaptureHistoryUnverifiedError('Malformed payment history. Source stays locked for review.');
    // Omitted captures may mean no capture history; an explicit null is an
    // unverified history value and must not be silently normalized to empty.
    const captures = unit.payments?.captures === undefined ? [] : unit.payments.captures;
    if (!Array.isArray(captures) || captures.length > 1) throw new CaptureHistoryUnverifiedError('Unexpected capture history. Source stays locked for review.');
    const capture = captures[0];
    if (capture !== undefined) {
      let captureAmountMatches = false;
      try { captureAmountMatches = amount(capture?.amount?.value) === a.amount; } catch { /* Invalid amount is unverified capture history, not a pre-submit failure. */ }
      if (!capture || typeof capture.id!=='string' || !capture.id || !['COMPLETED','DECLINED','PENDING','FAILED','REFUNDED','PARTIALLY_REFUNDED'].includes(capture.status) || capture.amount?.currency_code !== a.currency || !captureAmountMatches || capture.final_capture !== true) throw new CaptureHistoryUnverifiedError('Capture history could not be verified. Source stays locked.');
      return {completed:capture.status==='COMPLETED',captureId:capture.id,orderId:data.id,amount:a.amount,currency:a.currency,merchantId:unit.payee.merchant_id,state:capture.status,terminal:['DECLINED','FAILED'].includes(capture.status)};
    }
    if (!['CREATED','SAVED','APPROVED','PAYER_ACTION_REQUIRED','VOIDED'].includes(data.status)) throw new CaptureHistoryUnverifiedError('Unrecognized order state or missing capture history. Check payment status; source stays locked.');
    return {completed:false, orderId:data.id,state:data.status,terminal:data.status==='VOIDED'};
  }
  async capture(p: Payment, a: Acceptance, beforeFinancialSubmit?: () => void) {
    let before: Verified;
    try { before = await this.status(p,a); }
    catch (error) {
      if (error instanceof CaptureHistoryUnverifiedError) throw error;
      // No financial POST has occurred in this attempt: failed retrieval,
      // authentication or agreement validation can be revalidated next time.
      throw new CaptureNotSubmittedError((error as Error).message);
    }
    if (before.completed || before.terminal) return before;
    if (before.state !== 'APPROVED') {
      const message = 'Approve this order in PayPal before capture. If payment is pending, check its status.';
      if (['CREATED','SAVED','PAYER_ACTION_REQUIRED'].includes(before.state)) throw new CaptureNotSubmittedError(message);
      // An existing pending capture is financial evidence; retain UNKNOWN.
      throw new ProviderError(message);
    }
    // Errors from this POST or the subsequent GET remain submission-unknown.
    await this.request(`/v2/checkout/orders/${encodeURIComponent(p.orderId!)}/capture`,'POST',{},p.captureKey,false,beforeFinancialSubmit);
    return this.status(p,a);
  }
  async verifyWebhook(raw: string, headers: Record<string, unknown>) {
    if (!this.config.webhookId) throw new ProviderError('Webhook ID is not configured.', true);
    const event = JSON.parse(raw);
    const data = await this.request('/v1/notifications/verify-webhook-signature','POST',{auth_algo:headers['paypal-auth-algo'],cert_url:headers['paypal-cert-url'],transmission_id:headers['paypal-transmission-id'],transmission_sig:headers['paypal-transmission-sig'],transmission_time:headers['paypal-transmission-time'],webhook_id:this.config.webhookId,webhook_event:event});
    if (data.verification_status !== 'SUCCESS' || event.event_type !== 'PAYMENT.CAPTURE.COMPLETED' || !event.id || !event.resource?.supplementary_data?.related_ids?.order_id) throw new ProviderError('Webhook verification failed or event is unsupported.', true);
    return {eventId:event.id,orderId:event.resource.supplementary_data.related_ids.order_id};
  }
}
export class LocalAdapter implements Adapter {
  mode = 'LOCAL_TEST' as const; configured = true;
  constructor(private read: (key: string) => any, private write: (key: string,value: any) => void) {}
  async create(p: Payment,a: Acceptance) { const orderId=`LOCAL-${p.id}`; if (!this.read(orderId)) this.write(orderId,{approved:false,completed:false,amount:a.amount,currency:a.currency}); return {orderId}; }
  approve(p: Payment) { const value = this.read(p.orderId!); if (!value) throw new Error('Local test order not found.'); this.write(p.orderId!, {...value,approved:true}); }
  async capture(p: Payment,a: Acceptance,beforeFinancialSubmit?:()=>void) { const state=this.read(p.orderId!); if (!state?.approved) throw new CaptureNotSubmittedError('Approve the local test order first.'); beforeFinancialSubmit?.(); this.write(p.orderId!,{...state,completed:true}); return this.status(p,a); }
  async status(p: Payment,_a: Acceptance): Promise<Verified> { const state=this.read(p.orderId!); if (!state) throw new ProviderError('Local test order not found.',true); return {completed:!!state.completed, captureId:state.completed?`LOCAL-CAPTURE-${p.id}`:undefined, orderId:p.orderId!,amount:state.amount,currency:state.currency,merchantId:'LOCAL-TEST-MERCHANT',state:state.completed?'COMPLETED':state.approved?'APPROVED':'CREATED'}; }
  async verifyWebhook(_raw: string,_headers: Record<string,unknown>): Promise<{eventId:string;orderId:string}> { throw new Error('LOCAL_TEST has no PayPal webhook endpoint.'); }
}
