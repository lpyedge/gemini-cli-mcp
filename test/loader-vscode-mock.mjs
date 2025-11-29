// ESM loader that redirects the specifier 'vscode' to the repo-local mock
// located at ./helpers/vscodeMock.mjs. This loader can be passed to Node
// together with `--loader ts-node/esm` to allow tests to import 'vscode'.
export async function resolve(specifier, context, defaultResolve) {
  if (specifier === 'vscode') {
    return {
      url: new URL('./helpers/vscodeMock.mjs', import.meta.url).href
    };
  }
  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  return defaultLoad(url, context, defaultLoad);
}
