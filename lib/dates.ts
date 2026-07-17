export const APP_TIME_ZONE = 'America/Sao_Paulo';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function dateOnlyParts(value: string): RegExpMatchArray | null {
  return value.match(DATE_ONLY_RE);
}

function localDateParts(value: string | Date): { year: string; month: string; day: string } | null {
  if (typeof value === 'string') {
    const m = dateOnlyParts(value);
    if (m) return { year: m[1], month: m[2], day: m[3] };
  }

  const d = parseDate(value);
  if (!d) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: byType.year,
    month: byType.month,
    day: byType.day,
  };
}

export function formatDatePtBR(value: string | Date | null | undefined, empty = '—'): string {
  if (!value) return empty;

  if (typeof value === 'string') {
    const m = dateOnlyParts(value);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }

  const d = parseDate(value);
  if (!d) return String(value).slice(0, 10);

  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: APP_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function formatDateIsoLocal(value: string | Date | null | undefined): string {
  if (!value) return '';

  const parts = localDateParts(value);
  if (!parts) return String(value).slice(0, 10);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeZoneOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
    date.getUTCMilliseconds()
  );
  return asUtc - date.getTime();
}

function localDateTimeToUtc(dateText: string, hour: number, minute: number, second: number, ms: number): Date {
  const m = dateText.match(DATE_ONLY_RE);
  if (!m) {
    const d = new Date(dateText);
    return isNaN(d.getTime()) ? new Date(NaN) : d;
  }

  const guess = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, second, ms));
  return new Date(guess.getTime() - timeZoneOffsetMs(guess));
}

export function startOfLocalDayUtc(dateText: string): Date {
  return localDateTimeToUtc(dateText, 0, 0, 0, 0);
}

export function endOfLocalDayUtc(dateText: string): Date {
  return localDateTimeToUtc(dateText, 23, 59, 59, 999);
}
