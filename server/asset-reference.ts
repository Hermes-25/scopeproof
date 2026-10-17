import {posix} from 'node:path';
// HTML may spell a root-bundle asset as './asset'. Archive names remain strict.
// Resolve only that equivalent local spelling; never decode or follow a URL.
export function localAssetReference(value:string):string|undefined {
  const name=value.replace(/^(?:\.\/)+/,'');
  if(!name||name.length>180||name.startsWith('/')||/[\\:%?#\x00-\x1f]/.test(name)||/(^|\/)\.\.($|\/)/.test(name)||posix.normalize(name)!==name)return;
  return name;
}
