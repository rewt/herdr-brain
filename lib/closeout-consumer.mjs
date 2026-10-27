// Capture physical code before Node loads the mutable retirement graph. Static
// import order alone cannot do this: ESM loads dependencies before evaluation.
import { loadedCloseoutCode } from './closeout-code.mjs';

const loadedCode = loadedCloseoutCode;
const { drainCloseout: drain, refreshCloseouts: refresh } = await import('./closeout-executor.mjs');

export function drainCloseout(options = {}) {
  return drain({ ...options, loadedCode: options.loadedCode ?? loadedCode });
}

export function refreshCloseouts(options={}){
  return refresh({...options,loadedCode:options.loadedCode??loadedCode});
}
