export class ImgproxyError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
        this.name = "ImgproxyError";
    }
}
