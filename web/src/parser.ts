import * as bindings from "@twango/sdocx/sdocx_bg.js";
import wasmUrl from "@twango/sdocx/sdocx_bg.wasm?url";

let ready: Promise<void> | undefined;

export function loadParser(): Promise<void> {
  ready ??= WebAssembly.instantiateStreaming(fetch(wasmUrl), {
    "./sdocx_bg.js": bindings as unknown as WebAssembly.ModuleImports,
  }).then(
    ({ instance }) => {
      bindings.__wbg_set_wasm(instance.exports);
      (instance.exports.__wbindgen_start as (() => void) | undefined)?.();
    },
    (error: unknown) => {
      ready = undefined;
      throw error;
    },
  );
  return ready;
}

export type Session = bindings.DocumentSession;

export const openSession = (bytes: Uint8Array): Session => new bindings.DocumentSession(bytes);
