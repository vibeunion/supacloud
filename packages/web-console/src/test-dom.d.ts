declare module "jsdom" {
  interface JSDOMOptions {
    pretendToBeVisual?: boolean;
    url?: string;
  }

  export class JSDOM {
    readonly window: Window & typeof globalThis & { close(): void };
    constructor(html?: string, options?: JSDOMOptions);
  }
}
