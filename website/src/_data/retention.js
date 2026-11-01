// Retention numbers the marketing copy quotes ({{ retention.days }},
// {{ retention.slugCooldownDays }}), read from the worker at BUILD time so the site
// can never contradict the app. Source of truth: worker.ts (DEFAULT_RETENTION_DAYS,
// SLUG_COOLDOWN_DAYS), served by GET {apiUrl}/api/config.
//
// If the worker is unreachable or the values are missing, the build FAILS on purpose:
// Cloudflare Pages keeps serving the last good site instead of publishing guesses.
import { readFileSync } from 'node:fs';

const site = JSON.parse(readFileSync(new URL('./site.json', import.meta.url), 'utf8'));

export default async function () {
  const res = await fetch(`${site.apiUrl}/api/config`);
  if (!res.ok) throw new Error(`retention.js: ${site.apiUrl}/api/config returned ${res.status}`);

  const config = await res.json();
  const { defaultRetentionDays, slugCooldownDays } = config;
  if (typeof defaultRetentionDays !== 'number' || typeof slugCooldownDays !== 'number') {
    throw new Error(`retention.js: /api/config is missing retention values: ${JSON.stringify(config)}`);
  }

  return { days: defaultRetentionDays, slugCooldownDays };
}