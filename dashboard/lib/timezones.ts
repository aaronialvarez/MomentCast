// Curated IANA timezone list for the event timezone pickers.
// Values are IANA names, so daylight saving is handled by Intl everywhere else in the app.
// Labels show the abbreviation in effect today, for example "Los Angeles (PDT)".

export type TimezoneOption = { value: string; label: string };

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

// Each entry is one row in the picker. ids[0] is the value stored on the event; the other ids
// are cities merged into the row because they share BOTH the UTC offset and the daylight-saving
// calendar with ids[0], so the choice never changes a time. Zones that only match on today's
// offset (Lagos vs London, Athens vs Istanbul) are deliberately kept as separate rows.
// Keep the name in the same order as ids.
const ZONES: { ids: string[]; name: string }[] = [
  // United States and Canada
  { ids: ['Pacific/Honolulu'], name: 'Honolulu' },
  { ids: ['America/Anchorage'], name: 'Anchorage' },
  { ids: ['America/Los_Angeles', 'America/Tijuana'], name: 'Los Angeles, Tijuana' },
  { ids: ['America/Phoenix'], name: 'Phoenix' },
  { ids: ['America/Denver'], name: 'Denver' },
  { ids: ['America/Chicago'], name: 'Chicago' },
  { ids: ['America/New_York'], name: 'New York' },
  { ids: ['America/Halifax'], name: 'Halifax' },
  { ids: ['America/St_Johns'], name: 'St. Johns' },
  // Mexico, Central and South America
  { ids: ['America/Mexico_City'], name: 'Mexico City' },
  { ids: ['America/Bogota', 'America/Lima'], name: 'Bogota, Lima' },
  { ids: ['America/Santiago'], name: 'Santiago' },
  { ids: ['America/Argentina/Buenos_Aires', 'America/Sao_Paulo'], name: 'Buenos Aires, Sao Paulo' },
  // Europe
  { ids: ['Europe/Lisbon', 'Europe/London'], name: 'Lisbon, London' },
  { ids: ['Europe/Berlin', 'Europe/Madrid', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm'], name: 'Berlin, Madrid, Paris, Rome, Stockholm' },
  { ids: ['Europe/Athens'], name: 'Athens' },
  // Africa and Middle East
  { ids: ['Africa/Cairo'], name: 'Cairo' },
  { ids: ['Asia/Jerusalem'], name: 'Jerusalem' },
  { ids: ['Europe/Istanbul', 'Europe/Moscow', 'Africa/Nairobi', 'Asia/Riyadh'], name: 'Istanbul, Moscow, Nairobi, Riyadh' },
  { ids: ['Africa/Lagos'], name: 'Lagos' },
  { ids: ['Africa/Johannesburg'], name: 'Johannesburg' },
  { ids: ['Asia/Dubai'], name: 'Dubai' },
  // Asia
  { ids: ['Asia/Karachi'], name: 'Karachi' },
  { ids: ['Asia/Kolkata'], name: 'India (Kolkata)' },
  { ids: ['Asia/Kathmandu'], name: 'Kathmandu' },
  { ids: ['Asia/Dhaka'], name: 'Dhaka' },
  { ids: ['Asia/Bangkok'], name: 'Bangkok' },
  { ids: ['Asia/Hong_Kong', 'Asia/Manila', 'Australia/Perth', 'Asia/Shanghai', 'Asia/Singapore'], name: 'Hong Kong, Manila, Perth, Shanghai, Singapore' },
  { ids: ['Asia/Seoul', 'Asia/Tokyo'], name: 'Seoul, Tokyo' },
  // Oceania
  { ids: ['Australia/Adelaide'], name: 'Adelaide' },
  { ids: ['Australia/Melbourne', 'Australia/Sydney'], name: 'Melbourne, Sydney' },
  { ids: ['Pacific/Auckland'], name: 'Auckland' },
];

// Abbreviation in effect today, for example PDT or GMT+2.
function zoneAbbreviation(id: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

export function isValidTimezone(id: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

// The browser's own zone, or Pacific if the browser reports something unusable.
export function getBrowserTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

// Built once: creating ~50 Intl formatters on every render would be wasteful.
let baseOptions: TimezoneOption[] | null = null;
function getBaseOptions(): TimezoneOption[] {
  if (!baseOptions) {
    baseOptions = ZONES.map(z => {
      const abbr = zoneAbbreviation(z.ids[0]);
      return { value: z.ids[0], label: abbr ? `${z.name} (${abbr})` : z.name };
    });
  }
  return baseOptions;
}

// The curated list, plus extraId (the browser's zone, or the zone an existing event was
// saved with) when it is not already in the list, so it can always be selected.
// Maps a zone that was merged into a shared row (Asia/Seoul) to that row's stored id
// (Asia/Seoul is ids[0] of "Seoul, Tokyo"). Any other id comes back unchanged.
export function resolveTimezone(id: string): string {
  const match = ZONES.find(z => z.ids.includes(id));
  return match ? match.ids[0] : id;
}

export function getTimezoneOptions(extraId?: string | null): TimezoneOption[] {
  const options = getBaseOptions();
  const resolved = extraId ? resolveTimezone(extraId) : null;
  if (resolved && isValidTimezone(resolved) && !options.some(o => o.value === resolved)) {
    const abbr = zoneAbbreviation(resolved);
    const city = (resolved.split('/').pop() || resolved).replace(/_/g, ' ');
    return [{ value: resolved, label: abbr ? `${city} (${abbr})` : city }, ...options];
  }
  return options;
}