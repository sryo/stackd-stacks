// Resolves the runtime's sd:// import to the fake runtime.
export async function resolve(specifier, context, next) {
  if (specifier === "sd://runtime/api.js") {
    return { url: new URL("./fake-sd.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
