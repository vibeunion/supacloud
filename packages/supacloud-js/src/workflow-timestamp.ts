export function isWorkflowTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  // Date.parse normalizes some invalid dates instead of rejecting them.
  return month >= 1 && month <= 12 && day >= 1 && day <= days
    && Number(value.slice(11, 13)) <= 23
    && Number(value.slice(14, 16)) <= 59
    && Number(value.slice(17, 19)) <= 59
    && Number.isFinite(Date.parse(value));
}
