import { InjectionToken } from "./token";
import type { RoutePipelineContext } from "./route_pipeline";

/**
 * Strategy interface for updating application document / page titles upon navigation.
 * Modeled directly after Angular 14+ TitleStrategy.
 */
export abstract class TitleStrategy {
  abstract updateTitle(title: string | undefined, ctx?: RoutePipelineContext): void;

  buildTitle(title: string | undefined, appPrefix?: string): string | undefined {
    if (!title) return undefined;
    return appPrefix ? `${appPrefix} | ${title}` : title;
  }
}

/**
 * Default implementation of TitleStrategy.
 * Updates global document.title when available, and records the resolved title in route context data.
 */
export class DefaultTitleStrategy extends TitleStrategy {
  updateTitle(title: string | undefined, ctx?: RoutePipelineContext): void {
    if (!title) return;
    if (ctx) {
      if (!ctx.data) ctx.data = {};
      ctx.data.title = title;
    }
    if (typeof globalThis !== "undefined" && (globalThis as any).document) {
      (globalThis as any).document.title = title;
    }
  }
}

export const TITLE_STRATEGY = new InjectionToken<TitleStrategy>("supacloud.title-strategy", {
  scope: "application",
  factory: () => new DefaultTitleStrategy(),
});
