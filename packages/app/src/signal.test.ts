import { describe, expect, it } from "bun:test";
import { signal, computed, effect, untracked, linkedSignal } from "./signal";

describe("Angular 19-style linkedSignal API", () => {
  it("creates shorthand linkedSignal derived from a computation and resets on source change", () => {
    const shippingMethods = signal(["Standard", "Express", "Overnight"]);
    const selected = linkedSignal(() => shippingMethods()[0]);

    expect(selected()).toBe("Standard");

    // User overrides the linked signal manually
    selected.set("Express");
    expect(selected()).toBe("Express");

    // Upstream dependency changes: linked signal automatically resets to the new computation
    shippingMethods.set(["Courier", "Drone"]);
    expect(selected()).toBe("Courier");

    // User can override again
    selected.set("Drone");
    expect(selected()).toBe("Drone");
  });

  it("supports update() and asReadonly() on linkedSignal", () => {
    const count = signal(5);
    const quantity = linkedSignal(() => count() * 2);

    expect(quantity()).toBe(10);

    quantity.update((q) => q + 3);
    expect(quantity()).toBe(13);

    const ro = quantity.asReadonly();
    expect(ro()).toBe(13);

    count.set(10);
    expect(quantity()).toBe(20);
    expect(ro()).toBe(20);
  });

  it("supports detailed options object with source and computation preserving previous state", () => {
    const options = signal(["apple", "banana", "cherry"]);
    const choice = linkedSignal<string[], string>({
      source: () => options(),
      computation: (source, previous) => {
        // If the previous value is still valid in the new options, keep it!
        if (previous && source.includes(previous.value)) {
          return previous.value;
        }
        return source[0];
      },
    });

    expect(choice()).toBe("apple");

    // Override to banana
    choice.set("banana");
    expect(choice()).toBe("banana");

    // New options list that still contains banana: preserves banana!
    options.set(["banana", "date", "elderberry"]);
    expect(choice()).toBe("banana");

    // New options list without banana: falls back to source[0] (fig)
    options.set(["fig", "grape"]);
    expect(choice()).toBe("fig");
  });

  it("integrates with reactive effects and does not recompute when source produces equal value", () => {
    const filter = signal("active");
    const page = linkedSignal(() => `page-1-${filter()}`);

    const log: string[] = [];
    const stopEffect = effect(() => {
      log.push(page());
    });

    expect(log).toEqual(["page-1-active"]);

    page.set("page-2-active");
    expect(log).toEqual(["page-1-active", "page-2-active"]);

    // Setting the same filter value does not reset page override
    filter.set("active");
    expect(page()).toBe("page-2-active");
    expect(log).toEqual(["page-1-active", "page-2-active"]);

    // Changing filter to new value resets page
    filter.set("archived");
    expect(page()).toBe("page-1-archived");
    expect(log).toEqual(["page-1-active", "page-2-active", "page-1-archived"]);

    stopEffect();
  });
});
