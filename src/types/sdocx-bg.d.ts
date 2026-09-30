declare module "@twango/sdocx/sdocx_bg.js" {
  export class DocumentSession {
    constructor(bytes: Uint8Array);
    readonly page_count: number;
    inspection(): unknown;
    render_svg(pageIndex: number, colorMode: "auto" | "light" | "dark"): string;
    free(): void;
  }
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
