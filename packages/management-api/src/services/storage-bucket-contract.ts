const MAX_STORAGE_BUCKET_ID_LENGTH = 100;
export const MAX_STORAGE_MIME_TYPE_COUNT = 100;
export const MAX_STORAGE_MIME_TYPE_LENGTH = 255;
export const STORAGE_PROJECT_REF_PATTERN_SOURCE = "^[A-Za-z0-9_-]{1,64}$";
export const STORAGE_BUCKET_ID_PATTERN_SOURCE = `^(?!\\.+$)[A-Za-z0-9._-]{1,${MAX_STORAGE_BUCKET_ID_LENGTH}}$`;
export const STORAGE_MIME_TYPE_PATTERN_SOURCE = "^(?=\\S)(?=.*\\S$)[^\\u0000-\\u001f\\u007f]+$";

const storageProjectRefPattern = new RegExp(STORAGE_PROJECT_REF_PATTERN_SOURCE);
const storageBucketIdPattern = new RegExp(STORAGE_BUCKET_ID_PATTERN_SOURCE);
const storageMimeTypePattern = new RegExp(STORAGE_MIME_TYPE_PATTERN_SOURCE);

export interface StorageBucketSettings {
  public?: boolean;
  file_size_limit?: number;
  allowed_mime_types?: string[];
}

function validStorageProjectRef(ref: string): boolean {
  return storageProjectRefPattern.test(ref);
}

function validStorageBucketId(bucketId: string): boolean {
  return storageBucketIdPattern.test(bucketId);
}

function validStorageFileSizeLimit(fileSizeLimit: number): boolean {
  return Number.isSafeInteger(fileSizeLimit) && fileSizeLimit > 0;
}

function validStorageMimeTypes(mimeTypes: string[]): boolean {
  return mimeTypes.length <= MAX_STORAGE_MIME_TYPE_COUNT
    && mimeTypes.every((mimeType) => mimeType.length <= MAX_STORAGE_MIME_TYPE_LENGTH
      && storageMimeTypePattern.test(mimeType));
}

export function storageBucketInputError(
  ref: string,
  bucketId: string,
  settings: StorageBucketSettings,
): string | null {
  if (!validStorageProjectRef(ref)) return "Invalid project ref";
  if (!validStorageBucketId(bucketId)) return "Invalid bucket id";
  if (settings.file_size_limit !== undefined && !validStorageFileSizeLimit(settings.file_size_limit)) {
    return "Invalid file size limit";
  }
  if (settings.allowed_mime_types !== undefined && !validStorageMimeTypes(settings.allowed_mime_types)) {
    return "Invalid allowed MIME types";
  }
  return null;
}
