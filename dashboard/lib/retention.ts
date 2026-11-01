import { useEffect, useState } from 'react';

/**
 * Replay retention helpers shared by every dashboard page.
 *
 * Nothing here hardcodes a number of days:
 *   - Each event's real expiry is events.recordings_expire_at, set and extended only by the
 *     worker (paid storage extensions raise it). Pages read it straight from the event row.
 *   - The default length for new recordings is the worker's DEFAULT_RETENTION_DAYS, read
 *     through GET /api/config.
 */

/**
 * True once an event's replay is gone for good. Same rule as the worker's isReplayExpired():
 * NULL means nothing has been recorded yet (never expired), and demo events never expire.
 */
export function isReplayExpired(e: { recordings_expire_at?: string | null; is_demo?: boolean }): boolean {
  if (e.is_demo || !e.recordings_expire_at) return false;
  return Date.now() >= new Date(e.recordings_expire_at).getTime();
}

// One /api/config request per page load, shared by every component that asks.
// A failed request is forgotten so the next mount retries.
let configPromise: Promise<{ defaultRetentionDays?: number } | null> | null = null;

function loadConfig(): Promise<{ defaultRetentionDays?: number } | null> {
  if (!configPromise) {
    configPromise = fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/config`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((config) => {
        if (!config) configPromise = null;
        return config;
      });
  }
  return configPromise;
}

/** Default replay retention in days, from the worker. null while loading or if unreachable. */
export function useDefaultRetentionDays(): number | null {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    loadConfig().then((config) => {
      if (alive && typeof config?.defaultRetentionDays === 'number') setDays(config.defaultRetentionDays);
    });
    return () => {
      alive = false;
    };
  }, []);
  return days;
}

/** "30 days", or a neutral phrase while the value loads (or if the worker is unreachable). */
export function retentionPhrase(days: number | null): string {
  return days ? `${days} days` : 'a limited time';
}