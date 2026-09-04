/**
 * Angular-inspired UrlTree and UrlSerializer for structured URL manipulation.
 * Modeled after Angular's @angular/router UrlTree and DefaultUrlSerializer API.
 */

export interface UrlSegment {
  path: string;
  parameters: Record<string, string>;
}

export class UrlSegmentGroup {
  segments: UrlSegment[];
  children: Record<string, UrlSegmentGroup>;
  parent: UrlSegmentGroup | null = null;

  constructor(segments: UrlSegment[], children: Record<string, UrlSegmentGroup> = {}) {
    this.segments = segments;
    this.children = children;
    for (const child of Object.values(children)) {
      child.parent = this;
    }
  }

  hasChildren(): boolean {
    return Object.keys(this.children).length > 0;
  }
}

export class UrlTree {
  root: UrlSegmentGroup;
  queryParams: Record<string, string>;
  fragment: string | null;

  constructor(root: UrlSegmentGroup, queryParams: Record<string, string> = {}, fragment: string | null = null) {
    this.root = root;
    this.queryParams = queryParams;
    this.fragment = fragment;
  }

  get queryParamMap(): Map<string, string> {
    return new Map(Object.entries(this.queryParams));
  }

  toString(): string {
    return new DefaultUrlSerializer().serialize(this);
  }
}

export abstract class UrlSerializer {
  abstract parse(url: string): UrlTree;
  abstract serialize(tree: UrlTree): string;
}

export class DefaultUrlSerializer implements UrlSerializer {
  parse(url: string): UrlTree {
    let remaining = url.trim();
    let fragment: string | null = null;
    const fragIndex = remaining.indexOf("#");
    if (fragIndex >= 0) {
      fragment = decodeURIComponent(remaining.slice(fragIndex + 1));
      remaining = remaining.slice(0, fragIndex);
    }

    const queryParams: Record<string, string> = {};
    const queryIndex = remaining.indexOf("?");
    if (queryIndex >= 0) {
      const rawQuery = remaining.slice(queryIndex + 1);
      remaining = remaining.slice(0, queryIndex);
      if (rawQuery.length > 0) {
        for (const pair of rawQuery.split("&")) {
          if (!pair) continue;
          const eq = pair.indexOf("=");
          const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
          const rawVal = eq >= 0 ? pair.slice(eq + 1) : "";
          queryParams[decodeURIComponent(rawKey.replace(/\+/g, " "))] = decodeURIComponent(rawVal.replace(/\+/g, " "));
        }
      }
    }

    const rawSegments = remaining.split("/").filter((s) => s.length > 0);
    const segments: UrlSegment[] = [];
    for (const rawSeg of rawSegments) {
      const matrixParts = rawSeg.split(";");
      const path = decodeURIComponent(matrixParts[0]);
      const parameters: Record<string, string> = {};
      for (let i = 1; i < matrixParts.length; i++) {
        const part = matrixParts[i];
        if (!part) continue;
        const eq = part.indexOf("=");
        const pKey = eq >= 0 ? part.slice(0, eq) : part;
        const pVal = eq >= 0 ? part.slice(eq + 1) : "";
        parameters[decodeURIComponent(pKey)] = decodeURIComponent(pVal);
      }
      segments.push({ path, parameters });
    }

    const root = new UrlSegmentGroup(segments);
    return new UrlTree(root, queryParams, fragment);
  }

  serialize(tree: UrlTree): string {
    const segmentStrings: string[] = [];
    for (const seg of tree.root.segments) {
      let segStr = encodeURIComponent(seg.path);
      const paramKeys = Object.keys(seg.parameters).sort();
      for (const pk of paramKeys) {
        segStr += `;${encodeURIComponent(pk)}=${encodeURIComponent(seg.parameters[pk])}`;
      }
      segmentStrings.push(segStr);
    }

    let path = "/" + segmentStrings.join("/");
    if (segmentStrings.length === 0) {
      path = "/";
    }

    const qKeys = Object.keys(tree.queryParams).sort();
    if (qKeys.length > 0) {
      const qParts = qKeys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(tree.queryParams[k])}`);
      path += `?${qParts.join("&")}`;
    }

    if (tree.fragment !== null && tree.fragment !== undefined) {
      path += `#${encodeURIComponent(tree.fragment)}`;
    }

    return path;
  }
}
