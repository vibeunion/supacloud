const MAX_CRON_EXPRESSION_LENGTH = 256;
const CRON_FIELD_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;
const CRON_PART_PATTERN = /^(\*|([0-9]+)(?:-([0-9]+))?)(?:\/([0-9]+))?$/;

interface CronRange {
  start: number;
  end: number;
  step: number;
}

interface ParsedCron {
  fields: CronRange[][];
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

function boundedInteger(input: string, minimum: number, maximum: number): number | null {
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function cronRange(part: string, minimum: number, maximum: number): CronRange | null {
  const match = CRON_PART_PATTERN.exec(part);
  if (!match) return null;
  const start = match[1] === "*" ? minimum : boundedInteger(match[2], minimum, maximum);
  const end = match[1] === "*"
    ? maximum
    : match[3] === undefined ? start : boundedInteger(match[3], minimum, maximum);
  const step = match[4] === undefined ? 1 : boundedInteger(match[4], 1, maximum - minimum + 1);
  if (start === null || end === null || step === null || start > end) return null;
  return { start, end, step };
}

function cronField(field: string, minimum: number, maximum: number): CronRange[] | null {
  const parts = field.split(",");
  if (parts.length > maximum - minimum + 1 || parts.some((part) => part.length === 0)) return null;
  const ranges = parts.map((part) => cronRange(part, minimum, maximum));
  return ranges.some((range) => range === null) ? null : ranges as CronRange[];
}

function parsedCron(expression: unknown): ParsedCron | null {
  if (typeof expression !== "string" || !expression || expression.length > MAX_CRON_EXPRESSION_LENGTH) return null;
  const rawFields = expression.trim().split(/\s+/);
  if (rawFields.length !== CRON_FIELD_BOUNDS.length) return null;
  const fields = rawFields.map((field, index) => {
    const [minimum, maximum] = CRON_FIELD_BOUNDS[index];
    return cronField(field, minimum, maximum);
  });
  if (fields.some((field) => field === null)) return null;
  return {
    fields: fields as CronRange[][],
    dayOfMonthWildcard: rawFields[2] === "*",
    dayOfWeekWildcard: rawFields[4] === "*",
  };
}

function fieldMatches(ranges: CronRange[], value: number): boolean {
  return ranges.some((range) => value >= range.start && value <= range.end
    && (value - range.start) % range.step === 0);
}

export function isValidScheduledFunctionCron(expression: unknown): boolean {
  return parsedCron(expression) !== null;
}

export function scheduledFunctionCronMatches(expression: unknown, date: Date): boolean {
  const cron = parsedCron(expression);
  if (!cron) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.fields;
  const minuteMatches = fieldMatches(minute, date.getMinutes());
  const hourMatches = fieldMatches(hour, date.getHours());
  const monthMatches = fieldMatches(month, date.getMonth() + 1);
  const dayOfMonthMatches = fieldMatches(dayOfMonth, date.getDate());
  const weekday = date.getDay();
  const dayOfWeekMatches = fieldMatches(dayOfWeek, weekday)
    || (weekday === 0 && fieldMatches(dayOfWeek, 7));
  const dayMatches = !cron.dayOfMonthWildcard && !cron.dayOfWeekWildcard
    ? dayOfMonthMatches || dayOfWeekMatches
    : dayOfMonthMatches && dayOfWeekMatches;
  return minuteMatches && hourMatches && monthMatches && dayMatches;
}
