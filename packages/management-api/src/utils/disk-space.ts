export type DiskSpace = {
  mount: string;
  availableKiB: number;
  usedPercent: number;
};

export function parseDiskSpace(output: string): DiskSpace[] {
  const [header, ...lines] = output.trim().split(/\r?\n/);
  if (!header || !/^Filesystem\s+1024-blocks\s+Used\s+Available\s+(Capacity|Use%)\s+Mounted on$/.test(header)
    || lines.length === 0) {
    throw new Error("Invalid disk space report");
  }
  return lines.map((line) => {
    const match = /^.+?\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)%\s+(\/.*)$/.exec(line.trim());
    const [, totalText, usedText, availableText, percentText, mount] = match ?? [];
    if (totalText === undefined || usedText === undefined || availableText === undefined
      || percentText === undefined || mount === undefined) throw new Error("Invalid disk space report");
    const total = Number(totalText);
    const used = Number(usedText);
    const availableKiB = Number(availableText);
    const usedPercent = Number(percentText);
    if (![total, used, availableKiB, usedPercent].every(Number.isSafeInteger) || total <= 0) {
      throw new Error("Invalid disk space report");
    }
    return { mount, availableKiB, usedPercent };
  });
}
