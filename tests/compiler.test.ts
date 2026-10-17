import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BriefCompiler, CompilerError, GEMINI_MODEL, compilerSchema, validateCompiledRequirements, type CompilerDiagnostic } from '../server/compiler.ts';

type Fixture = {id: string; brief: string; expected: {types: string[]; unresolved: number}; reviewedDraft: {requirements: unknown[]}};
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('../fixtures/briefs.json', import.meta.url), 'utf8'));
const result = (draft: unknown, extra = {}) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(draft) }] }], ...extra });
const mock = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
const row = (sourceQuote: string, type: string, value: string | null, ambiguities: string[] = []) => ({sourceQuote, label: 'Draft requirement', type, value, ambiguities, humanReviewRequired: false});
const geminiResult = (draft: unknown) => ({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:JSON.stringify(draft)}]}}]});

test('literal-extraction prompt preserves Unicode schedule, URL and separate asset quotation in one mocked Gemini request',async()=>{
  const brief='One landing page for Juniper Bakery. Include Tuesday–Sunday, 8am–4pm, our logo, and a booking button linking to https://example.com/book. Logo file: logo.png. No horizontal overflow at 390px. Review the visual design together before payment.';
  const expected=[row('Tuesday–Sunday','TEXT','Tuesday–Sunday'),row('8am–4pm','TEXT','8am–4pm'),row('linking to https://example.com/book','LINK','https://example.com/book'),row('Logo file: logo.png','IMAGE','logo.png'),row('No horizontal overflow at 390px','OVERFLOW','390')];let calls=0;
  const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',diagnostic:()=>{},fetchImpl:async(_url,options)=>{
    calls++;const body=JSON.parse(String(options?.body)),instructions=body.systemInstruction.parts[0].text;
    assert.equal(JSON.parse(body.contents[0].parts[0].text).brief,brief);
    assert.match(instructions,/preserving Unicode punctuation, case and whitespace/);
    assert.match(instructions,/never replace the en dash with a hyphen/);
    assert.match(instructions,/Never canonicalize a URL, append a slash, or change a filename\/path/);
    assert.match(instructions,/within its own sourceQuote, not just somewhere else/);
    assert.match(instructions,/never bind a value from another sentence to a narrower request quotation/);
    assert.match(instructions,/Asset file: mark\.webp/);
    assert.match(instructions,/If you cannot identify an exact supported literal, keep value null/);
    return Response.json(geminiResult({requirements:expected}));
  }});
  const draft=await compiler.compileBrief(brief);assert.equal(calls,1);
  assert.deepEqual(draft.requirements.map(r=>r.value),expected.map(r=>r.value));
  for(const r of draft.requirements){assert.equal(brief.slice(r.sourceStart,r.sourceEnd),r.sourceQuote);assert.ok(r.sourceQuote.includes(r.value!));}
});

test('altered Unicode values, constructed hours, canonicalized URL and misplaced image path reject without retry or salvage',async()=>{
  const brief='Include Tuesday–Sunday, 8am–4pm, our logo. Link to https://example.com/book. Logo file: logo.png.';
  for(const malformed of [row('Tuesday–Sunday','TEXT','Tuesday-Sunday'),row('8am–4pm','TEXT','8am-4pm'),row('8am–4pm','TEXT','08:00–16:00'),row('Tuesday–Sunday, 8am–4pm','TEXT','Opening hours: Tuesday–Sunday, 8am–4pm'),row('Link to https://example.com/book','LINK','https://example.com/book/'),row('our logo','IMAGE','logo.png')]){
    let calls=0;const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',diagnostic:()=>{},fetchImpl:async()=>{calls++;return Response.json(geminiResult({requirements:[row('Tuesday–Sunday','TEXT','Tuesday–Sunday'),{...malformed,ambiguities:['Please confirm the exact literal.']}]}));}});
    await assert.rejects(compiler.compileBrief(brief),(e:unknown)=>e instanceof CompilerError&&e.code==='INVALID_OUTPUT'&&e.message.includes('invented rather than quoted'));
    assert.equal(calls,1,'Reject the whole draft; never repair an ungrounded original value.');
  }
});

test('uncertain Unicode schedule extraction stays null with exact quote and question',async()=>{
  const brief='Include Tuesday–Sunday, 8am–4pm.';const question='What exact visible schedule text should be used?';let calls=0;
  const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',diagnostic:()=>{},fetchImpl:async()=>{calls++;return Response.json(geminiResult({requirements:[row('Tuesday–Sunday, 8am–4pm','TEXT',null,[question])]}));}});
  const [draft]=(await compiler.compileBrief(brief)).requirements;assert.equal(calls,1);assert.equal(draft.value,null);assert.equal(draft.humanReviewRequired,true);assert.equal(draft.sourceQuote,'Tuesday–Sunday, 8am–4pm');assert.deepEqual(draft.ambiguities,[question]);assert.equal(brief.slice(draft.sourceStart,draft.sourceEnd),draft.sourceQuote);
});

for(const fixture of fixtures)test(`Gemini reviewed fixture: ${fixture.id} (mock provider, not live AI)`,async()=>{
  const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',diagnostic:()=>{},fetchImpl:mock(geminiResult(fixture.reviewedDraft))});
  const draft=await compiler.compileBrief(fixture.brief);
  assert.equal(draft.provider,'GEMINI');assert.equal(draft.model,GEMINI_MODEL);
  assert.deepEqual(draft.requirements.map(r=>r.type),fixture.expected.types);
  assert.equal(draft.requirements.filter(r=>r.value===null).length,fixture.expected.unresolved);
  for(const requirement of draft.requirements)assert.equal(fixture.brief.slice(requirement.sourceStart,requirement.sourceEnd),requirement.sourceQuote);
});

test('Gemini sends one fixed native request with schema, bounded output, header key and no fallback',async()=>{
  const secret='NATIVE_HEADER_KEY_ONLY';let calls=0;
  const compiler=new BriefCompiler({provider:'GEMINI',apiKey:secret,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');assert.ok(!String(url).includes(secret));
    const headers=new Headers(options?.headers);assert.equal(headers.get('x-goog-api-key'),secret);assert.equal(headers.get('Authorization'),null);
    assert.equal(options?.redirect,'error');assert.ok(options?.signal instanceof AbortSignal);
    const body=JSON.parse(String(options?.body));assert.deepEqual(body.generationConfig,{candidateCount:1,maxOutputTokens:4000,responseMimeType:'application/json',responseJsonSchema:compilerSchema});
    assert.equal(body.tools,undefined);assert.equal(body.model,undefined);assert.equal(body.contents[0].role,'user');assert.deepEqual(JSON.parse(body.contents[0].parts[0].text),{brief:'Show Hello.'});
    assert.match(body.systemInstruction.parts[0].text,/untrusted brief DATA/);assert.ok(!String(options?.body).includes(secret));
    return Response.json(geminiResult({requirements:[row('Show Hello.','TEXT','Hello')]}));
  }});
  assert.equal((await compiler.compileBrief('Show Hello.')).requirements[0].value,'Hello');assert.equal(calls,1);
});

test('native Gemini schema request uses JSON Schema fields and omits incompatible ResponseFormat',async()=>{
  let calls=0;
  const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',diagnostic:()=>{},fetchImpl:async(_url,options)=>{
    calls++;const config=JSON.parse(String(options?.body)).generationConfig;
    // Controlled compatibility regression; this is not evidence of a live provider acceptance.
    if(config.responseFormat!==undefined||config.responseSchema!==undefined)return new Response(JSON.stringify({error:{status:'INVALID_ARGUMENT'}}),{status:400});
    assert.equal(config.responseMimeType,'application/json');assert.deepEqual(config.responseJsonSchema,compilerSchema);
    assert.deepEqual(config.responseJsonSchema.properties.requirements.items.properties.value.type,['string','null']);
    return Response.json(geminiResult({requirements:[row('Booking button.','LINK',null,['What destination should the booking link use?'])]}));
  }});
  const draft=await compiler.compileBrief('Booking button.');assert.equal(draft.requirements[0].value,null);assert.equal(draft.requirements[0].humanReviewRequired,true);assert.equal(calls,1);
});

test('mobile layout prompt explicitly requests a nullable viewport proposal without fabricating agreement',async()=>{
  const brief='Make this page mobile friendly and premium.';let calls=0;
  const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',fetchImpl:async(_url,options)=>{
    calls++;const instructions=JSON.parse(String(options?.body)).systemInstruction.parts[0].text;
    assert.match(instructions,/mobile-friendly or responsive page\/layout/);
    assert.match(instructions,/ALWAYS include a proposed OVERFLOW requirement/);
    assert.match(instructions,/set value to null/);assert.match(instructions,/Which CSS pixel viewport width/);
    assert.match(instructions,/Never supply a default width/);assert.match(instructions,/not full mobile usability/);
    assert.match(instructions,/separate HUMAN_REVIEW requirements/);assert.match(instructions,/confirm this proposed narrow criterion/);
    return Response.json(geminiResult({requirements:[row('mobile friendly','OVERFLOW',null,['Which CSS pixel viewport width should be checked, and should no horizontal overflow be the agreed criterion?']),row('premium','HUMAN_REVIEW',null,['What visual reference should be agreed?'])]}));
  }});
  const draft=await compiler.compileBrief(brief);assert.equal(calls,1);
  assert.deepEqual(draft.requirements.map(r=>[r.type,r.value,r.sourceQuote]),[['OVERFLOW',null,'mobile friendly'],['HUMAN_REVIEW',null,'premium']]);
  assert.ok(draft.requirements.every(r=>r.humanReviewRequired));
  // Semantic coverage remains a live-evaluation gate; the mechanical validator does not fabricate a missing row.
  const generic=validateCompiledRequirements(brief,{requirements:[row('mobile friendly','HUMAN_REVIEW',null,['How should mobile friendliness be reviewed?'])]});
  assert.equal(generic.length,1);assert.equal(generic[0].type,'HUMAN_REVIEW');assert.equal(generic[0].value,null);
});

test('Gemini configuration rejects alternate models and missing keys before any request',async()=>{
  let calls=0;const fetchImpl:typeof fetch=async()=>{calls++;throw new Error('unexpected');};
  for(const model of ['gemini-2.5-flash-lite','gemini-3.8-flash','https://untrusted.test/','../paid-model'])assert.throws(()=>new BriefCompiler({provider:'GEMINI',model,apiKey:'test',fetchImpl}),CompilerError);
  const compiler=new BriefCompiler({provider:'GEMINI',fetchImpl});assert.equal(compiler.provider,'GEMINI');assert.equal(compiler.configured,false);
  await assert.rejects(compiler.compileBrief('Show Hello.'),(error:unknown)=>error instanceof CompilerError&&error.code==='UNCONFIGURED');assert.equal(calls,0);
});

test('Gemini refusals, truncation, missing finish status, multiple candidates and tools yield no draft',async()=>{
  const valid=geminiResult({requirements:[row('Show Hello.','TEXT','Hello')]});
  const scenarios:[unknown,CompilerError['code']][]=[
    [{promptFeedback:{blockReason:'SAFETY'},candidates:[]},'REFUSED'],
    [{candidates:[{...valid.candidates[0],finishReason:'SAFETY'}]},'REFUSED'],
    [{candidates:[{...valid.candidates[0],finishReason:'MAX_TOKENS'}]},'UNAVAILABLE'],
    [{candidates:[{content:valid.candidates[0].content}]},'UNAVAILABLE'],
    [{candidates:[valid.candidates[0],valid.candidates[0]]},'INVALID_OUTPUT'],
    [{candidates:[{...valid.candidates[0],content:{role:'model',parts:[{functionCall:{name:'approvePayment'}}]}}]},'INVALID_OUTPUT'],
    [{candidates:[{...valid.candidates[0],content:{role:'model',parts:[{text:JSON.stringify({requirements:[row('Show Hello.','TEXT','Hello')]}),functionCall:{name:'approvePayment'}}]}}]},'INVALID_OUTPUT'],
  ];
  for(const [body,code] of scenarios){let calls=0;const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test',diagnostic:()=>{},fetchImpl:async()=>{calls++;return Response.json(body);}});
    await assert.rejects(compiler.compileBrief('Show Hello.'),(error:unknown)=>error instanceof CompilerError&&error.code===code);assert.equal(calls,1);
  }
});

test('Gemini malformed and ungrounded JSON reject whole draft without repair requests',async()=>{
  const bodies=[{candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:'{broken'}]}}]},geminiResult({requirements:[row('Show Hello.','TEXT','Hello'),row('mobile friendly','OVERFLOW','390')]})];
  for(const body of bodies){let calls=0;const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test',diagnostic:()=>{},fetchImpl:async()=>{calls++;return Response.json(body);}});
    await assert.rejects(compiler.compileBrief('Show Hello. Make it mobile friendly.'),(error:unknown)=>error instanceof CompilerError&&error.code==='INVALID_OUTPUT');assert.equal(calls,1);
  }
});

test('Gemini quota and error diagnostics omit secrets and never retry or invoke OpenAI',async()=>{
  const secret='PRIVATE_KEY_BRIEF_PROVIDER_ERROR';
  for(const scenario of [{status:429,code:'RESOURCE_EXHAUSTED',category:'RATE_OR_QUOTA'},{status:403,code:'PERMISSION_DENIED',category:'PERMISSION'},{status:400,code:'INVALID_ARGUMENT',category:'SCHEMA_OR_REQUEST'},{status:404,code:'NOT_FOUND',category:'MODEL_OR_ENDPOINT'},{status:429,code:'RESOURCE_EXHAUSTED:'+secret,category:'RATE_OR_QUOTA'}]){
    const events:CompilerDiagnostic[]=[];let calls=0;
    const compiler=new BriefCompiler({provider:'GEMINI',apiKey:secret,diagnostic:event=>events.push(event),fetchImpl:async(url)=>{
      calls++;assert.match(String(url),/^https:\/\/generativelanguage\.googleapis\.com\//);
      return new Response(JSON.stringify({error:{code:scenario.status,status:scenario.code,message:secret,details:[{reason:secret}]}}),{status:scenario.status});
    }});
    await assert.rejects(compiler.compileBrief(secret),(error:unknown)=>error instanceof CompilerError&&error.code==='UNAVAILABLE'&&!error.message.includes(secret));
    assert.equal(calls,1);assert.deepEqual(events,[{provider:'GEMINI',event:'COMPILATION_FAILURE',category:scenario.category,httpStatus:scenario.status,code:scenario.code.includes(secret)?'UNRECOGNIZED':scenario.code}]);assert.ok(!JSON.stringify(events).includes(secret));
  }
});

test('Gemini oversized body and transport abort remain bounded failures without fallback',async()=>{
  for(const fetchImpl of [mock({payload:'x'.repeat(100000)}),(async()=>{throw new DOMException('SECRET_BODY_OR_KEY','AbortError');}) as typeof fetch]){
    const events:CompilerDiagnostic[]=[];let calls=0;
    const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'SECRET_BODY_OR_KEY',diagnostic:event=>events.push(event),fetchImpl:async(url,options)=>{calls++;return fetchImpl(url,options);}});
    await assert.rejects(compiler.compileBrief('Show Hello.'),(error:unknown)=>error instanceof CompilerError&&error.code==='UNAVAILABLE'&&!error.message.includes('SECRET_BODY_OR_KEY'));assert.equal(calls,1);assert.ok(!JSON.stringify(events).includes('SECRET_BODY_OR_KEY'));
  }
});

for (const fixture of fixtures) test(`reviewed fixture: ${fixture.id} (mock provider, not live AI)`, async () => {
  let request: Record<string, unknown> | undefined;
  const compiler = new BriefCompiler({apiKey: 'test-key-not-real', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); request = JSON.parse(String(options?.body));
    return new Response(JSON.stringify(result(fixture.reviewedDraft)));
  }});
  const draft = await compiler.compileBrief(fixture.brief);
  assert.equal(request?.store, false);
  assert.equal(request?.tools, undefined);
  assert.equal(draft.provider, 'OPENAI');
  assert.deepEqual(draft.requirements.map(r => r.type), fixture.expected.types);
  assert.equal(draft.requirements.filter(r => r.value === null).length, fixture.expected.unresolved);
  for (const r of draft.requirements) {
    assert.equal(fixture.brief.slice(r.sourceStart, r.sourceEnd), r.sourceQuote);
    if (r.value === null || r.type === 'HUMAN_REVIEW') { assert.ok(r.humanReviewRequired); assert.ok(r.ambiguities.length); }
    if (r.value !== null) assert.ok(r.sourceQuote.includes(r.value));
  }
});

test('no credentials means unconfigured, never a fake compilation', async () => {
  const compiler = new BriefCompiler({fetchImpl: async () => { throw new Error('must not call'); }});
  assert.equal(compiler.configured, false);
  await assert.rejects(compiler.compileBrief('A booking button'), (error: unknown) => error instanceof CompilerError && error.code === 'UNCONFIGURED');
});

test('invented booking destination and mobile viewport are rejected', () => {
  const brief = 'Make it mobile friendly with a booking button.';
  assert.throws(() => validateCompiledRequirements(brief, {requirements: [row('booking button', 'LINK', '/reserve')]}), /invented/);
  assert.throws(() => validateCompiledRequirements(brief, {requirements: [row('mobile friendly', 'OVERFLOW', '390')]}), /invented/);
  assert.throws(() => validateCompiledRequirements('The invoice is 390 dollars.', {requirements: [row('The invoice is 390 dollars.', 'OVERFLOW', '390')]}), /explicitly/);
});

test('forged quotations, unsafe paths, unknown checks and payment fields are rejected', () => {
  assert.throws(() => validateCompiledRequirements('Show Hello.', {requirements: [row('Show Goodbye.', 'TEXT', 'Goodbye')]}), /quotation/);
  for (const [quote, type, value] of [['Link javascript:alert(1)', 'LINK', 'javascript:alert(1)'], ['Image ../logo.png', 'IMAGE', '../logo.png'], ['Show Hello', 'PAYMENT', 'Hello']]) {
    assert.throws(() => validateCompiledRequirements(quote, {requirements: [row(quote, type, value)]}));
  }
  assert.throws(() => validateCompiledRequirements('Show Hello', {requirements: [{...row('Show Hello', 'TEXT', 'Hello'), paymentApproved: true}]}), /unexpected/);
  assert.throws(() => validateCompiledRequirements('Make it premium', {requirements: [row('Make it premium', 'HUMAN_REVIEW', 'premium')]}), /automated/);
});

test('null values require questions; review flag cannot be suppressed', () => {
  assert.throws(() => validateCompiledRequirements('mobile friendly', {requirements: [row('mobile friendly', 'OVERFLOW', null)]}), /explicit question/);
  const rows = validateCompiledRequirements('mobile friendly', {requirements: [row('mobile friendly', 'OVERFLOW', null, ['Which viewport?'])]});
  assert.equal(rows[0].humanReviewRequired, true);
});

test('ambiguous objective text, links and images stay unanswered with exact source provenance',()=>{
  const cases:[string,string,string,string][]=[
    ['add a booking button','TEXT','booking',"Should the button text be 'booking' or something else?"],
    ['Booking links to /reserve.','LINK','/reserve','Is /reserve the exact agreed destination?'],
    ['Include images/logo.png.','IMAGE','images/logo.png','Which exact logo image path should be used?'],
  ];
  for(const [quote,type,value,question] of cases){
    const brief='Brief: '+quote;const [draft]=validateCompiledRequirements(brief,{requirements:[row(quote,type,value,[question])]});
    assert.equal(draft.value,null);assert.equal(draft.type,type);assert.equal(draft.humanReviewRequired,true);
    assert.equal(draft.sourceQuote,quote);assert.equal(draft.sourceStart,7);assert.equal(draft.sourceEnd,7+quote.length);assert.equal(brief.slice(draft.sourceStart,draft.sourceEnd),quote);
    assert.deepEqual(draft.ambiguities,[question]);
  }
});

test('complete objective values survive review flags when there are no unanswered questions',()=>{
  for(const [quote,type,value] of [['Show Booking.','TEXT','Booking'],['Booking links to /reserve.','LINK','/reserve'],['Include images/logo.png.','IMAGE','images/logo.png']]){
    const [draft]=validateCompiledRequirements(quote,{requirements:[{...row(quote,type,value),humanReviewRequired:true}]});
    assert.equal(draft.value,value);assert.deepEqual(draft.ambiguities,[]);assert.equal(draft.humanReviewRequired,true);
  }
});

test('ambiguity clearing cannot salvage invented or unsafe original objective values',async()=>{
  const cases:[string,string,string][]=[['add a booking button','TEXT','Reserve now'],['Booking button.','LINK','/invented'],['Include a logo.','IMAGE','images/invented.png'],['Use javascript:alert(1).','LINK','javascript:alert(1)'],['Include ../logo.png.','IMAGE','../logo.png']];
  for(const [quote,type,value] of cases){
    const brief='Show Hello. '+quote;let calls=0;
    const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',diagnostic:()=>{},fetchImpl:async()=>{
      calls++;return Response.json(geminiResult({requirements:[row('Show Hello.','TEXT','Hello'),row(quote,type,value,['Please confirm the exact value.'])]}));
    }});
    await assert.rejects(compiler.compileBrief(brief),(error:unknown)=>error instanceof CompilerError&&error.code==='INVALID_OUTPUT');assert.equal(calls,1);
  }
});

test('Gemini booking-purpose draft returns an unanswered text field without invented visible copy',async()=>{
  const brief='Add a booking button.';const question="Should the button text be 'booking' or something else?";let calls=0;
  const compiler=new BriefCompiler({provider:'GEMINI',apiKey:'test-not-real',fetchImpl:async(_url,options)=>{
    calls++;const prompt=JSON.parse(String(options?.body)).systemInstruction.parts[0].text;
    assert.match(prompt,/does not specify the button's visible text/);assert.match(prompt,/Never infer a visible label/);assert.match(prompt,/do not prefill a suggested answer/);
    return Response.json(geminiResult({requirements:[row(brief,'TEXT','booking',[question])]}));
  }});
  const [draft]=(await compiler.compileBrief(brief)).requirements;
  assert.equal(calls,1);assert.equal(draft.value,null);assert.equal(draft.sourceQuote,brief);assert.deepEqual(draft.ambiguities,[question]);assert.equal(draft.humanReviewRequired,true);
});

test('quoted conflicting destinations are made unresolved even if model selects one', () => {
  const brief = 'Use /reserve or /contact for booking.';
  const rows = validateCompiledRequirements(brief, {requirements: [row(brief, 'LINK', '/reserve')]});
  assert.equal(rows[0].value, null); assert.equal(rows[0].humanReviewRequired, true); assert.match(rows[0].ambiguities[0], /multiple destinations/);
});

test('quoted multiple viewport widths cannot silently select one', () => {
  const brief = 'Use viewport width 390 px or 640 px.';
  const rows = validateCompiledRequirements(brief, {requirements: [row(brief, 'OVERFLOW', '390')]});
  assert.equal(rows[0].value, null); assert.equal(rows[0].humanReviewRequired, true); assert.match(rows[0].ambiguities[0], /multiple viewport widths/);
  assert.throws(() => validateCompiledRequirements('viewport 3[0 px', {requirements:[row('viewport 3[0 px','OVERFLOW','3[0')]}), CompilerError);
});

test('explicit overflow-at-pixels wording used by the project brief is supported', () => {
  const brief = 'No horizontal overflow at 390px.';
  const rows = validateCompiledRequirements(brief, {requirements:[row(brief,'OVERFLOW','390')]});
  assert.equal(rows[0].value,'390'); assert.equal(rows[0].sourceQuote,brief);
});

test('compiler bounds match the twelve-row corrected agreement limit', () => {
  const rows = Array.from({length:13}, (_,i) => row(`Text ${i}.`, 'TEXT', `${i}`));
  assert.throws(() => validateCompiledRequirements(rows.map(r=>r.sourceQuote).join(' '), {requirements:rows}), /1-12/);
});

test('refusal, incomplete response and tool calls cannot become a scope', async () => {
  for (const body of [result({}, {status: 'incomplete'}), {status:'completed', output:[{type:'function_call',name:'approvePayment'}]}, {status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'cannot'}]}]}]) {
    const compiler = new BriefCompiler({apiKey:'test',fetchImpl:mock(body)});
    await assert.rejects(compiler.compileBrief('Show Hello.'), CompilerError);
  }
});

test('provider errors and transport timeout expose no raw secrets or partial result', async () => {
  const raw = 'secret-private-brief-or-token';
  for (const fetchImpl of [mock({error: raw}, 401), (async () => { throw new Error(raw); }) as typeof fetch]) {
    const compiler = new BriefCompiler({apiKey:'test',fetchImpl});
    await assert.rejects(compiler.compileBrief('Show Hello.'), (error: unknown) => error instanceof CompilerError && error.code === 'UNAVAILABLE' && !error.message.includes(raw));
  }
});

test('input and provider response limits are enforced', async () => {
  const compiler = new BriefCompiler({apiKey:'test',fetchImpl:mock({x:'x'.repeat(100000)})});
  await assert.rejects(compiler.compileBrief('Show Hello.'), /allowed size/);
  await assert.rejects(compiler.compileBrief('a'.repeat(10001)), /10,000/);
});

test('overflow unit variants normalize only an explicitly quoted matching CSS pixel number', () => {
  for (const brief of ['Mobile ready at 390 CSS pixels.', 'Viewport width 390px.', 'No overflow at 390 px.']) {
    for (const value of ['390','390px','390 px','390 pixels','390 CSS pixels']) {
      const [draft] = validateCompiledRequirements(brief,{requirements:[row(brief,'OVERFLOW',value)]});
      assert.equal(draft.value,'390'); assert.equal(draft.sourceQuote,brief);
      assert.equal(brief.slice(draft.sourceStart,draft.sourceEnd),brief);
    }
  }
  for (const value of ['three hundred ninety','3px90','390.0px','390vw','390x844','+390px','390px extra']) {
    assert.throws(()=>validateCompiledRequirements('Viewport width 390px.',{requirements:[row('Viewport width 390px.','OVERFLOW',value)]}),CompilerError);
  }
});

test('width normalization cannot match a substring, decimal, grouped number or unrelated digit token', () => {
  for (const brief of ['Viewport width 1390px, price 390 dollars.','Viewport width 1390 CSS pixels.','Viewport width 1,390px.','Viewport width 390.0px.','Viewport width -390px.','Mobile friendly; price 390 dollars.','Viewport width 390 pixels.']) {
    assert.throws(()=>validateCompiledRequirements(brief,{requirements:[row(brief,'OVERFLOW','390px')]}),CompilerError);
  }
});

test('smart quotes, collapsed spaces and changed dashes reject the entire draft without automatic retry', async () => {
  const brief='Show "Hello". Include  two  spaces. Open Tuesday–Sunday.';
  for(const sourceQuote of ['Show “Hello”.','Include two spaces.','Open Tuesday-Sunday.']) {
    let calls=0;
    const compiler=new BriefCompiler({apiKey:'test',diagnostic:()=>{},fetchImpl:async()=>{
      calls++;return Response.json(result({requirements:[row('Show "Hello".','TEXT','Hello'),row(sourceQuote,'HUMAN_REVIEW',null,['Confirm the expectation.'])]}));
    }});
    await assert.rejects(compiler.compileBrief(brief),(e:unknown)=>e instanceof CompilerError&&e.code==='INVALID_OUTPUT');
    assert.equal(calls,1,'No hidden repair request, partial rows or fabricated quotation');
  }
});

test('authentication/model/schema diagnostics distinguish failures and whitelist secret-safe values', async () => {
  const secret='PRIVATE_KEY_BRIEF_ERROR_REQUESTID_MODEL';
  const scenarios=[{status:401,code:'invalid_api_key',category:'AUTHENTICATION'},{status:404,code:'model_not_found',category:'MODEL_OR_ENDPOINT'},{status:400,code:'invalid_json_schema',category:'SCHEMA_OR_REQUEST'},{status:429,code:'insufficient_quota',category:'RATE_OR_QUOTA'},{status:500,code:secret,category:'PROVIDER'}];
  for(const scenario of scenarios){
    const events:CompilerDiagnostic[]=[];let calls=0;
    const compiler=new BriefCompiler({apiKey:secret,model:secret,diagnostic:event=>events.push(event),fetchImpl:async()=>{
      calls++;return new Response(JSON.stringify({error:{code:scenario.code,message:secret,param:secret,type:secret},brief:secret}),{status:scenario.status,headers:{'x-request-id':secret}});
    }});
    await assert.rejects(compiler.compileBrief(secret),(e:unknown)=>e instanceof CompilerError&&!e.message.includes(secret));
    assert.equal(calls,1);assert.equal(events.length,1);assert.equal(events[0].category,scenario.category);
    assert.equal(events[0].httpStatus,scenario.status);assert.equal(events[0].code,scenario.code===secret?'UNRECOGNIZED':scenario.code);
    assert.deepEqual(Object.keys(events[0]).sort(),['category','code','event','httpStatus','provider']);
    assert.ok(!JSON.stringify(events).includes(secret));
  }
});

test('default server diagnostic log never includes provider text, key, brief or invalid model', async () => {
  const secret='DO_NOT_LOG_THIS_SECRET';const lines:string[]=[];const original=console.warn;
  console.warn=(...args:unknown[])=>{lines.push(args.map(String).join(' '));};
  try{
    const compiler=new BriefCompiler({apiKey:secret,model:secret,fetchImpl:mock({error:{code:secret,message:secret,type:secret,param:secret}},401)});
    await assert.rejects(compiler.compileBrief(secret),CompilerError);
  }finally{console.warn=original;}
  assert.equal(lines.length,1);assert.match(lines[0],/AUTHENTICATION/);assert.match(lines[0],/UNRECOGNIZED/);assert.ok(!lines[0].includes(secret));
});

test('canonical quota diagnostics recognize only exact allowlisted codes without provider secrets', async () => {
  const secret='QUOTA_PRIVATE_KEY_BRIEF_MESSAGE_REQUEST_ID';
  const codes=['credit_balance_exhausted','organization_usage_limit_exceeded','project_spend_limit_exceeded','organization_spend_limit_exceeded','usage_limit_exceeded'];
  for(const code of [...codes,'credit_balance_exhausted:'+secret,'USAGE_LIMIT_EXCEEDED',secret]){
    const events:CompilerDiagnostic[]=[];let calls=0;
    const compiler=new BriefCompiler({apiKey:secret,model:secret,diagnostic:event=>events.push(event),fetchImpl:async()=>{
      calls++;return new Response(JSON.stringify({error:{code,message:secret,type:secret,param:secret},brief:secret}),{status:429,headers:{'x-request-id':secret}});
    }});
    await assert.rejects(compiler.compileBrief(secret),(error:unknown)=>error instanceof CompilerError&&error.code==='UNAVAILABLE'&&!error.message.includes(secret));
    assert.equal(calls,1);assert.deepEqual(events,[{provider:'OPENAI',event:'COMPILATION_FAILURE',httpStatus:429,category:'RATE_OR_QUOTA',code:codes.includes(code)?code:'UNRECOGNIZED'}]);
    assert.ok(!JSON.stringify(events).includes(secret));
  }
});

test('provider objective text respects the corrected checklist four-hundred-character boundary', async () => {
  for(const length of [400,401]){
    const value='a'.repeat(length),brief='Show '+value+'.';
    const compiler=new BriefCompiler({apiKey:'test',diagnostic:()=>{},fetchImpl:mock(result({requirements:[row(brief,'TEXT',value)]}))});
    if(length===400)assert.equal((await compiler.compileBrief(brief)).requirements[0].value,value);
    else await assert.rejects(compiler.compileBrief(brief),(error:unknown)=>error instanceof CompilerError&&error.code==='INVALID_OUTPUT');
  }
});
