import type { StorageDriver } from "./storage.adapter";

export type ProjectStorageRunner = <T>(ref: string, operation: (driver: StorageDriver) => Promise<T>) => Promise<T>;

/** Stateless facade: neither credentials nor the current project are mutable globals. */
export class ProjectStorageRouter implements StorageDriver {
  constructor(private readonly run: ProjectStorageRunner) {}
  createBucket(...args: Parameters<StorageDriver['createBucket']>) {
    return this.run(args[0], (driver) => driver.createBucket(...args));
  }
  deleteBucket(...args: Parameters<StorageDriver['deleteBucket']>) {
    return this.run(args[0], (driver) => driver.deleteBucket(...args));
  }
  emptyBucket(...args: Parameters<StorageDriver['emptyBucket']>) {
    return this.run(args[0], (driver) => driver.emptyBucket(...args));
  }
  listBuckets(...args: Parameters<StorageDriver['listBuckets']>) {
    return this.run(args[0], (driver) => driver.listBuckets(...args));
  }
  uploadFile(...args: Parameters<StorageDriver['uploadFile']>) {
    return this.run(args[0], (driver) => driver.uploadFile(...args));
  }
  uploadFileConditional(...args: Parameters<NonNullable<StorageDriver['uploadFileConditional']>>) {
    return this.run(args[0], async (driver) => driver.uploadFileConditional ? driver.uploadFileConditional(...args) : null);
  }
  copyFile(...args: Parameters<StorageDriver['copyFile']>) {
    return this.run(args[0], (driver) => driver.copyFile(...args));
  }
  deleteFile(...args: Parameters<StorageDriver['deleteFile']>) {
    return this.run(args[0], (driver) => driver.deleteFile(...args));
  }
  listFiles(...args: Parameters<StorageDriver['listFiles']>) {
    return this.run(args[0], (driver) => driver.listFiles(...args));
  }
  isBucketEmpty(...args: Parameters<StorageDriver['isBucketEmpty']>) {
    return this.run(args[0], (driver) => driver.isBucketEmpty(...args));
  }
  getDownloadResponse(...args: Parameters<StorageDriver['getDownloadResponse']>) {
    return this.run(args[0], (driver) => driver.getDownloadResponse(...args));
  }
  getInternalSourceUrl(ref: string, bucket: string, key: string) {
    return this.run(ref, async (driver) => driver.getInternalSourceUrl?.(ref, bucket, key));
  }
}
