import { mount, unmount } from "svelte";
import Harness from "./navigation.test-harness.svelte";

export function mountHarness(target: HTMLElement) {
  return mount(Harness, { target });
}

export function unmountHarness(component: ReturnType<typeof mountHarness>) {
  return unmount(component);
}
