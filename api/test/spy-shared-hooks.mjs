// Module resolve hook for spy-shared.mjs. Only server.js's own imports are redirected, so the spy
// modules' imports of the real ones, and push-messages.js's import of shared-routine.js, are left
// alone.
const SPY = { './shared-routine.js': './shared-routine.spy.mjs', './push-messages.js': './push-messages.spy.mjs' };
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(SPY, specifier) && context.parentURL?.endsWith('/server.js')) {
    return { shortCircuit: true, url: new URL(SPY[specifier], import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
