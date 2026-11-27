import { ImgproxyError } from "./errors";

export type SourceRef = {
    kind: "plain" | "base64" | "enc";
    value: string;
    extension?: string;
};

export type ParsedImgproxyUrl = {
    signature: string;
    signedPath: string;
    options: string[];
    source: SourceRef;
    info: boolean;
};

export function parseImgproxyPath(pathname: string): ParsedImgproxyUrl {
    const rawPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const parts = rawPath.slice(1).split("/");
    if (parts.length < 2) {
        throw new ImgproxyError("Invalid imgproxy URL: missing signature or source", 400);
    }

    const info = parts[0] === "info";
    const signatureIndex = info ? 1 : 0;
    const signature = parts[signatureIndex];
    if (!signature) {
        throw new ImgproxyError("Invalid imgproxy URL: missing signature", 400);
    }
    const rest = parts.slice(signatureIndex + 1);
    if (rest.length === 0) {
        throw new ImgproxyError("Invalid imgproxy URL: missing source URL", 400);
    }

    const options: string[] = [];
    let index = 0;
    while (index < rest.length && rest[index].includes(":")) {
        options.push(rest[index]);
        index += 1;
    }
    if (index >= rest.length) {
        throw new ImgproxyError("Invalid imgproxy URL: missing source URL", 400);
    }

    let source: SourceRef;
    if (rest[index] === "plain") {
        const rawSource = rest.slice(index + 1).join("/");
        source = {
            kind: "plain",
            value: decodePlainSource(rawSource),
            extension: extractPlainExtension(rawSource),
        };
    } else if (rest[index] === "enc") {
        const encoded = rest.slice(index + 1).join("");
        source = {
            kind: "enc",
            value: stripExtension(encoded),
            extension: extractDotExtension(encoded),
        };
    } else {
        const encoded = rest.slice(index).join("");
        source = {
            kind: "base64",
            value: stripExtension(encoded),
            extension: extractDotExtension(encoded),
        };
    }

    if (!source.value) {
        throw new ImgproxyError("Invalid imgproxy URL: empty source URL", 400);
    }

    return {
        signature,
        signedPath: `/${rest.join("/")}`,
        options,
        source,
        info,
    };
}

function decodePlainSource(value: string): string {
    const withoutExtension = value.replace(/@[a-zA-Z0-9]+$/, "");
    try {
        return decodeURIComponent(withoutExtension);
    } catch {
        throw new ImgproxyError("Invalid source URL encoding", 400);
    }
}

function extractPlainExtension(value: string): string | undefined {
    const match = value.match(/@([a-zA-Z0-9]+)$/);
    return match?.[1]?.toLowerCase();
}

function stripExtension(value: string): string {
    return value.replace(/\.[a-zA-Z0-9]+$/, "");
}

function extractDotExtension(value: string): string | undefined {
    const match = value.match(/\.([a-zA-Z0-9]+)$/);
    return match?.[1]?.toLowerCase();
}
