export interface RegionCatalogEntry {
  code: string;
  name: string;
  continent: string;
}

export const AVAILABLE_REGIONS: readonly RegionCatalogEntry[] = [
  { code: "local", name: "Local", continent: "local" },
  { code: "us-east-1", name: "US East (N. Virginia)", continent: "americas" },
  { code: "us-west-1", name: "US West (N. California)", continent: "americas" },
  { code: "eu-west-1", name: "EU (Ireland)", continent: "emea" },
  { code: "ap-southeast-1", name: "Asia Pacific (Singapore)", continent: "apac" },
];

const REGION_CODES = new Set(AVAILABLE_REGIONS.map((region) => region.code));

export function isKnownRegion(code: string): boolean {
  return REGION_CODES.has(code);
}
