import test from 'node:test';
import assert from 'node:assert/strict';
import {selectCompilerConfig} from '../server/ai-config.ts';

test('default Gemini cannot use a key before unbilled Free Tier confirmation or fall back to OpenAI',()=>{
  for(const confirmation of [undefined,'false','TRUE']){
    const selected=selectCompilerConfig({GEMINI_API_KEY:'gemini-private-test',OPENAI_API_KEY:'openai-private-test',GEMINI_FREE_TIER_CONFIRMED:confirmation});
    assert.equal(selected.config.provider,'GEMINI');assert.equal(selected.config.apiKey,undefined);assert.equal(selected.freeTierConfirmed,false);
  }
  const confirmed=selectCompilerConfig({GEMINI_API_KEY:'gemini-private-test',OPENAI_API_KEY:'openai-private-test',GEMINI_FREE_TIER_CONFIRMED:'true'});
  assert.equal(confirmed.config.apiKey,'gemini-private-test');
  assert.equal(selectCompilerConfig({GEMINI_FREE_TIER_CONFIRMED:'true',OPENAI_API_KEY:'openai-private-test'}).config.apiKey,undefined);
});
test('unknown provider is rejected and historical OpenAI requires explicit selection',()=>{
  assert.throws(()=>selectCompilerConfig({AI_PROVIDER:'AUTO',OPENAI_API_KEY:'openai-private-test'}),/No provider fallback/);
  const explicit=selectCompilerConfig({AI_PROVIDER:'OPENAI',OPENAI_API_KEY:'openai-private-test',GEMINI_API_KEY:'gemini-private-test'});
  assert.equal(explicit.config.provider,'OPENAI');assert.equal(explicit.config.apiKey,'openai-private-test');
});
