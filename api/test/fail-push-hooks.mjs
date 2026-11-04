// Module resolve hook for fail-push.mjs. It runs on the loader's own thread, so it shares no
// variables with the server: the fault is switched by a file, read in push-messages.faulty.mjs.
// Only server.js's import is redirected, which leaves the faulty module's own import of the real
// push-messages.js alone.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === './push-messages.js' && context.parentURL?.endsWith('/server.js')) {
    return { shortCircuit: true, url: new URL('./push-messages.faulty.mjs', import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
