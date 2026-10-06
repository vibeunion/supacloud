// Tested @supacloud/app version for migration compatibility.
// Kept in its own module because a release-please generic extra-file rewrites
// every annotated version in a file to the same value; one package per file
// keeps independent releases from corrupting each other's tested pin.
export const MIGRATION_APP_VERSION = "0.23.0"; // x-release-please-version
