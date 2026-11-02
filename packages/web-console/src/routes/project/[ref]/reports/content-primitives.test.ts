import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pages = ["api-overview", "auth", "database", "storage"] as const;

function source(page: string): string {
  return readFileSync(new URL(`./${page}/+page.svelte`, import.meta.url), "utf8");
}

describe("report pages reuse svadmin content primitives", () => {
  for (const page of pages) {
    test(`${page} renders metrics and data states through shared components`, () => {
      const content = source(page);
      expect(content).toContain('from "@svadmin/ui/components/content/DataState.svelte"');
      expect(content).toContain('from "@svadmin/ui/components/content/MetricBlock.svelte"');
      expect(content).toContain("<DataState");
      expect(content).toContain("<MetricBlock");
      expect(content).not.toContain('class="animate-spin text-brand opacity-50"');
      expect(content).not.toContain('class="rounded-xl border bg-card p-4"');
    });
  }

  for (const page of ["api-overview", "auth", "storage"] as const) {
    test(`${page} renders row status through StatusBadge`, () => {
      const content = source(page);
      expect(content).toContain('from "@svadmin/ui/components/content/StatusBadge.svelte"');
      expect(content).toContain("<StatusBadge");
      expect(content).not.toContain('class="px-1.5 py-0.5 rounded text-[9px] font-bold');
    });
  }
});