import type { CompilerConfig } from './compiler.ts';

/** Billing is an account setting, not discoverable from a key. This gate records local confirmation. */
export function selectCompilerConfig(env: Record<string, string | undefined>): {config: CompilerConfig; freeTierConfirmed: boolean} {
  const provider=env.AI_PROVIDER||'GEMINI';
  if(provider!=='GEMINI'&&provider!=='OPENAI') throw new Error('AI_PROVIDER must be GEMINI or OPENAI. No provider fallback is allowed.');
  const freeTierConfirmed=env.GEMINI_FREE_TIER_CONFIRMED==='true';
  return {freeTierConfirmed,config:{provider,apiKey:provider==='GEMINI'?(freeTierConfirmed?env.GEMINI_API_KEY:undefined):env.OPENAI_API_KEY,model:provider==='GEMINI'?env.GEMINI_MODEL:env.OPENAI_MODEL}};
}
