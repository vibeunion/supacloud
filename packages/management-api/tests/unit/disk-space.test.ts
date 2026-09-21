import { expect, test } from "bun:test";
import { parseDiskSpace } from "../../src/utils/disk-space";

const header = "Filesystem 1024-blocks Used Available Capacity Mounted on";
test("parses POSIX numeric disk reports with spaces in mount paths", () => {
  expect(parseDiskSpace(`${header}\n/dev/disk1 10000000 500000 9000000 5% /System/Volumes/Data\n/dev/disk2 100 101 -1 101% /mount with spaces\n`))
    .toEqual([
      { mount: "/System/Volumes/Data", availableKiB: 9000000, usedPercent: 5 },
      { mount: "/mount with spaces", availableKiB: -1, usedPercent: 101 },
    ]);
});

test.each([
  "", header, `${header}\ntruncated`, `${header}\n/dev/x 10 1 unknown 10% /`,
  `${header}\n/dev/x 0 0 0 0% /`, `${header}\n/dev/x 9007199254740992 1 1 1% /`,
  `${header}\n/dev/x 10 1 9 10%`, `${header.replace("1024", "512")}\n/dev/x 10 1 9 10% /`,
])("rejects unusable disk report %# instead of claiming sufficient space", (report) => {
  expect(() => parseDiskSpace(report)).toThrow("Invalid disk space report");
});
