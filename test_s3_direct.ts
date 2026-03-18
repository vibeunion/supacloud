import { StorageService } from "./packages/management-api/src/services/storage.service";

async function run() {
  const projectRef = "pyayjnscjk";
  console.log("Fetching buckets...");
  const buckets = await StorageService.listBuckets(projectRef);
  console.log("Buckets:", buckets);
  
  if (buckets.length > 0) {
    const bucketName = buckets[0].name;
    console.log(`Fetching files for bucket ${bucketName}...`);
    const files = await StorageService.listFiles(projectRef, bucketName);
    console.log("Files:", files);
  }
}
run();
