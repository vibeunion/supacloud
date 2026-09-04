import { describe, expect, test } from "bun:test";
import {
  DefaultUrlSerializer,
  UrlSegmentGroup,
  UrlTree,
} from "./url_tree";

describe("Angular-inspired UrlTree and DefaultUrlSerializer", () => {
  const serializer = new DefaultUrlSerializer();

  test("parses standard URLs with path, query params, and fragment", () => {
    const url = "/users/42?tab=profile&view=summary#details";
    const tree = serializer.parse(url);

    expect(tree.root.segments.length).toBe(2);
    expect(tree.root.segments[0].path).toBe("users");
    expect(tree.root.segments[1].path).toBe("42");
    expect(tree.queryParams).toEqual({
      tab: "profile",
      view: "summary",
    });
    expect(tree.fragment).toBe("details");
    expect(tree.queryParamMap.get("tab")).toBe("profile");
    expect(tree.queryParamMap.get("view")).toBe("summary");
    expect(tree.queryParamMap.has("unknown")).toBe(false);

    const serialized = serializer.serialize(tree);
    expect(serialized).toBe("/users/42?tab=profile&view=summary#details");
    expect(tree.toString()).toBe("/users/42?tab=profile&view=summary#details");
  });

  test("parses URLs with matrix parameters", () => {
    const url = "/items;category=books;format=hardcover/101";
    const tree = serializer.parse(url);

    expect(tree.root.segments.length).toBe(2);
    expect(tree.root.segments[0].path).toBe("items");
    expect(tree.root.segments[0].parameters).toEqual({
      category: "books",
      format: "hardcover",
    });
    expect(tree.root.segments[1].path).toBe("101");
    expect(tree.root.segments[1].parameters).toEqual({});

    const serialized = serializer.serialize(tree);
    expect(serialized).toBe("/items;category=books;format=hardcover/101");
  });

  test("handles empty and root paths correctly", () => {
    const tree1 = serializer.parse("/");
    expect(tree1.root.segments).toEqual([]);
    expect(tree1.queryParams).toEqual({});
    expect(tree1.fragment).toBeNull();
    expect(serializer.serialize(tree1)).toBe("/");

    const tree2 = serializer.parse("/?debug=true");
    expect(tree2.root.segments).toEqual([]);
    expect(tree2.queryParams).toEqual({ debug: "true" });
    expect(serializer.serialize(tree2)).toBe("/?debug=true");
  });
});
