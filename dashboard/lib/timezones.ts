// Curated IANA timezone list for the event timezone pickers.
// Values are IANA names, so daylight saving is handled by Intl everywhere else in the app.
// Labels show the abbreviation in effect today, for example "Los Angeles (PDT)".

export type TimezoneOption = { value: string; label: string };

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

const ZONES: { id: string; name: string }[] = [
  // United States and Canada
  { id: 'Pacific/Honolulu', name: 'Honolulu' },
  { id: 'America/Anchorage', name: 'Anchorage' },
  { id: 'America/Los_Angeles', name: 'Los Angeles (Pacific)' },
  { id: 'America/Phoenix', name: 'Phoenix (Arizona)' },
  { id: 'America/Denver', name: 'Denver (Mountain)' },
  { id: 'America/Chicago', name: 'Chicago (Central)' },
  { id: 'America/New_York', name: 'New York (Eastern)' },
  { id: 'America/Halifax', name: 'Halifax (Atlantic)' },
  { id: 'America/St_Johns', name: 'St. Johns (Newfoundland)' },
  // Mexico, Central and South America
  { id: 'America/Tijuana', name: 'Tijuana' },
  { id: 'America/Mexico_City', name: 'Mexico City' },
  { id: 'America/Bogota', name: 'Bogota' },
  { id: 'America/Lima', name: 'Lima' },
  { id: 'America/Santiago', name: 'Santiago' },
  { id: 'America/Argentina/Buenos_Aires', name: 'Buenos Aires' },
  { id: 'America/Sao_Paulo', name: 'Sao Paulo' },
  // Europe
  { id: 'Europe/London', name: 'London' },
  { id: 'Europe/Lisbon', name: 'Lisbon' },
  { id: 'Europe/Madrid', name: 'Madrid' },
  { id: 'Europe/Paris', name: 'Paris' },
  { id: 'Europe/Berlin', name: 'Berlin' },
  { id: 'Europe/Rome', name: 'Rome' },
  { id: 'Europe/Stockholm', name: 'Stockholm' },
  { id: 'Europe/Athens', name: 'Athens' },
  { id: 'Europe/Istanbul', name: 'Istanbul' },
  { id: 'Europe/Moscow', name: 'Moscow' },
  // Africa and Middle East
  { id: 'Africa/Lagos', name: 'Lagos' },
  { id: 'Africa/Cairo', name: 'Cairo' },
  { id: 'Africa/Johannesburg', name: 'Johannesburg' },
  { id: 'Africa/Nairobi', name: 'Nairobi' },
  { id: 'Asia/Jerusalem', name: 'Jerusalem' },
  { id: 'Asia/Riyadh', name: 'Riyadh' },
  { id: 'Asia/Dubai', name: 'Dubai' },
  // Asia
  { id: 'Asia/Karachi', name: 'Karachi' },
  { id: 'Asia/Kolkata', name: 'India (Kolkata)' },
  { id: 'Asia/Kathmandu', name: 'Kathmandu' },
  { id: 'Asia/Dhaka', name: 'Dhaka' },
  { id: 'Asia/Bangkok', name: 'Bangkok' },
  { id: 'Asia/Singapore', name: 'Singapore' },
  { id: 'Asia/Hong_Kong', name: 'Hong Kong' },
  { id: 'Asia/Shanghai', name: 'China (Shanghai)' },
  { id: 'Asia/Manila', name: 'Manila' },
  { id: 'Asia/Seoul', name: 'Seoul' },
  { id: 'Asia/Tokyo', name: 'Tokyo' },
  // Oceania
  { id: 'Australia/Perth', name: 'Perth' },
  { id: 'Australia/Adelaide', name: 'Adelaide' },
  { id: 'Australia/Sydney', name: 'Sydney' },
  { id: 'Pacific/Auckland', name: 'Auckland' },
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
      const abbr = zoneAbbreviation(z.id);
      return { value: z.id, label: abbr ? `${z.name} (${abbr})` : z.name };
    });
  }
  return baseOptions;
}

// The curated list, plus extraId (the browser's zone, or the zone an existing event was
// saved with) when it is not already in the list, so it can always be selected.
export function getTimezoneOptions(extraId?: string | null): TimezoneOption[] {
  const options = getBaseOptions();
  if (extraId && isValidTimezone(extraId) && !options.some(o => o.value === extraId)) {
    const abbr = zoneAbbreviation(extraId);
    const city = (extraId.split('/').pop() || extraId).replace(/_/g, ' ');
    return [{ value: extraId, label: abbr ? `${city} (${abbr})` : city }, ...options];
  }
  return options;
}