import init, { DocumentSession } from "@twango/sdocx";
import wasmUrl from "@twango/sdocx/sdocx_bg.wasm?url";

let ready: Promise<void> | undefined;

export function loadParser(): Promise<void> {
  ready ??= init({ module_or_path: wasmUrl }).then(
    () => undefined,
    (error: unknown) => {
      ready = undefined;
      throw error;
    },
  );
  return ready;
}

export type Session = DocumentSession;

export const openSession = (bytes: Uint8Array): Session => new DocumentSession(bytes);
