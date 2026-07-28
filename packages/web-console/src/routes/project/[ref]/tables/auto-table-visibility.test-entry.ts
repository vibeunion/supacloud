import { mount, unmount } from "svelte";
import Harness from "./auto-table-visibility.test-harness.svelte";

export function mountHarness(target: HTMLElement) {
  return mount(Harness, { target });
}

export function unmountHarness(component: ReturnType<typeof mountHarness>) {
  return unmount(component);
}
