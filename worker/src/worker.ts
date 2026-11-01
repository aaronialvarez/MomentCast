import { createClient } from '@supabase/supabase-js';
import type { WorkerEnv, Event, User, CreateEventRequest, CreateEventResponse } from './types';
import QRCode from 'qrcode-svg';

// Days after an event's replay expires (events.recordings_expire_at) before its URL slug
// is released for reuse. Same rule for normal and extended events. Events that never
// recorded count from the event date. Applied by the SQL function release_expired_slugs().
const SLUG_COOLDOWN_DAYS = 90;

// Viewing cap for each user's permanent test event, in MINUTES (viewer_hour_limit is stored in
// minutes). 1500 = 25 hours. syncViewerHours lets test rows fall as old views age out of the
// 30-day analytics window, so this is a rolling cap, not a lifetime one.
const TEST_EVENT_VIEWER_LIMIT_MINUTES = 1500;

// Viewing included per credit, in MINUTES (viewer_hour_limit is stored in minutes).
// 15000 = 250 hours. Applied at event creation and on each top-up only, so events
// created before a rate change keep the limit they were sold with.
// Keep in sync with HOURS_PER_CREDIT in the marketing site estimator and create-event page.
const MINUTES_PER_CREDIT = 15000;
const HOURS_PER_CREDIT = MINUTES_PER_CREDIT / 60;

const DAY_MS = 24 * 60 * 60 * 1000;

// Default replay retention, in days, for every new recording. Single source for:
//   - the Live Input deletion rule (Cloudflare's safety net, see createCloudflareStreamLiveInput)
//   - the fallback date for videos Cloudflare has not stamped (e.g. future uploads)
// Each event's actual expiry lives in events.recordings_expire_at, which only grows
// (paid storage extensions raise it). Phase 2 exposes this value through /api/config.
const DEFAULT_RETENTION_DAYS = 30;

// Cloudflare calls the retention reconcile may spend per cron run. The free Workers plan
// allows 50 subrequests per invocation, and Supabase calls count toward that too.
const RETENTION_RECONCILE_BUDGET = 30;

// Paid replay storage extensions (see storageExtensionQuote):
// Most extra storage one event can buy, across all purchases, in months.
const MAX_STORAGE_EXTENSION_MONTHS = 12;
// One credit keeps this many RECORDED minutes online for one extra month (24 hours).
// months = floor(credits x RECORDED_MINUTES_PER_CREDIT_MONTH / recorded minutes), capped.
const RECORDED_MINUTES_PER_CREDIT_MONTH = 24 * 60;
// Purchases close this close to expiry, so the new date reaches Cloudflare in time.
const STORAGE_EXTENSION_MIN_LEAD_MINUTES = 60;

// Viewer-usage sync (see computeViewerUsage):
// Cloudflare's widest analytics query, in days (its limit is 31).
const ANALYTICS_WINDOW_DAYS = 31;
// Recent days Cloudflare may still revise. Older days are banked once and never re-queried.
const VIEWER_SETTLE_DAYS = 2;
// Calls (Supabase + Cloudflare) one sync run may spend; the Free plan allows 50.
const VIEWER_SYNC_BUDGET = 45;

// UTC hour of the once-a-day cleanup tick (see the scheduled() handler).
const DAILY_JOB_HOUR_UTC = 3;

// Origins allowed to embed the Stream Player. Hostnames only, no scheme.
// If you add a custom domain (e.g. live.aaronalvarez.com), it MUST be added here
// or the player will refuse to load on that domain.
// app.momentcast.live is included in case the dashboard previews streams.
// Wildcards match subdomains only, never the apex, so both forms are listed.
// Cloudflare Stream playback host for this account. Every player, manifest and download
// URL is built on it. The watch page receives it in each event response (playbackHost),
// so it is defined only here.
const STREAM_PLAYBACK_HOST = 'customer-r5vkm8rpzqtdt9cz.cloudflarestream.com';

// How long a signed playback token works, in hours (Cloudflare's maximum is 24).
// A guest admitted before the viewer limit is hit keeps watching until their token
// expires, but gets no new one; a copied link stops working after the same window.
const PLAYBACK_TOKEN_TTL_HOURS = 12;

// Live playback locking for REAL events (test events always lock). Verified on a test event
// 2026-10-31. Applied when a live input is created and again at Start Streaming, so inputs
// created before locking existed are covered. Set to false to unlock new sessions.
const LOCK_LIVE_PLAYBACK_FOR_REAL_EVENTS = true;

const ALLOWED_PLAYBACK_ORIGINS = [
  'momentcast.live',
  '*.momentcast.live',
  'aaronalvarez.com',
  '*.aaronalvarez.com',
];

/**
 * Utility: Set allowedOrigins + publicDetails.share_link on recordings.
 * share_link makes the player's share action copy the watch page URL instead of the
 * Cloudflare-hosted one (which bypasses countdown, branding, and the viewer-hour gate).
 * Best-effort: failures are logged, never thrown. Idempotent.
 * Capped at 20 videos per call to stay under the Workers subrequest limit.
 */
async function lockDownRecordings(uids: string[], slug: string, env: WorkerEnv): Promise<void> {
  const shareLink = `https://go.momentcast.live/${slug}`;
  await Promise.all(uids.slice(0, 20).map(async (uid) => {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${uid}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
          },
          body: JSON.stringify({
            allowedOrigins: ALLOWED_PLAYBACK_ORIGINS,
            publicDetails: { share_link: shareLink },
          }),
        }
      );
      if (!res.ok) {
        console.error(`lockDownRecordings: ${uid} failed (${res.status}):`, await res.text());
      }
    } catch (err) {
      console.error(`lockDownRecordings: ${uid} threw:`, err);
    }
  }));
}

/**
 * Utility: List every recording on a Live Input and lock each one down.
 * Used on connect so the in-progress recording is covered while viewers are watching.
 */
async function lockDownInputRecordings(liveInputId: string, slug: string, env: WorkerEnv): Promise<void> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${liveInputId}/videos`,
      { headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } }
    );
    const data = await res.json() as any;
    if (data.success && Array.isArray(data.result)) {
      await lockDownRecordings(data.result.map((v: any) => v.uid).filter(Boolean), slug, env);
    }
  } catch (err) {
    console.error('lockDownInputRecordings failed:', err);
  }
}

/**
 * Utility: Save recordings Cloudflare has for an event's Live Input that the event's own list
 * is missing (e.g. one that finalized after the last disconnect was saved). Append-only and
 * keyed by uid, so it never drops or duplicates entries. Saving changes events.recordings, so
 * the flag_retention_sync trigger flags the event and the retention reconcile gives the new
 * recording the event's expiry date and locks it.
 * videos: the Live Input's listing when the caller already fetched it (saves a request).
 * Returns how many recordings were added. Never throws.
 */
async function saveMissingRecordings(
  event: { id: string; slug: string; live_input_id: string },
  env: WorkerEnv,
  supabase: any,
  videos?: any[]
): Promise<number> {
  try {
    if (!videos) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}/videos`,
        { headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } }
      );
      const data = await res.json() as any;
      if (!data.success || !Array.isArray(data.result)) return 0;
      videos = data.result;
    }

    // Re-read the stored list right before writing, so a webhook update is not overwritten
    const { data: current } = await supabase.from('events').select('recordings').eq('id', event.id).single();
    const stored: any[] = current?.recordings || [];
    const known = new Set(stored.map((r: any) => r?.uid));
    const missing = (videos || [])
      .filter((v: any) => v?.uid && !known.has(v.uid))
      .map((v: any) => ({ uid: v.uid, status: v.status?.state, duration: v.duration, created: v.created, thumbnail: v.thumbnail }));
    if (missing.length === 0) return 0;

    const { error } = await supabase.from('events').update({ recordings: [...stored, ...missing] }).eq('id', event.id);
    if (error) {
      console.error(`saveMissingRecordings: failed to save for ${event.slug}:`, error);
      return 0;
    }
    await lockDownRecordings(missing.map((r: any) => r.uid), event.slug, env); // allowed sites + share link
    console.log(`📼 ${event.slug}: saved ${missing.length} recording(s) missing from the event list`);
    return missing.length;
  } catch (err) {
    console.error(`saveMissingRecordings: ${event.slug} threw:`, err);
    return 0;
  }
}

// ==================== Signed playback tokens ====================
// Tokens are RS256 JWTs signed locally with the account's Stream signing key, so issuing
// one costs no API call and has no rate limit. A token stands in for a video or live
// input ID in any playback URL (iframe, manifest, thumbnail, MP4 download).

let streamSigningKey: Promise<CryptoKey> | null = null;

function getStreamSigningKey(env: WorkerEnv): Promise<CryptoKey> {
  if (!streamSigningKey) {
    // Cloudflare returns the JWK base64-encoded; it is stored exactly as returned.
    const jwk = JSON.parse(atob(env.STREAM_SIGNING_JWK));
    streamSigningKey = crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );
    // A failed import is not cached, so the next request retries
    streamSigningKey.catch(() => { streamSigningKey = null; });
  }
  return streamSigningKey;
}

function base64Url(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Tokens are reused within an isolate while they still have most of their life left, which
// keeps RSA signing (CPU) off the hot path when many guests poll the same event.
const playbackTokenCache = new Map<string, { token: string; expMs: number }>();
const PLAYBACK_TOKEN_REUSE_MS = 60 * 60 * 1000; // reuse while at most 1 hour old

/**
 * Utility: A signed playback token for one video or live input ID.
 * downloadable: true is required for MP4 download URLs (owner-only, see the downloads routes).
 */
async function signPlaybackToken(id: string, env: WorkerEnv, opts: { downloadable?: boolean } = {}): Promise<string> {
  const cacheKey = `${id}:${opts.downloadable ? 'dl' : 'view'}`;
  const ttlMs = PLAYBACK_TOKEN_TTL_HOURS * 60 * 60 * 1000;
  const cached = playbackTokenCache.get(cacheKey);
  if (cached && cached.expMs - Date.now() > ttlMs - PLAYBACK_TOKEN_REUSE_MS) return cached.token;

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + PLAYBACK_TOKEN_TTL_HOURS * 60 * 60;
  const header = { alg: 'RS256', kid: env.STREAM_SIGNING_KEY_ID };
  const payload: Record<string, unknown> = { sub: id, kid: env.STREAM_SIGNING_KEY_ID, exp: expSec };
  if (opts.downloadable) payload.downloadable = true;

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', await getStreamSigningKey(env), new TextEncoder().encode(unsigned)
  );
  const token = `${unsigned}.${base64Url(signature)}`;

  playbackTokenCache.set(cacheKey, { token, expMs: expSec * 1000 });
  return token;
}

/** Utility: Signed HLS address for a recording (the FFmpeg fallback for 4h+ recordings). */
async function signedHlsUrl(uid: string, env: WorkerEnv): Promise<string> {
  return `https://${STREAM_PLAYBACK_HOST}/${await signPlaybackToken(uid, env)}/manifest/video.m3u8`;
}

/**
 * Utility: The owner's MP4 link for a recording. Cloudflare's URL carries the plain video ID;
 * a downloadable token replaces it so the link keeps working once the video is locked.
 * ?filename= makes the browser save a clean name instead of "default.mp4".
 */
async function signedDownloadUrl(baseUrl: string | undefined, uid: string, filename: string, env: WorkerEnv): Promise<string | null> {
  if (!baseUrl) return null;
  const token = await signPlaybackToken(uid, env, { downloadable: true });
  return `${baseUrl.replace(`/${uid}/`, `/${token}/`)}?filename=${encodeURIComponent(filename)}`;
}

/**
 * Utility: True once an event's replay is gone for good (recordings_expire_at has passed).
 * The one expiry rule every route uses: watch page data, top-ups, analytics.
 * NULL means nothing recorded yet, which is never expired. Demo events never expire.
 */
function isReplayExpired(event: { recordings_expire_at?: string | null; is_demo?: boolean }): boolean {
  if (event.is_demo || !event.recordings_expire_at) return false;
  return Date.now() >= new Date(event.recordings_expire_at).getTime();
}

/**
 * Utility: Make every recording of one event expire on the same date.
 *
 * events.recordings_expire_at is the single source of truth for replay retention.
 * This function never decides retention; it only makes Cloudflare match the column:
 *   1. Reads each recording's state and current deletion date from Cloudflare.
 *   2. Target = the later of the column and the newest date any finalized recording
 *      already carries (Cloudflare stamps finalize time + DEFAULT_RETENTION_DAYS).
 *      Never earlier than the column, so a paid extension survives later reconnects.
 *   3. Sets every finalized recording's scheduledDeletion to the target.
 *
 * Recordings still finalizing are skipped: Cloudflare stamps them when they finish and
 * would overwrite our date. They make the result pending, and the cron retries.
 * Recordings Cloudflare no longer has (404) or that failed to encode are ignored.
 * Never throws. Stops early (pending) when the subrequest budget runs out.
 */
async function reconcileRecordingRetention(
  event: { slug: string; recordings: any[] | null; recordings_expire_at: string | null },
  env: WorkerEnv,
  budget: number
): Promise<{ done: boolean; expiresAt: string | null; subrequests: number }> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream`;
  const auth = { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` };
  const uids: string[] = (event.recordings || []).map((r: any) => r?.uid).filter(Boolean);

  let subrequests = 0;
  let pending = false;
  let latestMs = event.recordings_expire_at ? new Date(event.recordings_expire_at).getTime() : 0;
  const finalized: { uid: string; currentMs: number | null; locked: boolean }[] = [];

  // 1-2. Read every recording and find the latest date in play
  for (const uid of uids) {
    if (subrequests >= budget) { pending = true; break; }
    subrequests++;
    try {
      const res = await fetch(`${base}/${uid}`, { headers: auth });
      if (res.status === 404) continue;                       // already deleted by Cloudflare
      const data = await res.json() as any;
      if (!res.ok || !data.success) { pending = true; continue; } // transient, retry next pass

      const video = data.result;
      const state = video.status?.state;
      if (state === 'error') continue;                         // never playable, nothing to keep
      if (state !== 'ready') { pending = true; continue; }     // still finalizing

      const currentMs = video.scheduledDeletion ? new Date(video.scheduledDeletion).getTime() : null;
      // Unstamped videos (e.g. uploads) default to created + DEFAULT_RETENTION_DAYS
      const stampMs = currentMs ?? new Date(video.created).getTime() + DEFAULT_RETENTION_DAYS * DAY_MS;
      latestMs = Math.max(latestMs, stampMs);
      finalized.push({ uid, currentMs, locked: video.requireSignedURLs === true });
    } catch (err) {
      console.error(`reconcileRecordingRetention: read ${uid} for ${event.slug} threw:`, err);
      pending = true;
    }
  }

  if (!latestMs) return { done: !pending, expiresAt: null, subrequests };

  // Cloudflare stores whole minutes; round UP so the target is never earlier than a stamp
  // and an already-synced recording compares equal (no repeat writes).
  const targetMs = Math.ceil(latestMs / 60000) * 60000;
  const target = new Date(targetMs).toISOString();

  // 3. Bring every finalized recording to the target date, locked (signed tokens only)
  for (const v of finalized) {
    if (v.currentMs === targetMs && v.locked) continue;        // already in sync
    if (subrequests >= budget) { pending = true; break; }
    subrequests++;
    try {
      const res = await fetch(`${base}/${v.uid}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledDeletion: target, requireSignedURLs: true }),
      });
      if (!res.ok) {
        console.error(`reconcileRecordingRetention: set ${v.uid} for ${event.slug} failed (${res.status}):`, await res.text());
        pending = true;
      }
    } catch (err) {
      console.error(`reconcileRecordingRetention: set ${v.uid} for ${event.slug} threw:`, err);
      pending = true;
    }
  }

  return { done: !pending, expiresAt: target, subrequests };
}

/** Utility: Add calendar months in UTC, clamping to month end (Jan 31 + 1 = Feb 28), like Postgres. */
function addMonthsUtc(ms: number, months: number): Date {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInMonth));
  return d;
}

type StorageExtensionQuote =
  | { eligible: false; reason: string }
  | {
      eligible: true;
      recordedMinutes: number;
      currentExpiry: string;
      extendedMonths: number;
      remainingMonths: number;
      maxMonths: number;
      options: { credits: number; months: number; newExpiry: string }[];
    };

/**
 * Utility: What a storage extension can buy for one event. The single source for the dashboard
 * preview AND the purchase, so the page never shows a price the worker would not honor.
 * Recorded minutes come from Cloudflare at call time (stored durations can be stale).
 * Options list only credit counts that buy more months than a smaller count; the cap
 * (MAX_STORAGE_EXTENSION_MONTHS across all purchases) ends the list.
 */
async function storageExtensionQuote(
  event: { slug: string; status: string; is_test?: boolean; is_demo?: boolean; slug_released_at?: string | null;
           recordings?: any; recordings_expire_at?: string | null; recordings_extended_months?: number | null },
  env: WorkerEnv
): Promise<StorageExtensionQuote> {
  if (event.is_test || event.is_demo) return { eligible: false, reason: 'Storage extensions are not available for this event.' };
  if (event.status !== 'ended') return { eligible: false, reason: 'Storage can be extended once the event has ended.' };
  if (event.slug_released_at || !event.recordings_expire_at || isReplayExpired(event)) {
    return { eligible: false, reason: 'This replay has expired.' };
  }
  const expiryMs = new Date(event.recordings_expire_at).getTime();
  if (expiryMs < Date.now() + STORAGE_EXTENSION_MIN_LEAD_MINUTES * 60 * 1000) {
    return { eligible: false, reason: 'This replay expires too soon to extend.' };
  }
  const extendedMonths = Number(event.recordings_extended_months) || 0;
  const remainingMonths = MAX_STORAGE_EXTENSION_MONTHS - extendedMonths;
  if (remainingMonths <= 0) {
    return { eligible: false, reason: `This replay already has the maximum extra storage (${MAX_STORAGE_EXTENSION_MONTHS} months).` };
  }

  // Total recorded minutes, from Cloudflare. Every recording must be finished processing.
  let recordedSeconds = 0;
  let found = 0;
  for (const uid of eventRecordingUids(event)) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${uid}`,
      { headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } }
    );
    if (res.status === 404) continue; // deleted
    const data = await res.json() as any;
    if (!res.ok || !data.success) throw new Error(`Cloudflare lookup failed for ${uid} (${res.status})`);
    const state = data.result?.status?.state;
    if (state === 'error') continue; // never playable, costs no storage
    if (state !== 'ready') return { eligible: false, reason: 'Recordings are still processing. Try again in a few minutes.' };
    recordedSeconds += Math.max(0, Number(data.result?.duration) || 0);
    found++;
  }
  if (found === 0 || recordedSeconds <= 0) return { eligible: false, reason: 'This event has no recordings to keep.' };

  const recordedMinutes = recordedSeconds / 60;
  const options: { credits: number; months: number; newExpiry: string }[] = [];
  for (let credits = 1; credits <= 100; credits++) {
    const months = Math.min(remainingMonths, Math.floor((credits * RECORDED_MINUTES_PER_CREDIT_MONTH) / recordedMinutes));
    if (months < 1 || months <= (options[options.length - 1]?.months ?? 0)) continue;
    options.push({ credits, months, newExpiry: addMonthsUtc(expiryMs, months).toISOString() });
    if (months === remainingMonths) break;
  }

  return {
    eligible: true,
    recordedMinutes: Math.round(recordedMinutes * 10) / 10,
    currentExpiry: event.recordings_expire_at,
    extendedMonths,
    remainingMonths,
    maxMonths: MAX_STORAGE_EXTENSION_MONTHS,
    options,
  };
}

/**
 * Cron step: reconcile replay retention for flagged events.
 * A database trigger sets events.retention_sync_needed whenever events.recordings changes
 * (new recording, reconnect, future uploads), so no route has to remember to call this.
 * Oldest-flagged first, within RETENTION_RECONCILE_BUDGET Cloudflare calls per run.
 */
async function reconcileRetentionBatch(env: WorkerEnv, supabase: any): Promise<void> {
  const { data: flagged, error } = await supabase
    .from('events')
    .select('id, slug, recordings, recordings_expire_at, updated_at')
    .eq('retention_sync_needed', true)
    .eq('is_test', false)
    .eq('is_demo', false)
    .order('updated_at', { ascending: true })
    .limit(5);

  if (error) {
    console.error('reconcileRetentionBatch: failed to fetch flagged events:', error);
    return;
  }
  if (!flagged || flagged.length === 0) return;

  let used = 0;
  for (const evt of flagged) {
    const remaining = RETENTION_RECONCILE_BUDGET - used;
    if (remaining <= 0) break;

    const result = await reconcileRecordingRetention(evt, env, remaining);
    used += result.subrequests;

    const updates: Record<string, any> = {};
    const storedMs = evt.recordings_expire_at ? new Date(evt.recordings_expire_at).getTime() : null;
    if (result.expiresAt && new Date(result.expiresAt).getTime() !== storedMs) {
      updates.recordings_expire_at = result.expiresAt;
    }
    if (result.done) updates.retention_sync_needed = false;
    if (Object.keys(updates).length === 0) continue;

    // Only write if the row is unchanged since we read it. If a reconnect added a recording
    // mid-run, the trigger re-flagged the row and the next pass handles it with fresh data.
    const { error: updateError } = await supabase
      .from('events')
      .update(updates)
      .eq('id', evt.id)
      .eq('updated_at', evt.updated_at);

    if (updateError) {
      console.error(`reconcileRetentionBatch: failed to update ${evt.slug}:`, updateError);
    } else {
      console.log(`🗓️ ${evt.slug}: recordings expire ${result.expiresAt ?? 'n/a'}${result.done ? '' : ' (pending)'}`);
    }
  }
}

/**
 * Utility: Generate QR code as a base64 SVG data URL.
 * Uses qrcode-svg (pure JS, no Canvas/DOM — safe for Cloudflare Workers).
 * Called once at event creation; result is stored in Supabase and never regenerated.
 */
function generateQrDataUrl(url: string): string {
  const qr = new QRCode({
    content: url,
    padding: 1,
    width: 300,
    height: 300,
    color: '#000000',
    background: '#ffffff',
    ecl: 'M', // Medium error correction — good balance of density vs resilience
  });
  const svgString = qr.svg();
  const base64 = btoa(svgString);
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * Utility: Generate URL-safe slug from title
 */
// Articles, conjunctions, and prepositions (English + Spanish) dropped from slugs.
// ASCII only: the comparison runs after accent stripping.
const SLUG_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'at', 'in', 'on', 'for', 'to', 'with',
  'el', 'la', 'los', 'las', 'un', 'una', 'y', 'de', 'del', 'en', 'con', 'para',
]);

function generateSlug(title: string): string {
  const full = title
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents (for Spanish characters)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Drop stopwords so the 50-char budget goes to meaningful words.
  const filtered = full.split('-').filter((w) => !SLUG_STOPWORDS.has(w)).join('-');

  // Title was nothing but stopwords ("The", "Y"): keep the unfiltered slug.
  // Truncate last, then strip any trailing hyphen the cut leaves behind.
  return (filtered || full).substring(0, 50).replace(/-+$/, '');
}

/**
 * Utility: 3-char suffix, consonants and digits only (no offensive words).
 * Random, not time-derived, so concurrent requests and retries don't repeat.
 * 19,683 combinations. Modulo bias from 256 % 27 is irrelevant at this scale.
 */
function randomSuffix(): string {
  const safeChars = 'bdfghjkmnpqrstvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return Array.from(bytes, (b) => safeChars[b % safeChars.length]).join('');
}

/**
 * Utility: Resolve the URL slug for a new event.
 * The slug column is globally unique, so a slug that exists is a slug that is held.
 * Slugs free up when release_expired_slugs() tombstones them after SLUG_COOLDOWN_DAYS,
 * regardless of owner, or immediately when an event is cancelled.
 *  - Slug free: use the clean slug.
 *  - Slug held: add a 3-char family-safe suffix (consonants and digits only).
 */
async function resolveSlug(title: string, supabase: any): Promise<string> {
  const baseSlug = generateSlug(title);

  // Titles with no [a-z0-9] characters (emoji, non-Latin scripts) slugify to ''.
  // Skip the lookup and go straight to a suffixed fallback.
  if (!baseSlug) return `event-${randomSuffix()}`;

  const { data: existing, error: lookupError } = await supabase
    .from('events')
    .select('id')
    .eq('slug', baseSlug)
    .maybeSingle();

  if (lookupError) {
    // Fall through to the clean slug. If it is actually taken, the insert hits
    // events_slug_key and the existing retry block in POST /api/events adds a suffix.
    console.error('resolveSlug lookup error:', lookupError);
  }

  // Slug is free
  if (!existing) return baseSlug;

  // Slug is held: add a random 3-char suffix
  return `${baseSlug}-${randomSuffix()}`;
}

/**
 * Utility: Extract JWT token from Authorization header
 */
function extractToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  return parts.length === 2 && parts[0] === 'Bearer' ? parts[1] : null;
}

/**
 * Utility: True if the string is a timezone Intl recognizes. Intl throws a RangeError for
 * anything else, which would otherwise surface as a 500 from localDateTimeToUTC.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Utility: Convert a naive datetime + IANA timezone to UTC ISO string.
 * Example: ("2026-04-04T16:00", "America/Los_Angeles") → "2026-04-04T23:00:00.000Z"
 * Uses Intl API (fully supported in Cloudflare Workers) to resolve DST-aware offsets.
 */
function localDateTimeToUTC(naiveDatetime: string, timezone: string): string {
  // Parse the naive datetime components
  const [datePart, timePart] = naiveDatetime.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);

  // Create a Date object in UTC, then use Intl to find the offset for the target timezone.
  // Strategy: format the same instant in both UTC and the target tz, then compute the delta.
  const guessUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

  // Get the target timezone's local representation of this UTC instant
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(guessUtc);
  const getPart = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
  
  const localYear = getPart('year');
  const localMonth = getPart('month');
  const localDay = getPart('day');
  let localHour = getPart('hour');
  if (localHour === 24) localHour = 0; // Intl may return 24 for midnight
  const localMinute = getPart('minute');

  // Build a UTC timestamp from what the tz formatter thinks the local time is
  const localAsUtc = new Date(Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, 0));

  // The offset (in ms) is the difference: local representation - UTC instant
  const offsetMs = localAsUtc.getTime() - guessUtc.getTime();

  // The actual UTC time = naive local time - offset
  const actualUtc = new Date(guessUtc.getTime() - offsetMs);

  return actualUtc.toISOString();
}

/**
 * Utility: Verify JWT and extract user ID
 */
async function verifyJWT(token: string, env: WorkerEnv): Promise<string | null> {
  try {
    const url = new URL(env.SUPABASE_URL);
    const response = await fetch(`${url.origin}/auth/v1/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_SERVICE_KEY,
      },
    });

    if (!response.ok) return null;

    const data = await response.json() as { id: string };
    return data.id;
  } catch (error) {
    console.error('JWT verification failed:', error);
    return null;
  }
}

/**
 * Utility: Create Cloudflare Live Input
 */
/**
 * Utility: The recording block for a Live Input. One definition for creating and updating
 * inputs, so an update can never silently reset a setting (Cloudflare treats a missing
 * mode as 'off', which also disables live playback).
 * requireSignedURLs: true locks live playback and every recording made from the input,
 * so they only play through signed tokens (see signPlaybackToken).
 */
function liveInputRecordingSettings(mode: 'automatic' | 'off', requireSignedURLs: boolean) {
  return {
    mode,
    timeoutSeconds: 300, // 5 minutes - allows quick reconnects, finalizes recordings after disconnect
    requireSignedURLs,
    allowedOrigins: ALLOWED_PLAYBACK_ORIGINS,
  };
}

async function createCloudflareStreamLiveInput(
  title: string,
  env: WorkerEnv,
  recordingMode: 'automatic' | 'off' = 'automatic'
): Promise<{ liveInputId: string; rtmpsUrl: string; rtmpsKey: string } | null> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
        },
        body: JSON.stringify({
          meta: { name: title },
          //  preferLowLatency: true,
          recording: liveInputRecordingSettings(recordingMode, LOCK_LIVE_PLAYBACK_FOR_REAL_EVENTS),
          // Safety net only. reconcileRecordingRetention() sets each recording's real
          // date from events.recordings_expire_at once the recording finalizes.
          deleteRecordingAfterDays: DEFAULT_RETENTION_DAYS,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Cloudflare API error:', error);
      return null;
    }

    const data = await response.json() as any;
    const input = data.result;

    return {
      liveInputId: input.uid,
      rtmpsUrl: 'rtmps://push.momentcast.live:443/live/',
      rtmpsKey: input.rtmps?.streamKey,
    };
  } catch (error) {
    console.error('Failed to create Cloudflare Live Input:', error);
    return null;
  }
}

/**
 * Utility: Get the user's permanent test event, creating it if it doesn't
 * exist yet (lazy provisioning — no signup hook, first visit to the test
 * page creates it). One test event per user, enforced by the
 * events_one_test_per_user partial unique index in Postgres.
 */
async function getOrCreateTestEvent(
  userId: string,
  env: WorkerEnv,
  supabase: any
): Promise<{ event: any; error?: string }> {
  const { data: existing } = await supabase
    .from('events')
    .select('id, slug, title, live_input_id, rtmps_url, rtmps_key, status, test_session_armed_at, test_session_connected_at, test_session_last_ended_at, test_sessions_today, test_sessions_day')
    .eq('user_id', userId)
    .eq('is_test', true)
    .maybeSingle();

  if (existing) {
    return { event: existing };
  }

  // Recording must be 'automatic' — Cloudflare ties live HLS/DASH playback
  // to this same setting; 'off' means no live viewing at all, not just no
  // replay. 30-day auto-delete (Cloudflare's minimum) keeps storage bounded.
  const cfResult = await createCloudflareStreamLiveInput(`Setup Test - ${userId.slice(0, 8)}`, env, 'automatic');
  if (!cfResult) {
    return { event: null, error: 'Failed to create test live input' };
  }

  // Deterministic, collision-proof slug — never touches resolveSlug()
  const slug = `test-${userId.slice(0, 8)}`;

  const { data: inserted, error: insertError } = await supabase
    .from('events')
    .insert({
      user_id: userId,
      slug,
      title: 'Test Your Setup',
      scheduled_date: new Date().toISOString(), // unused for test rows; column is NOT NULL
      timezone: 'America/Los_Angeles',
      status: 'scheduled',
      live_input_id: cfResult.liveInputId,
      rtmps_url: cfResult.rtmpsUrl,
      rtmps_key: cfResult.rtmpsKey,
      is_test: true,
      viewer_hour_limit: TEST_EVENT_VIEWER_LIMIT_MINUTES, // column default is 5000, which would be ~83 hours
    })
    .select('id, slug, title, live_input_id, rtmps_url, rtmps_key, status, test_session_armed_at, test_session_connected_at, test_session_last_ended_at, test_sessions_today, test_sessions_day')
    .single();

  if (insertError) {
    // Race: two tabs lazily created at once. events_one_test_per_user rejects
    // the loser — clean up the orphaned Live Input, return the winner's row.
    if (insertError.code === '23505') {
      console.warn('Test event race detected, cleaning up duplicate Live Input:', cfResult.liveInputId);
      try {
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${cfResult.liveInputId}`,
          { method: 'DELETE', headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } }
        );
      } catch (err) {
        console.error('Failed to clean up duplicate test Live Input:', err);
      }

      const { data: winner } = await supabase
        .from('events')
        .select('id, slug, title, live_input_id, rtmps_url, rtmps_key, status, test_session_armed_at, test_session_connected_at, test_session_last_ended_at, test_sessions_today, test_sessions_day')
        .eq('user_id', userId)
        .eq('is_test', true)
        .single();

      return { event: winner };
    }

    console.error('Failed to insert test event:', insertError);
    return { event: null, error: 'Failed to create test event' };
  }

  return { event: inserted };
}

/**
 * Utility: compute the next daily test-session count, rolling over to 0 if
 * the stored day no longer matches today (UTC). Called only where a session
 * that actually connected ends — never on arm, and never on a stop that
 * happened before anything connected — so clicking Start then Stop without
 * streaming never costs a daily session or starts the cooldown.
 */
function incrementDailyTestSessionCount(
  currentToday: number,
  currentDay: string | null
): { sessionsToday: number; sessionsDay: string } {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const baseline = currentDay === todayUtc ? currentToday : 0;
  return { sessionsToday: baseline + 1, sessionsDay: todayUtc };
}

/**
 * Utility: Snapshot a test event's recordings from Cloudflare.
 * Real events merge and never shrink. Test events REPLACE their list with whatever Cloudflare
 * still holds, so recordings auto-deleted at 30 days drop out and syncViewerHours only meters
 * recordings that exist. Locks down only uids not already stored (idempotent, saves subrequests).
 * Returns null when the fetch fails so the caller leaves the stored list untouched.
 */
async function snapshotTestRecordings(
  liveInputId: string,
  slug: string,
  knownUids: Set<string>,
  env: WorkerEnv
): Promise<any[] | null> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${liveInputId}/videos`,
      { headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } }
    );
    const data = await res.json() as any;
    if (!res.ok || !data.success || !Array.isArray(data.result)) return null;

    const recordings = data.result.map((video: any) => ({
      uid: video.uid,
      status: video.status?.state,
      duration: video.duration,
      created: video.created,
      thumbnail: video.thumbnail,
      playback: { hls: video.playback?.hls, dash: video.playback?.dash },
      readyToStream: video.readyToStream,
      state: video.status,
    }));

    await lockDownRecordings(
      recordings.map((r: any) => r.uid).filter((uid: string) => uid && !knownUids.has(uid)),
      slug,
      env
    );
    return recordings;
  } catch (err) {
    console.error('snapshotTestRecordings failed:', err);
    return null;
  }
}

/**
 * Utility: Minutes viewed per recording, per UTC day, from Cloudflare Stream analytics.
 * Covers the widest window Cloudflare allows: the last ANALYTICS_WINDOW_DAYS days through today.
 * Returns Map<uid, Map<'YYYY-MM-DD', minutes>>, or null if ANY request fails.
 * Callers must treat null as "unknown" and never as zero, or a Cloudflare hiccup
 * would wipe real usage.
 */
async function fetchViewerMinutesByDay(
  uids: string[],
  env: WorkerEnv
): Promise<{ byUid: Map<string, Map<string, number>>; requests: number } | null> {
  const byUid = new Map<string, Map<string, number>>();
  if (uids.length === 0) return { byUid, requests: 0 };

  const now = Date.now();
  const startDate = utcDay(now - (ANALYTICS_WINDOW_DAYS - 1) * DAY_MS);
  const endDate = utcDay(now + DAY_MS); // date_lt is exclusive, so tomorrow includes today

  // One row per uid per day. 50 uids x 31 days = 1,550 rows, well under the row limit.
  const UID_BATCH_SIZE = 50;
  let requests = 0;

  for (let i = 0; i < uids.length; i += UID_BATCH_SIZE) {
    requests++;
    try {
      const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `
            query ViewerMinutesByDay($accountTag: String!, $startDate: String!, $endDate: String!, $uids: [String!]!) {
              viewer {
                accounts(filter: { accountTag: $accountTag }) {
                  streamMinutesViewedAdaptiveGroups(
                    filter: { date_geq: $startDate, date_lt: $endDate, uid_in: $uids }
                    limit: 10000
                  ) {
                    sum { minutesViewed }
                    dimensions { uid date }
                  }
                }
              }
            }
          `,
          variables: {
            accountTag: env.CLOUDFLARE_ACCOUNT_ID,
            startDate,
            endDate,
            uids: uids.slice(i, i + UID_BATCH_SIZE),
          },
        }),
      });

      const data = await response.json() as any;
      if (!response.ok || data.errors?.length || !data.data?.viewer?.accounts?.[0]) {
        console.error('fetchViewerMinutesByDay: GraphQL failure:', response.status, JSON.stringify(data.errors));
        return null;
      }

      for (const group of data.data.viewer.accounts[0].streamMinutesViewedAdaptiveGroups || []) {
        const uid = group.dimensions?.uid;
        const day = group.dimensions?.date;
        const minutes = Number(group.sum?.minutesViewed) || 0;
        if (!uid || !day) continue;
        if (!byUid.has(uid)) byUid.set(uid, new Map());
        const days = byUid.get(uid)!;
        days.set(day, (days.get(day) || 0) + minutes);
      }
    } catch (err) {
      console.error('fetchViewerMinutesByDay: request threw:', err);
      return null;
    }
  }

  return { byUid, requests };
}

/** Utility: 'YYYY-MM-DD' for a UTC timestamp (ms). */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().split('T')[0];
}

/** Utility: The recording uids stored on an event (handles a JSON-string column defensively). */
function eventRecordingUids(event: { recordings?: any }): string[] {
  const raw = event.recordings || [];
  const recs: any[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return recs.map((r: any) => r?.uid).filter(Boolean);
}

/** Utility: One per-day minutes series for an event, summed across all its recordings. */
function eventMinutesByDay(event: { recordings?: any }, byUid: Map<string, Map<string, number>>): Map<string, number> {
  const minutesByDay = new Map<string, number>();
  for (const uid of eventRecordingUids(event)) {
    for (const [day, minutes] of byUid.get(uid) || []) {
      minutesByDay.set(day, (minutesByDay.get(day) || 0) + minutes);
    }
  }
  return minutesByDay;
}

/**
 * Utility: True while an event can still gain viewing minutes, plus VIEWER_SETTLE_DAYS after
 * its replay expires so late-arriving analytics are banked. Test events always qualify
 * (their recording list only ever holds what Cloudflare still has).
 */
function isViewerSyncEligible(event: { is_test?: boolean; recordings_expire_at?: string | null }): boolean {
  if (event.is_test) return true;
  if (!event.recordings_expire_at) return true; // live, or ended moments ago (not reconciled yet)
  return Date.now() < new Date(event.recordings_expire_at).getTime() + (VIEWER_SETTLE_DAYS + 1) * DAY_MS;
}

/**
 * Utility: An event's viewing usage, in MINUTES, from per-day analytics.
 *
 * Cloudflare can only be asked about the last 31 days, so lifetime usage is BANKED:
 *   - Settled days (older than VIEWER_SETTLE_DAYS) are added once to viewer_minutes_banked,
 *     and viewer_minutes_banked_through moves forward. A banked day is never counted again.
 *   - Recent days are recounted on every call, since Cloudflare may still revise them.
 *   - consumed = banked + recent days. It never decreases.
 *
 * First call for an event (banked_through NULL, i.e. created under the old 30-day sync):
 * the bank starts at the larger of the settled days in the window and the old stored total
 * minus the recent days, so nothing already counted is lost or double-counted.
 *
 * Test events are the exception: their cap is "viewing in the last 30 days", so consumed is
 * simply the window total and is allowed to fall. Their bank is never touched.
 */
function computeViewerUsage(
  event: {
    is_test?: boolean;
    viewer_minutes_consumed?: number | string | null;
    viewer_minutes_banked?: number | string | null;
    viewer_minutes_banked_through?: string | null;
  },
  minutesByDay: Map<string, number>
): { consumed: number; banked: number; bankedThrough: string | null } {
  const storedConsumed = Number(event.viewer_minutes_consumed) || 0;
  const storedBanked = Number(event.viewer_minutes_banked) || 0;
  const storedThrough = event.viewer_minutes_banked_through || null;

  if (event.is_test) {
    let windowTotal = 0;
    for (const minutes of minutesByDay.values()) windowTotal += minutes;
    return { consumed: Math.round(windowTotal * 100) / 100, banked: storedBanked, bankedThrough: storedThrough };
  }

  // Last settled day: days up to and including it can be banked.
  const lastSettledDay = utcDay(Date.now() - (VIEWER_SETTLE_DAYS + 1) * DAY_MS);

  let settled = 0; // settled days not yet in the bank
  let recent = 0;  // unsettled days, recounted every time
  for (const [day, minutes] of minutesByDay) {
    if (storedThrough && day <= storedThrough) continue; // already banked
    if (day <= lastSettledDay) settled += minutes;
    else recent += minutes;
  }

  let banked: number;
  if (storedThrough) {
    banked = storedBanked + settled;
  } else {
    // Transition from the old sync: storedConsumed already includes everything it saw.
    banked = Math.max(settled, storedConsumed - recent);
  }
  const bankedThrough = storedThrough && storedThrough > lastSettledDay ? storedThrough : lastSettledDay;

  // Never report less than before (the old sync's peak can exceed what the window still shows).
  // Rounded to 2 decimals so float noise never counts as a change worth writing.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const consumed = Math.max(round2(banked + recent), storedConsumed);
  return { consumed, banked: round2(banked), bankedThrough };
}

/**
 * Cron step: Sync viewing usage for every event that can still gain minutes.
 * One analytics query per 50 recordings, then one write per event whose numbers changed.
 * Writes stop at VIEWER_SYNC_BUDGET total calls; unwritten events are fully recomputed on
 * the next run (their minutes are still inside the 31-day window), so nothing is lost.
 * Any analytics failure aborts the run before writing anything.
 */
async function syncViewerHours(env: WorkerEnv, supabase: any): Promise<void> {
  const { data: fetched, error } = await supabase
    .from('events')
    .select('id, slug, recordings, is_test, recordings_expire_at, viewer_minutes_consumed, viewer_minutes_banked, viewer_minutes_banked_through, updated_at')
    // Test rows sit at status 'scheduled' between sessions, so the status filter alone would skip them
    .or('status.in.(live,ready,ended),is_test.eq.true')
    .not('recordings', 'is', null)
    .order('updated_at', { ascending: true }); // stalest first, so a budget cut-off rotates fairly

  if (error) {
    console.error('syncViewerHours: failed to fetch events:', error);
    return;
  }

  const events = (fetched || []).filter((e: any) => isViewerSyncEligible(e) && eventRecordingUids(e).length > 0);
  if (events.length === 0) {
    console.log('syncViewerHours: no events in sync window');
    return;
  }

  const allUids: string[] = Array.from(new Set<string>(events.flatMap((e: any) => eventRecordingUids(e))));
  const analytics = await fetchViewerMinutesByDay(allUids, env);
  if (!analytics) {
    console.error('syncViewerHours: analytics unavailable, aborting run without writing');
    return;
  }

  let callsUsed = 1 + analytics.requests; // the select above + the GraphQL batches
  let updatedCount = 0;

  for (const event of events) {
    const usage = computeViewerUsage(event, eventMinutesByDay(event, analytics.byUid));
    const changed =
      usage.consumed !== (Number(event.viewer_minutes_consumed) || 0) ||
      usage.banked !== (Number(event.viewer_minutes_banked) || 0) ||
      usage.bankedThrough !== (event.viewer_minutes_banked_through || null);
    if (!changed) continue;

    if (callsUsed >= VIEWER_SYNC_BUDGET) {
      console.warn('syncViewerHours: call budget reached, remaining events sync next run');
      break;
    }
    callsUsed++;

    const { error: updateError } = await supabase
      .from('events')
      .update({
        viewer_minutes_consumed: usage.consumed,
        viewer_minutes_banked: usage.banked,
        viewer_minutes_banked_through: usage.bankedThrough,
      })
      .eq('id', event.id);

    if (updateError) {
      console.error(`syncViewerHours: failed to update ${event.slug}:`, updateError);
    } else {
      console.log(`📊 ${event.slug}: ${Number(event.viewer_minutes_consumed) || 0} → ${usage.consumed} min`);
      updatedCount++;
    }
  }

  console.log(`syncViewerHours: checked ${events.length} events, updated ${updatedCount}`);
}

/**
 * Utility: Return the user's Stripe Customer ID, creating the Customer on first use.
 * One user = one Stripe Customer, reused across every checkout.
 * - Idempotency-Key makes concurrent first-time calls resolve to the same Customer.
 * - The DB write only lands if the column is still null, so a race loser never
 *   overwrites the winner. If we lose, we re-read and return the winner's ID.
 * Throws on Stripe failure; the caller's try/catch turns that into a 500.
 */
async function getOrCreateStripeCustomer(
  userId: string,
  email: string | null | undefined,
  existingId: string | null | undefined,
  env: WorkerEnv,
  supabase: any
): Promise<string> {
  if (existingId) return existingId;

  const params = new URLSearchParams({ 'metadata[user_id]': userId });
  if (email) params.set('email', email);

  const res = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `mc-customer-${userId}`,
    },
    body: params.toString(),
  });
  const customer = await res.json() as any;

  if (!res.ok || !customer.id) {
    throw new Error(`Stripe customer create failed (${res.status}): ${customer.error?.message || 'unknown'}`);
  }

  const { data: updated, error: saveError } = await supabase
    .from('users')
    .update({ stripe_customer_id: customer.id })
    .eq('id', userId)
    .is('stripe_customer_id', null)
    .select('stripe_customer_id');

  if (saveError) {
    // Still usable for this checkout. Next call re-hits Stripe with the same
    // idempotency key (24h window) and gets this same Customer back.
    console.error('Failed to save stripe_customer_id:', saveError);
    return customer.id;
  }

  // Zero rows updated = another request saved first. Use theirs.
  if (!updated || updated.length === 0) {
    const { data: winner } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();
    if (winner?.stripe_customer_id) return winner.stripe_customer_id;
  }

  return customer.id;
}

/**
 * Utility: Constant-time string compare, used for the webhook shared secret.
 * A length mismatch returns early. The secret's length is not sensitive.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Utility: Add a confirmed user to the MailerLite group. Returns true on success.
 * POST to the subscribers endpoint is an upsert, so a repeat call for the same email is safe.
 * The auth header is Bearer, not Token. opted_in_at must be 'Y-m-d H:i:s' (ISO 8601 is rejected).
 * Never throws: a MailerLite outage must not break signup or the webhook response.
 */
async function syncToMailerLite(
  env: WorkerEnv,
  user: { email: string; fullName: string; optedInAt: string }
): Promise<boolean> {
  // optedInAt is the moment the user ticked the marketing checkbox, not the email confirmation time.
  const confirmed = new Date(user.optedInAt);
  if (isNaN(confirmed.getTime())) {
    console.error('syncToMailerLite: bad optedInAt value:', user.optedInAt);
    return false;
  }

  // First word = first name, everything else = last name. Single-word names leave last_name empty.
  const parts = (user.fullName || '').trim().split(/\s+/).filter(Boolean);

  try {
    const res = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${env.MAILERLITE_API_KEY}`,
      },
      body: JSON.stringify({
        email: user.email,
        fields: { name: parts[0] || '', last_name: parts.slice(1).join(' ') || '' },
        groups: [env.MAILERLITE_GROUP_ID],
        opted_in_at: confirmed.toISOString().replace('T', ' ').substring(0, 19),
      }),
    });

    if (!res.ok) {
      console.error('MailerLite sync failed:', res.status, await res.text());
      return false;
    }
    await res.text(); // drain the body so the connection is released
    return true;
  } catch (err) {
    console.error('MailerLite sync threw:', err);
    return false;
  }
}

/**
 * Utility: Stamp public.users so this user is never synced or retried again.
 * The stamp is the source of truth, not MailerLite. A subscriber deleted in
 * MailerLite looks identical to one never synced, so asking MailerLite would re-add them.
 */
async function markMailerLiteSynced(userId: string, supabase: any): Promise<void> {
  const { error } = await supabase
    .from('users')
    .update({ mailerlite_synced_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) console.error('markMailerLiteSynced failed:', userId, error);
}

/**
 * Utility: Hourly retry for confirmed users the webhook path never completed.
 * Only touches users with mailerlite_synced_at IS NULL, confirmed in the last 7 days
 * (filtering happens inside the get_unsynced_mailerlite_users SQL function).
 * Subrequest budget on the Free plan is 50: 1 RPC + up to 3 per user (GET, POST, stamp).
 * At 12 users that is 37.
 */
async function reconcileMailerLite(env: WorkerEnv, supabase: any): Promise<void> {
  const MAX_USERS = 12;
  const mlHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${env.MAILERLITE_API_KEY}`,
  };

  const { data: users, error } = await supabase.rpc('get_unsynced_mailerlite_users', { max_rows: MAX_USERS });
  if (error) {
    console.error('Reconcile: RPC failed:', error);
    return;
  }

  let added = 0;
  for (const u of users || []) {
    try {
      // Belt and suspenders: if MailerLite already has them (including unsubscribed), just stamp.
      const check = await fetch(
        `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(u.email)}`,
        { headers: mlHeaders }
      );
      const checkStatus = check.status;
      await check.text(); // drain the body so the connection is released

      if (checkStatus === 200) {
        await markMailerLiteSynced(u.id, supabase);
        console.log(`Reconcile: already in MailerLite, stamped ${u.id}`);
        continue;
      }
      if (checkStatus !== 404) {
        console.error(`Reconcile: unexpected MailerLite status ${checkStatus} for ${u.id}`);
        continue; // leave unstamped, retry next hour
      }

      const ok = await syncToMailerLite(env, {
        email: u.email,
        fullName: u.full_name,
        optedInAt: u.marketing_opt_in_at,
      });
      if (ok) {
        await markMailerLiteSynced(u.id, supabase);
        added++;
        console.log(`Reconcile: added missing subscriber ${u.id}`);
      }
    } catch (err) {
      console.error(`Reconcile: error for ${u.id}:`, err);
    }
  }
  console.log(`Reconcile done. Unsynced found: ${(users || []).length}, added: ${added}.`);
}

/**
 * Main Router
 */
async function handleRequest(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // Handle preflight
  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Initialize Supabase client
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  try {
    // POST /api/webhooks/supabase-auth - Supabase Database Webhook on auth.users (INSERT and UPDATE).
    // Adds a user to MailerLite the moment their email is confirmed. Never for unconfirmed emails.
    if (pathname === '/api/webhooks/supabase-auth' && method === 'POST') {
      // Fail closed: no configured secret means nothing gets through.
      const provided = request.headers.get('x-webhook-secret') || '';
      if (!env.SUPABASE_WEBHOOK_SECRET || !timingSafeEqual(provided, env.SUPABASE_WEBHOOK_SECRET)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const payload = await request.json() as any;
      const record = payload?.record;
      const oldRecord = payload?.old_record;
      const isInsert = payload?.type === 'INSERT';
      const isUpdate = payload?.type === 'UPDATE';

      // Fire only at the moment of confirmation:
      //  - UPDATE where email_confirmed_at went from null to a value (email signup)
      //  - INSERT that already carries email_confirmed_at (Google OAuth)
      // Every login also UPDATEs auth.users, so most calls exit right here.
      const justConfirmed =
        !!record?.email_confirmed_at && (isInsert || (isUpdate && !oldRecord?.email_confirmed_at));

      if (!justConfirmed || !record?.id || !record?.email) {
        return new Response(JSON.stringify({ received: true, skipped: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Consent gate: only users who ticked the signup checkbox go to MailerLite.
      // Google signups and unchecked email signups exit here and are never synced.
      const optedIn = record.raw_user_meta_data?.marketing_opt_in === true;
      const optedInAt = record.raw_user_meta_data?.marketing_opt_in_at;
      if (!optedIn || !optedInAt) {
        return new Response(JSON.stringify({ received: true, skipped: true, noMarketingConsent: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Stamp check first: makes a duplicate delivery harmless and guarantees a
      // subscriber deleted from MailerLite is never re-added by this path.
      const { data: syncRow, error: syncRowError } = await supabase
        .from('users')
        .select('mailerlite_synced_at')
        .eq('id', record.id)
        .maybeSingle();

      if (syncRowError || !syncRow) {
        // public.users row is created by the on_auth_user_created trigger, so this should not happen.
        console.error('supabase-auth webhook: could not load public.users row for', record.id, syncRowError);
        return new Response(JSON.stringify({ received: true, skipped: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (syncRow.mailerlite_synced_at) {
        return new Response(JSON.stringify({ received: true, skipped: true, alreadySynced: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const fullName = record.raw_user_meta_data?.full_name || record.raw_user_meta_data?.name || '';

      // Non-blocking: respond to Supabase now, sync in the background. A failure leaves
      // the stamp NULL and the hourly reconcile retries it.
      ctx.waitUntil((async () => {
        const ok = await syncToMailerLite(env, {
          email: record.email,
          fullName,
          optedInAt,
        });
        if (ok) {
          await markMailerLiteSynced(record.id, supabase);
          console.log(`MailerLite: synced ${record.id}`);
        } else {
          console.error(`MailerLite: sync failed for ${record.id}, hourly reconcile will retry`);
        }
      })());

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /api/account/delete - Authenticated. Body: { confirmEmail: string }
    // Permanently deletes the caller's account. Runs in passes because the Workers Free plan
    // allows 50 subrequests per invocation: each pass deletes up to 40 Cloudflare resources
    // and returns { done: false } until none are left. The dashboard repeats until done.
    // The final pass removes the MailerLite subscriber, storage files and the auth user.
    // Everything before the auth user delete is idempotent, so any failure is safe to retry.
    // Stripe records are kept on purpose (tax retention). credit_transactions survives
    // anonymized: its user_id is SET NULL by the foreign key.
    // Assumes fewer than 40 Cloudflare resources per event.
    if (pathname === '/api/account/delete' && method === 'POST') {
      const reply = (status: number, payload: Record<string, unknown>) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

      const token = extractToken(request.headers.get('authorization'));
      const userId = token ? await verifyJWT(token, env) : null;
      if (!userId) return reply(401, { error: 'Unauthorized' });

      const body = await request.json().catch(() => ({})) as { confirmEmail?: unknown };

      const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(userId);
      const authUser = authData?.user;
      if (authErr || !authUser?.email) {
        console.error('account/delete: could not load auth user', userId, authErr);
        return reply(500, { error: 'Could not load your account. Please try again.' });
      }

      // Server-side confirmation, so a stray or scripted call cannot delete anything.
      if (
        typeof body.confirmEmail !== 'string' ||
        body.confirmEmail.trim().toLowerCase() !== authUser.email.toLowerCase()
      ) {
        return reply(400, { error: 'Type your account email exactly to confirm.' });
      }

      const { data: events, error: eventsErr } = await supabase
        .from('events')
        .select('id, status, is_test, stream_state, stream_started_manually_at, live_input_id, recordings, merged_video_id')
        .eq('user_id', userId);
      if (eventsErr) {
        console.error('account/delete: events query failed', userId, eventsErr);
        return reply(500, { error: 'Could not load your events. Please try again.' });
      }

      // Never kill a stream mid-event or strand a paid event. Test events do not block.
      const blocking = (events || []).filter((e: any) => {
        if (e.is_test) return false;
        // A 'ready' event past its 24h streaming window is finished. The daily sweep
        // just has not flipped its status yet, so it must not block deletion.
        const windowExpired =
          e.status === 'ready' &&
          e.stream_state !== 'active' &&
          !!e.stream_started_manually_at &&
          Date.now() > new Date(e.stream_started_manually_at).getTime() + 24 * 60 * 60 * 1000;
        if (windowExpired) return false;
        return ['live', 'ready', 'scheduled'].includes(e.status) || e.stream_state === 'active';
      });
      if (blocking.length > 0) {
        return reply(409, {
          error: `You have ${blocking.length} live or upcoming event${blocking.length === 1 ? '' : 's'}. Cancel or finish ${blocking.length === 1 ? 'it' : 'them'} first, then delete your account.`,
        });
      }

      // --- Phase 1: Cloudflare Stream (live inputs and recorded videos), batched ---
      const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream`;
      const MAX_DELETES = 40;

      const byEvent = new Map<string, string[]>();
      const seen = new Set<string>();
      for (const e of events || []) {
        let recs: any[] = [];
        try {
          recs = typeof e.recordings === 'string' ? JSON.parse(e.recordings) : (e.recordings || []);
        } catch {
          recs = [];
        }
        const urls: string[] = [];
        const add = (url: string) => { if (!seen.has(url)) { seen.add(url); urls.push(url); } };
        if (e.live_input_id) add(`${CF_BASE}/live_inputs/${e.live_input_id}`);
        for (const r of recs) if (r?.uid) add(`${CF_BASE}/${r.uid}`);
        if (e.merged_video_id) add(`${CF_BASE}/${e.merged_video_id}`);
        if (urls.length > 0) byEvent.set(e.id, urls);
      }

      if (byEvent.size > 0) {
        // Whole events per pass, up to the delete budget.
        const batch: Array<[string, string[]]> = [];
        let used = 0;
        for (const entry of byEvent) {
          if (used > 0 && used + entry[1].length > MAX_DELETES) break;
          batch.push(entry);
          used += entry[1].length;
        }

        // A missing resource (404, or Cloudflare error 10009) counts as deleted.
        const deleteOne = async (url: string): Promise<boolean> => {
          try {
            const res = await fetch(url, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
            });
            const text = await res.text();
            if (res.ok || res.status === 404) return true;
            try {
              if (JSON.parse(text)?.errors?.[0]?.code === 10009) return true;
            } catch { /* not JSON */ }
            console.error('account/delete: Cloudflare delete failed', url, res.status, text);
            return false;
          } catch (err) {
            console.error('account/delete: Cloudflare delete threw', url, err);
            return false;
          }
        };

        const results = await Promise.all(
          batch.map(async ([eventId, urls]) => ({
            eventId,
            ok: (await Promise.all(urls.map(deleteOne))).every(Boolean),
          }))
        );
        const completed = results.filter(r => r.ok).map(r => r.eventId);

        if (completed.length > 0) {
          const { error: clearErr } = await supabase
            .from('events')
            .update({ live_input_id: null, recordings: [], merged_video_id: null })
            .in('id', completed);
          if (clearErr) {
            console.error('account/delete: could not record progress', userId, clearErr);
            return reply(500, { error: 'Could not remove your event media. Please try again.' });
          }
        }

        const remainingEvents = byEvent.size - completed.length;
        if (remainingEvents > 0) {
          // No progress means a real failure. Stop instead of looping forever.
          if (completed.length === 0) {
            return reply(502, { error: 'Could not remove some video files. Please try again.' });
          }
          return reply(200, { done: false, remaining: remainingEvents });
        }
      }

      // --- Phase 2: MailerLite subscriber ---
      try {
        const mlHeaders = {
          'Accept': 'application/json',
          'Authorization': `Bearer ${env.MAILERLITE_API_KEY}`,
        };
        const lookup = await fetch(
          `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(authUser.email)}`,
          { headers: mlHeaders }
        );
        if (lookup.status === 200) {
          const sub = await lookup.json() as { data?: { id?: string } };
          if (sub.data?.id) {
            const del = await fetch(`https://connect.mailerlite.com/api/subscribers/${sub.data.id}`, {
              method: 'DELETE',
              headers: mlHeaders,
            });
            await del.text();
            if (!del.ok && del.status !== 404) {
              console.error('account/delete: MailerLite delete failed', userId, del.status);
              return reply(502, { error: 'Could not remove your email subscription. Please try again.' });
            }
          }
        } else {
          await lookup.text();
          if (lookup.status !== 404) {
            console.error('account/delete: MailerLite lookup failed', userId, lookup.status);
            return reply(502, { error: 'Could not remove your email subscription. Please try again.' });
          }
        }
      } catch (err) {
        console.error('account/delete: MailerLite threw', userId, err);
        return reply(502, { error: 'Could not remove your email subscription. Please try again.' });
      }

      // --- Phase 3: Storage files (logo and covers live under {user_id}/) ---
      for (const bucket of ['logos', 'covers']) {
        const { data: files, error: listErr } = await supabase.storage.from(bucket).list(userId, { limit: 1000 });
        if (listErr) {
          console.error(`account/delete: list ${bucket} failed`, userId, listErr);
          return reply(500, { error: 'Could not remove your uploaded files. Please try again.' });
        }
        if (files && files.length > 0) {
          const { error: rmErr } = await supabase.storage
            .from(bucket)
            .remove(files.map((f: any) => `${userId}/${f.name}`));
          if (rmErr) {
            console.error(`account/delete: remove ${bucket} failed`, userId, rmErr);
            return reply(500, { error: 'Could not remove your uploaded files. Please try again.' });
          }
        }
      }

      // --- Phase 4: the account itself, last. Cascades to users, events, sessions, identities. ---
      const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
      if (delErr) {
        console.error('account/delete: deleteUser failed', userId, delErr);
        return reply(500, { error: 'Could not delete your account. Please try again.' });
      }

      console.log(`Account deleted: ${userId}`);
      return reply(200, { done: true });
    }

    // POST /api/marketing-optin - Authenticated. Body: { optIn: boolean }
    // Records the user's marketing choice (Google signups never saw the signup checkbox).
    // Opt-in: sync to MailerLite first, then write metadata. A MailerLite failure returns
    // 502 and changes nothing, so the user can simply retry.
    if (pathname === '/api/marketing-optin' && method === 'POST') {
      const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

      const token = extractToken(request.headers.get('authorization'));
      const userId = token ? await verifyJWT(token, env) : null;
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: jsonHeaders });
      }

      const body = await request.json().catch(() => ({})) as { optIn?: unknown };
      if (typeof body.optIn !== 'boolean') {
        return new Response(JSON.stringify({ error: 'optIn must be true or false' }), { status: 400, headers: jsonHeaders });
      }

      const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(userId);
      const authUser = authData?.user;
      if (authErr || !authUser?.email) {
        console.error('marketing-optin: could not load auth user', userId, authErr);
        return new Response(JSON.stringify({ error: 'Could not load account' }), { status: 500, headers: jsonHeaders });
      }
      const meta = authUser.user_metadata || {};

      let optedInAt: string | null = null;
      if (body.optIn) {
        optedInAt = new Date().toISOString();

        // An explicit click always upserts. The stamp only guards the automatic paths
        // (webhook and reconcile); it must never block a user who asks to be subscribed.
        const ok = await syncToMailerLite(env, {
          email: authUser.email,
          fullName: meta.full_name || meta.name || '',
          optedInAt,
        });
        if (!ok) {
          return new Response(JSON.stringify({ error: 'Could not subscribe right now. Please try again.' }), {
            status: 502, headers: jsonHeaders,
          });
        }
        await markMailerLiteSynced(userId, supabase);
      }

      const { error: updErr } = await supabase.auth.admin.updateUserById(userId, {
        user_metadata: { ...meta, marketing_opt_in: body.optIn, marketing_opt_in_at: optedInAt },
      });
      if (updErr) {
        console.error('marketing-optin: metadata update failed', userId, updErr);
        return new Response(JSON.stringify({ error: 'Could not save your choice. Please try again.' }), { status: 500, headers: jsonHeaders });
      }

      return new Response(JSON.stringify({ ok: true, optIn: body.optIn }), { status: 200, headers: jsonHeaders });
    }

    // POST /api/webhooks/cloudflare - Handle Cloudflare Stream webhooks
    if (pathname === '/api/webhooks/cloudflare' && method === 'POST') {
      const body = await request.json() as any;
      
      console.log('Webhook received:', JSON.stringify(body));
      
      // Cloudflare notifications payload structure:
      // { data: { event_type: "live_input.connected", input_id: "..." }, ... }
      const eventType = body.data?.event_type;
      const liveInputId = body.data?.input_id;
      
      console.log('Parsed event:', { eventType, liveInputId });
      
      if (!eventType || !liveInputId) {
        console.error('Missing event_type or input_id in webhook payload');
        return new Response(JSON.stringify({ 
          error: 'Invalid payload',
          received: body 
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      if (eventType === 'live_input.connected') {
        console.log('Processing live_input.connected for:', liveInputId);
        
        // Find event by live_input_id
        const { data: event, error } = await supabase
          .from('events')
          .select('id, slug, status, stream_started_manually_at, is_test')
          .eq('live_input_id', liveInputId)
          .single();
        
        if (error) {
          console.error('Error finding event:', error);
        }
        
        if (event) {
          // Test events have no stream_started_manually_at — that reads as
          // 1970 below and would delete the live input on first connect.
          // Exempt entirely; just record when this session actually
          // connected, for the 15-min cap cron to key off later.
          if (event.is_test) {
            // status/stream_state must match what showLive() in script.js
            // checks — same fields the real-event path sets a few lines down.
            await supabase
              .from('events')
              .update({
                status: 'live',
                stream_state: 'active',
                test_session_connected_at: new Date().toISOString(),
              })
              .eq('id', event.id);

            console.log(`Test event ${event.slug} connected`);

            return new Response(JSON.stringify({
              received: true,
              eventType,
              liveInputId,
              testEvent: true,
            }), {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          // Check if Live Input has expired (24 hours since start)
          const startedAt = new Date(event.stream_started_manually_at);
          const expiresAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
          const now = new Date();
          const isExpired = now > expiresAt;
          
          if (isExpired) {
            console.log(`⚠️ Event ${event.slug} Live Input has expired, deleting...`);
            
            // Delete Live Input immediately
            try {
              const deleteResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${liveInputId}`,
                {
                  method: 'DELETE',
                  headers: {
                    'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                  },
                }
              );
              
              const deleteResult = await deleteResponse.json() as any;
              
              if (deleteResult.success) {
                console.log(`🗑️ Deleted expired Live Input ${liveInputId} on connection attempt`);
              } else {
                console.error('Failed to delete Live Input:', deleteResult.errors);
              }
            } catch (err) {
              console.error('Error deleting Live Input:', err);
            }
            
            // Update event status if not already ended
            if (event.status !== 'ended') {
              await supabase
                .from('events')
                .update({
                  status: 'ended',
                  stream_state: 'disconnected',
                })
                .eq('id', event.id);
              
              console.log(`✅ Event ${event.slug} status updated to ended`);
            }
            
            return new Response(JSON.stringify({ 
              received: true, 
              eventType, 
              liveInputId,
              expired: true,
              deleted: true,
              message: 'Live Input has expired and been deleted'
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
          
          // Lock down the in-progress recording so share/embed behave during the live
          // broadcast. If the recording doesn't exist yet at connect time, the
          // disconnect handler below catches it.
          await lockDownInputRecordings(liveInputId, event.slug, env);

          if (event.status !== 'live') {
            console.log('Updating event to live:', event.slug);
            // Update to live
            const { error: updateError } = await supabase
              .from('events')
              .update({
                status: 'live',
                stream_state: 'active',
                stream_started_at: new Date().toISOString(),
                last_stream_activity: new Date().toISOString()
              })
              .eq('id', event.id);
            
            if (updateError) {
              console.error('Error updating event:', updateError);
            } else {
              console.log(`✅ Event ${event.slug} is now live`);
            }
          } else {
            console.log('Event already live, updating last_stream_activity');
            // Already live, just update activity timestamp
            const { error: updateError } = await supabase
              .from('events')
              .update({
                last_stream_activity: new Date().toISOString()
              })
              .eq('id', event.id);
            
            if (updateError) {
              console.error('Error updating last_stream_activity:', updateError);
            }
          }
        } else {
          console.error('No event found with live_input_id:', liveInputId);
        }
      }
      
      if (eventType === 'live_input.disconnected') {
        console.log('Processing live_input.disconnected for:', liveInputId);
        
        const { data: event } = await supabase
          .from('events')
          .select('id, slug, status, stream_started_manually_at, is_test, test_sessions_today, test_sessions_day, recordings')
          .eq('live_input_id', liveInputId)
          .single();
        
        if (event) {
          console.log('Found event:', event.slug, 'current status:', event.status);
          
          // Test events never expire and never get marked 'ended' — they're
          // reused indefinitely. Just clear the session timer so the cap
          // cron stops tracking a session that already ended.
          if (event.is_test) {
            // A real disconnect only fires here after a real connect — this
            // is where the daily count and cooldown clock actually start.
            const { sessionsToday, sessionsDay } = incrementDailyTestSessionCount(
              event.test_sessions_today,
              event.test_sessions_day
            );

            // Snapshot recordings so watch-page replay works and syncViewerHours can meter
            // test views. null means the Cloudflare fetch failed: keep the stored list as is.
            const knownTestUids = new Set<string>(
              (typeof event.recordings === 'string' ? JSON.parse(event.recordings) : event.recordings || [])
                .map((r: any) => r.uid)
            );
            const testSnapshot = await snapshotTestRecordings(liveInputId, event.slug, knownTestUids, env);
            const testRecordingsUpdate = testSnapshot ? { recordings: testSnapshot } : {};

            // Revert to the idle/countdown state — never 'ended', reusable
            // indefinitely, but must not stay 'live' or the watch page shows
            // a dead stream as still live until the next connect.
            await supabase
              .from('events')
              .update({
                status: 'scheduled',
                stream_state: 'inactive',
                ...testRecordingsUpdate,
                test_session_connected_at: null,
                test_session_last_ended_at: new Date().toISOString(),
                test_sessions_today: sessionsToday,
                test_sessions_day: sessionsDay,
              })
              .eq('id', event.id);

            console.log(`Test event ${event.slug} disconnected`);

            return new Response(JSON.stringify({
              received: true,
              eventType,
              liveInputId,
              testEvent: true,
            }), {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
          
          // Check if 24 hours have passed since "Start Streaming" was clicked
          const startedAt = new Date(event.stream_started_manually_at);
          const expiresAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
          const now = new Date();
          const isExpired = now > expiresAt;
          
          if (isExpired) {
            console.log(`⏰ Event ${event.slug} has expired (24h passed)`);
            
            // Fetch all recordings from this Live Input BEFORE deleting
            let recordings: any[] = [];
            try {
              const recordingsResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${liveInputId}/videos`,
                {
                  headers: {
                    'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                  },
                }
              );
              
              const recordingsData = await recordingsResponse.json() as any;
              
              if (recordingsData.success && recordingsData.result) {
                recordings = recordingsData.result.map((video: any) => ({
                  uid: video.uid,
                  status: video.status?.state,
                  duration: video.duration,
                  created: video.created,
                  thumbnail: video.thumbnail
                }));
                console.log(`✅ Fetched ${recordings.length} recordings to preserve`);
              }
            } catch (err) {
              console.error('Error fetching recordings before deletion:', err);
            }
            
            // Final pass: recordings must be locked down before the Live Input is deleted
            await lockDownRecordings(recordings.map((r: any) => r.uid).filter(Boolean), event.slug, env);

            // Save recordings to database and update status to 'ended'
            const { error: updateError } = await supabase
              .from('events')
              .update({
                status: 'ended',
                stream_state: 'disconnected',
                recordings: recordings,
                last_stream_activity: new Date().toISOString()
              })
              .eq('id', event.id);
            
            if (updateError) {
              console.error('Error updating expired event:', updateError);
            } else {
              console.log(`✅ Event ${event.slug} ended and ${recordings.length} recordings saved`);
            }
            
            // Delete Live Input in Cloudflare
            try {
              const deleteResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${liveInputId}`,
                {
                  method: 'DELETE',
                  headers: {
                    'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                  },
                }
              );
              
              const deleteResult = await deleteResponse.json() as any;
              
              if (deleteResult.success) {
                console.log(`🗑️ Deleted expired Live Input ${liveInputId} (recordings preserved in database)`);
              } else {
                console.error('Failed to delete Live Input:', deleteResult.errors);
              }
            } catch (err) {
              console.error('Error deleting Live Input:', err);
            }
          } else {
            // Within 24-hour window - fetch new recordings, merge with existing, keep status 'ready'
            let newRecordings: any[] = [];
            try {
              const recordingsResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${liveInputId}/videos`,
                {
                  headers: {
                    'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                  },
                }
              );
              
              const recordingsData = await recordingsResponse.json() as any;
              
              if (recordingsData.success && recordingsData.result) {
                newRecordings = recordingsData.result.map((video: any) => ({
                  uid: video.uid,
                  status: video.status?.state,
                  duration: video.duration,
                  created: video.created,
                  thumbnail: video.thumbnail
                }));
                console.log(`✅ Fetched ${newRecordings.length} recordings on mid-session disconnect`);
              }
            } catch (err) {
              console.error('Error fetching recordings on disconnect:', err);
            }

            // Merge: fetch existing recordings, deduplicate by uid, then save
            const { data: currentEvent } = await supabase
              .from('events')
              .select('recordings')
              .eq('id', event.id)
              .single();
            
            const existingRecordings: any[] = currentEvent?.recordings || [];
            const existingUids = new Set(existingRecordings.map((r: any) => r.uid));
            const merged = [
              ...existingRecordings,
              ...newRecordings.filter((r: any) => !existingUids.has(r.uid))
            ];

            // Only recordings we haven't seen before need locking down
            await lockDownRecordings(
              newRecordings.filter((r: any) => !existingUids.has(r.uid)).map((r: any) => r.uid),
              event.slug,
              env
            );

            const { error: updateError } = await supabase
              .from('events')
              .update({
                status: 'ready',
                stream_state: 'disconnected',
                recordings: merged,
                last_stream_activity: new Date().toISOString()
              })
              .eq('id', event.id);
            
            if (updateError) {
              console.error('Error updating event on disconnect:', updateError);
            } else {
              const timeLeft = Math.round((expiresAt.getTime() - now.getTime()) / (1000 * 60));
              console.log(`✅ Event ${event.slug} disconnected (${timeLeft} min left, ${merged.length} recordings saved, can reconnect)`);
            }
          }
        } else {
          console.error('No event found with live_input_id:', liveInputId);
        }
      }
      
      return new Response(JSON.stringify({ received: true, eventType, liveInputId }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // POST /api/events - Create event
    if (pathname === '/api/events' && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const body = await request.json() as CreateEventRequest;

      // Validate input — now requires scheduledDateTime + timezone
      if (!body.title || !body.scheduledDateTime) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields: title, scheduledDateTime' }), // timezone is optional (defaults to Pacific)
          { status: 400, headers: corsHeaders }
        );
      }

      // Default timezone to Pacific if not provided (backward compat)
      const eventTimezone = body.timezone || 'America/Los_Angeles';

      if (!isValidTimezone(eventTimezone)) {
        return new Response(JSON.stringify({ error: 'Invalid timezone' }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      // Convert photographer's local datetime to UTC for storage
      // e.g. "2026-04-04T16:00" + "America/Los_Angeles" → "2026-04-04T23:00:00.000Z"
      const scheduledDateUtc = localDateTimeToUTC(body.scheduledDateTime, eventTimezone);

      // Check user credits
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('credits')
        .eq('id', userId)
        .single();

      if (userError || !user || user.credits < 1) {
        return new Response(
          JSON.stringify({ error: 'Insufficient credits' }),
          { status: 402, headers: corsHeaders }
        );
      }

      // Create Cloudflare Live Input
      const cfResult = await createCloudflareStreamLiveInput(body.title, env);
      if (!cfResult) {
        return new Response(
          JSON.stringify({ error: 'Failed to create live input' }),
          { status: 500, headers: corsHeaders }
        );
      }

      // Resolve slug: clean if free, 3-char suffix if held (see resolveSlug)
      const slug = await resolveSlug(body.title, supabase);

      // Generate QR code for the watch page URL (once, stored forever)
      const watchUrl = `https://go.momentcast.live/${slug}`;
      const qrCodeDataUrl = generateQrDataUrl(watchUrl);

      // Create event — scheduled_date stores UTC, timezone stores the event's local tz
      const eventInsertPayload = {
        user_id: userId,
        slug,
        title: body.title,
        scheduled_date: scheduledDateUtc,
        timezone: eventTimezone,  // Stored so watch page can display in correct tz
        live_input_id: cfResult.liveInputId,
        rtmps_url: cfResult.rtmpsUrl,
        rtmps_key: cfResult.rtmpsKey,
        tier: body.tier || 'standard',
        viewer_hour_limit: MINUTES_PER_CREDIT, // one credit's viewing, stored in minutes
        qr_code_data_url: qrCodeDataUrl, // base64 SVG for watch page sharing
      };

      let { data: event, error: createError } = await supabase
        .from('events')
        .insert(eventInsertPayload)
        .select()
        .single();

      // resolveSlug() checks for a held slug just before this insert, but two events created
      // in the same instant can both see it as free, and the `slug` column is globally unique.
      // The loser lands here. Retry up to 3 times, each with a fresh random suffix on the
      // original slug, instead of surfacing a 500.
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (createError?.code !== '23505' || !createError?.message?.includes('events_slug_key')) break;

        const retrySlug = `${slug}-${randomSuffix()}`;
        console.warn(`Slug collision at insert (attempt ${attempt}), retrying with:`, retrySlug);
        eventInsertPayload.slug = retrySlug;
        // QR was generated against the colliding slug, so regenerate it
        // so the stored/shared QR points at the real watch URL, not a dead one.
        eventInsertPayload.qr_code_data_url = generateQrDataUrl(`https://go.momentcast.live/${retrySlug}`);

        const retry = await supabase
          .from('events')
          .insert(eventInsertPayload)
          .select()
          .single();

        event = retry.data;
        createError = retry.error;
      }

      if (createError) {
        console.error('Event creation error:', createError);
        return new Response(
          JSON.stringify({ error: 'Failed to create event' }),
          { status: 500, headers: corsHeaders }
        );
      }

      // Decrement credits
      await supabase
        .from('users')
        .update({ credits: user.credits - 1 })
        .eq('id', userId);

      // Log credit transaction
      await supabase.from('credit_transactions').insert({
        user_id: userId,
        amount: -1,
        type: 'event_created',
        event_id: event.id,
      });

      const response: CreateEventResponse = {
        eventId: event.id,
        slug: event.slug,
        watchUrl: `https://go.momentcast.live/${event.slug}`,
        liveInputId: cfResult.liveInputId,
        rtmpsUrl: cfResult.rtmpsUrl,
        rtmpsKey: cfResult.rtmpsKey,
      };

      return new Response(JSON.stringify(response), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

        // GET /api/test-event - Fetch (or lazily create) the user's permanent test event
    if (pathname === '/api/test-event' && method === 'GET') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: corsHeaders });
      }

      const { event, error } = await getOrCreateTestEvent(userId, env, supabase);
      if (error || !event) {
        return new Response(JSON.stringify({ error: error || 'Failed to load test event' }), { status: 500, headers: corsHeaders });
      }

      const todayUtcGet = new Date().toISOString().slice(0, 10);
      const usedTodayGet = event.test_sessions_day === todayUtcGet ? event.test_sessions_today : 0;

      return new Response(JSON.stringify({
        eventId: event.id,
        slug: event.slug,
        liveInputId: event.live_input_id,
        watchUrl: `https://go.momentcast.live/${event.slug}`,
        rtmpsUrl: event.rtmps_url,
        rtmpsKey: event.rtmps_key,
        armedAt: event.test_session_armed_at,
        connectedAt: event.test_session_connected_at,
        sessionsRemainingToday: Math.max(0, 3 - usedTodayGet),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // POST /api/test-event/start - Arm the test event: enable the Live Input, no time gate
    if (pathname === '/api/test-event/start' && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: corsHeaders });
      }

      const { event, error } = await getOrCreateTestEvent(userId, env, supabase);
      if (error || !event) {
        return new Response(JSON.stringify({ error: error || 'Failed to load test event' }), { status: 500, headers: corsHeaders });
      }

      // Cooldown: 15 minutes since the last session ended
      const COOLDOWN_MS = 15 * 60 * 1000;
      if (event.test_session_last_ended_at) {
        const elapsed = Date.now() - new Date(event.test_session_last_ended_at).getTime();
        if (elapsed < COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
          return new Response(JSON.stringify({
            error: 'Please wait before starting another test session',
            retryAfterSeconds,
          }), { status: 429, headers: corsHeaders });
        }
      }

      // Daily cap: 3 sessions per UTC day, resets automatically on date change
      const todayUtc = new Date().toISOString().slice(0, 10);
      const sessionsToday = event.test_sessions_day === todayUtc ? event.test_sessions_today : 0;
      const DAILY_LIMIT = 3;
      if (sessionsToday >= DAILY_LIMIT) {
        const tomorrowUtc = new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString();
        return new Response(JSON.stringify({
          error: 'Daily test limit reached (3 sessions)',
          resetsAt: tomorrowUtc,
        }), { status: 429, headers: corsHeaders });
      }

      // Re-enable in case a prior session was capped or manually stopped
      try {
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
            // Test events always lock live playback and their recordings (signed tokens only).
            // Sent on every start, so test inputs created before locking existed get it too.
            body: JSON.stringify({ enabled: true, recording: liveInputRecordingSettings('automatic', true) }),
          }
        );
      } catch (err) {
        console.error('Failed to enable test Live Input:', err);
        return new Response(JSON.stringify({ error: 'Failed to arm test event' }), { status: 500, headers: corsHeaders });
      }

      // Counting and the cooldown both happen when a *connected* session
      // ends, not here — arming alone shouldn't cost anything.
      await supabase.from('events').update({
        test_session_armed_at: new Date().toISOString(),
      }).eq('id', event.id);

      return new Response(JSON.stringify({
        eventId: event.id,
        slug: event.slug,
        liveInputId: event.live_input_id,
        watchUrl: `https://go.momentcast.live/${event.slug}`,
        rtmpsUrl: event.rtmps_url,
        rtmpsKey: event.rtmps_key,
        armedAt: new Date().toISOString(),
        sessionsRemainingToday: Math.max(0, 3 - sessionsToday),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // POST /api/test-event/stop - Disable the Live Input (kicks any active connection), clear session state
    if (pathname === '/api/test-event/stop' && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
      }
      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: corsHeaders });
      }

      const { data: event } = await supabase
        .from('events')
        .select('id, live_input_id, test_session_connected_at, test_sessions_today, test_sessions_day')
        .eq('user_id', userId)
        .eq('is_test', true)
        .maybeSingle();

      if (!event) {
        return new Response(JSON.stringify({ error: 'No test event found' }), { status: 404, headers: corsHeaders });
      }

      try {
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
            body: JSON.stringify({ enabled: false }),
          }
        );
      } catch (err) {
        console.error('Failed to disable test Live Input:', err);
      }

      // Only a session that actually connected costs a daily count or a
      // cooldown. Stopping something that was armed but never streamed to
      // is a free cancel.
      const wasConnected = !!event.test_session_connected_at;
      const updatePayload: Record<string, any> = {
        status: 'scheduled',
        stream_state: 'inactive',
        test_session_armed_at: null,
        test_session_connected_at: null,
      };

      if (wasConnected) {
        const { sessionsToday, sessionsDay } = incrementDailyTestSessionCount(
          event.test_sessions_today,
          event.test_sessions_day
        );
        updatePayload.test_session_last_ended_at = new Date().toISOString();
        updatePayload.test_sessions_today = sessionsToday;
        updatePayload.test_sessions_day = sessionsDay;
      }

      await supabase.from('events').update(updatePayload).eq('id', event.id);

      return new Response(JSON.stringify({ stopped: true, counted: wasConnected }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // GET /api/events/:slug - Get event details (public)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+$/) && method === 'GET') {
      const slug = pathname.split('/').pop();

      const { data: event, error } = await supabase
        .from('events')
        .select('id, user_id, title, scheduled_date, timezone, status, stream_state, live_input_id, recordings, merged_video_id, viewer_minutes_consumed, viewer_hour_limit, stream_started_manually_at, last_stream_activity, qr_code_data_url, cover_image_url, is_test, is_demo, recordings_expire_at')
        .eq('slug', slug)
        .single();

      if (error || !event) {
        return new Response(
          JSON.stringify({ error: 'Event not found' }),
          { status: 404, headers: corsHeaders }
        );
      }

      // Check if 24-hour streaming window has expired
      if (event.stream_started_manually_at && event.status !== 'ended') {
        const startedAt = new Date(event.stream_started_manually_at);
        const expiresAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
        const now = new Date();
        const isExpired = now > expiresAt;

        if (isExpired) {
          console.log(`⏰ Event ${slug} has expired on GET request, updating to ended`);
          
          // Fetch all recordings from this Live Input BEFORE potential deletion
          let recordings: any[] = [];
          if (event.live_input_id) {
            try {
              const recordingsResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}/videos`,
                {
                  headers: {
                    'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                  },
                }
              );
              
              const recordingsData = await recordingsResponse.json() as any;
              
              if (recordingsData.success && recordingsData.result) {
                recordings = recordingsData.result.map((video: any) => ({
                  uid: video.uid,
                  status: video.status?.state,
                  duration: video.duration,
                  created: video.created,
                  thumbnail: video.thumbnail,
                  playback: {
                    hls: video.playback?.hls,
                    dash: video.playback?.dash
                  },
                  readyToStream: video.readyToStream,
                  state: video.status
                }));
                console.log(`✅ Fetched ${recordings.length} recordings to preserve`);
              }
            } catch (err) {
              console.error('Error fetching recordings before expiration update:', err);
            }
          }
          
          // Lock down late recordings before the event flips to ended
          await lockDownRecordings(recordings.map((r: any) => r.uid).filter(Boolean), slug as string, env);

          // Update event to ended status
          const { error: updateError } = await supabase
            .from('events')
            .update({
              status: 'ended',
              stream_state: 'disconnected',
              recordings: recordings,
              last_stream_activity: new Date().toISOString()
            })
            .eq('id', event.id);
          
          if (updateError) {
            console.error('Error updating expired event:', updateError);
          } else {
            console.log(`✅ Event ${slug} status updated to ended with ${recordings.length} recordings`);
            // Update local event object to reflect changes
            event.status = 'ended';
            event.stream_state = 'disconnected';
            event.recordings = recordings;
          }
        }
      }

      // Fetch recordings from Cloudflare Stream if event is ready or ended
      let recordings = event.recordings || []; // Use stored recordings as fallback
      
      // Replay expiry is decided by events.recordings_expire_at (isReplayExpired), never by
      // event age. Once expired, the server stops handing out recordings at all, so the
      // watch page's EXPIRED screen is not the only thing standing between a guest and a replay.
      const replayExpired = isReplayExpired(event);

      // Test rows have no meaningful age (scheduled_date is the row's creation time) and
      // Cloudflare's list only returns recordings that still exist, so refetch whenever
      // the test is not live.
      const refetchTestRecordings = !!event.is_test && event.status !== 'live' && !!event.live_input_id;

      if (refetchTestRecordings || ((event.status === 'ready' || event.status === 'ended') && event.live_input_id && !replayExpired)) {
        try {
          const recordingsResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}/videos`,
            {
              headers: {
                'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
              },
            }
          );

          const recordingsData = await recordingsResponse.json() as any;
          
          if (recordingsData.success && recordingsData.result) {
            recordings = recordingsData.result.map((video: any) => ({
              uid: video.uid,
              status: video.status?.state,
              duration: video.duration,
              created: video.created,
              thumbnail: video.thumbnail,
              playback: {
                hls: video.playback?.hls,
                dash: video.playback?.dash
              }
            }));
            // Save any recording the event's list is missing (rare, so this rarely writes).
            // Runs after the response so guests never wait on it. Test events manage their own list.
            if (!event.is_test && !event.is_demo) {
              ctx.waitUntil(saveMissingRecordings(
                { id: event.id, slug: slug as string, live_input_id: event.live_input_id },
                env, supabase, recordingsData.result
              ));
            }
            // The Live Input only lists what was streamed. Keep stored entries marked
            // source: 'upload' (future streamer uploads) so a refetch never drops them.
            const uploads = (event.recordings || []).filter((r: any) => r?.source === 'upload');
            recordings = [...recordings, ...uploads];
          }
        } catch (err) {
          console.error('Error fetching recordings:', err);
          // Fall back to stored recordings in database if fetch fails
        }
      }

      // Expired replays expose nothing. Checked after the refetch so no path can re-add them.
      if (replayExpired) recordings = [];

      // Test events expose only their newest recording. Older ones stay stored until
      // Cloudflare deletes them but are never linked from the watch page.
      if (event.is_test && Array.isArray(recordings)) {
        recordings = [...recordings]
          .sort((a: any, b: any) => new Date(b.created).getTime() - new Date(a.created).getTime())
          .slice(0, 1);
      }

      // Check if viewer limit exceeded (only applies to live/replay viewing).
      // Both sides in MINUTES: viewer_minutes_consumed (exact, from the sync) and
      // viewer_hour_limit (MINUTES despite its name; MINUTES_PER_CREDIT per credit).
      const viewerMinutesConsumed = Number(event.viewer_minutes_consumed) || 0;
      const viewerLimitMinutes = event.viewer_hour_limit || MINUTES_PER_CREDIT; // fallback for a null limit only
      // Demo events (is_demo) are the marketing showcase and never hit the viewer limit.
      const limitExceeded = !event.is_demo && viewerMinutesConsumed >= viewerLimitMinutes;

      // Signed playback tokens, keyed by video / live input ID. Issued only to guests the
      // viewer limit admits; replayExpired already emptied the recordings. A guest admitted
      // earlier keeps the tokens they already have (the watch page remembers them) until
      // they expire after PLAYBACK_TOKEN_TTL_HOURS, but receives no new ones.
      const playbackTokens: Record<string, string> = {};
      if (!limitExceeded) {
        const ids = [
          ...(event.live_input_id ? [event.live_input_id as string] : []),
          ...(Array.isArray(recordings) ? recordings.map((r: any) => r?.uid).filter(Boolean) : []),
        ];
        try {
          for (const id of ids) playbackTokens[id] = await signPlaybackToken(id, env);
        } catch (err) {
          // Unsigned videos still play from their plain ID, so a signing failure must not
          // take the page down. Locked videos fail to play until signing works again.
          console.error('Failed to sign playback tokens:', err);
        }
      }

      // Fetch photographer's logo from users table
      let logoUrl: string | null = null;
      try {
        const { data: ownerData } = await supabase
          .from('users')
          .select('logo_url')
          .eq('id', (event as any).user_id)
          .single();
        logoUrl = ownerData?.logo_url || null;
      } catch (err) {
        console.error('Error fetching user logo:', err);
      }

      return new Response(JSON.stringify({
        ...event,
        recordings, // Override with fresh data from Cloudflare
        limitExceeded,
        replayExpired, // The watch page shows EXPIRED from this flag, not its own date math
        playbackHost: STREAM_PLAYBACK_HOST,
        playbackTokens,
        logo_url: logoUrl,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /api/events/:slug/start-streaming - Start streaming window (authenticated)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/start-streaming$/) && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const slug = pathname.split('/')[3];

      // Get event
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('*')
        .eq('slug', slug)
        .eq('user_id', userId)
        .single();

      if (getError || !event) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Use /api/test-event/start for test events' }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      // Demo events play uploaded videos and must never open a streaming window.
      if (event.is_demo) {
        return new Response(JSON.stringify({ error: 'Demo events cannot be streamed to' }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      // Check if already started
      if (event.stream_credentials_revealed) {
        const startedAt = new Date(event.stream_started_manually_at);
        const expiresAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
        const now = new Date();
        const isExpired = now > expiresAt;
        
        if (isExpired) {
          console.log(`⏰ Event ${event.slug} has expired on start-streaming attempt, updating to ended`);
          
          // Fetch all recordings from this Live Input before returning error
          let recordings: any[] = [];
          if (event.live_input_id) {
            try {
              const recordingsResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}/videos`,
                {
                  headers: {
                    'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
                  },
                }
              );
              
              const recordingsData = await recordingsResponse.json() as any;
              
              if (recordingsData.success && recordingsData.result) {
                recordings = recordingsData.result.map((video: any) => ({
                  uid: video.uid,
                  status: video.status?.state,
                  duration: video.duration,
                  created: video.created,
                  thumbnail: video.thumbnail,
                  playback: {
                    hls: video.playback?.hls,
                    dash: video.playback?.dash
                  },
                  readyToStream: video.readyToStream,
                  state: video.status
                }));
                console.log(`✅ Fetched ${recordings.length} recordings for expired event`);
              }
            } catch (err) {
              console.error('Error fetching recordings on expiration:', err);
            }
          }
          
          // Update event to ended status if not already
          if (event.status !== 'ended') {
            const { error: updateError } = await supabase
              .from('events')
              .update({
                status: 'ended',
                stream_state: 'disconnected',
                recordings: recordings,
                last_stream_activity: new Date().toISOString()
              })
              .eq('id', event.id);
            
            if (updateError) {
              console.error('Error updating expired event:', updateError);
            } else {
              console.log(`✅ Event ${event.slug} status updated to ended`);
            }
          }
          
          return new Response(JSON.stringify({ 
            error: 'Streaming window has expired',
            expired: true,
            startedAt: event.stream_started_manually_at,
            expiresAt: expiresAt.toISOString(),
            message: 'The 24-hour streaming window has expired. This event can no longer accept new streams.'
          }), {
            status: 410, // 410 Gone
            headers: corsHeaders,
          });
        }
        
        return new Response(JSON.stringify({ 
          message: 'Streaming has already been started',
          credentials: {
            rtmpsUrl: event.rtmps_url,
            rtmpsKey: event.rtmps_key,
            liveInputId: event.live_input_id
          },
          startedAt: event.stream_started_manually_at,
          expiresAt: expiresAt.toISOString(),
          expired: false
        }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      // Lock live playback before the first stream (signed tokens only). Covers live inputs
      // created before locking existed. Best effort: if it fails, the event still streams,
      // just unlocked, so it must never block Start Streaming.
      if (event.live_input_id) {
        try {
          const lockRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
              body: JSON.stringify({ recording: liveInputRecordingSettings('automatic', LOCK_LIVE_PLAYBACK_FOR_REAL_EVENTS) }),
            }
          );
          if (!lockRes.ok) console.error(`Live input lock failed for ${event.slug} (${lockRes.status}):`, await lockRes.text());
        } catch (err) {
          console.error(`Live input lock threw for ${event.slug}:`, err);
        }
      }

      // Mark credentials as revealed and record start time
      const startTime = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('events')
        .update({
          status: 'ready',  // New status: credentials revealed, waiting for stream
          stream_credentials_revealed: true,
          stream_started_manually_at: startTime,
          last_stream_activity: startTime,
          can_be_rescheduled: false
        })
        .eq('id', event.id);

      if (updateError) {
        console.error('Failed to update event:', updateError);
        return new Response(JSON.stringify({ error: 'Failed to start streaming' }), {
          status: 500,
          headers: corsHeaders,
        });
      }

      return new Response(JSON.stringify({
        message: 'Streaming started successfully',
        credentials: {
          rtmpsUrl: event.rtmps_url,
          rtmpsKey: event.rtmps_key,
          liveInputId: event.live_input_id
        },
        startedAt: startTime,
        expiresAt: new Date(new Date(startTime).getTime() + 24 * 60 * 60 * 1000).toISOString()
      }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // PATCH /api/events/:slug/reschedule - Reschedule event date (authenticated)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/reschedule$/) && method === 'PATCH') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const slug = pathname.split('/')[3];
      const body = await request.json() as any;
      const { newDateTime, timezone: newTimezone } = body;

      // Accept either new format (newDateTime + timezone) or legacy (newDate)
      if (!newDateTime && !body.newDate) {
        return new Response(JSON.stringify({ error: 'New date/time is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Convert to UTC if new format, otherwise treat as legacy date string
      let scheduledDateUtc: string;
      let eventTimezone: string | undefined;

      if (newDateTime) {
        // New format: "2026-04-04T16:00" + "America/Los_Angeles"
        // Plain string type: newTimezone comes from an `any` body, so assigning it straight
        // to the `string | undefined` eventTimezone would not narrow it for the calls below.
        const tzForCalc: string = newTimezone || 'America/Los_Angeles';
        if (!isValidTimezone(tzForCalc)) {
          return new Response(JSON.stringify({ error: 'Invalid timezone' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        eventTimezone = tzForCalc;
        scheduledDateUtc = localDateTimeToUTC(newDateTime, tzForCalc);
      } else {
        // Legacy format: "2026-04-04" (backward compat)
        scheduledDateUtc = body.newDate;
      }

      // Get event
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('*')
        .eq('slug', slug)
        .eq('user_id', userId)
        .single();

      if (getError || !event) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Test events cannot be rescheduled' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Check if event can be rescheduled
      if (!event.can_be_rescheduled) {
        return new Response(JSON.stringify({ 
          error: 'Event cannot be rescheduled. Streaming has already been started.' 
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Check if event is already ended
      if (event.status === 'ended') {
        return new Response(JSON.stringify({ error: 'Cannot reschedule ended events' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Update the scheduled date (and timezone if provided)
      const updateFields: any = { 
        scheduled_date: scheduledDateUtc,
        updated_at: new Date().toISOString()
      };
      if (eventTimezone) {
        updateFields.timezone = eventTimezone;
      }

      const { data: updatedEvent, error: updateError } = await supabase
        .from('events')
        .update(updateFields)
        .eq('id', event.id)
        .select()
        .single();

      if (updateError) {
        console.error('Error updating event date:', updateError);
        return new Response(JSON.stringify({ error: 'Failed to update event date' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`✅ Event ${slug} rescheduled from ${event.scheduled_date} to ${scheduledDateUtc}`);

      return new Response(JSON.stringify({ 
        success: true,
        event: updatedEvent 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // POST /api/events/:slug/cancel - Cancel event and refund credit (authenticated, pre-stream only)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/cancel$/) && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const slug = pathname.split('/')[3];

      // Get event
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('*')
        .eq('slug', slug)
        .eq('user_id', userId)
        .single();

      if (getError || !event) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Test events cannot be cancelled' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Guard: only allow cancellation if streaming hasn't started
      if (event.stream_credentials_revealed) {
        return new Response(JSON.stringify({ 
          error: 'Cannot cancel after streaming credentials have been revealed' 
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Guard: don't cancel already-cancelled or ended events
      if (event.status === 'cancelled' || event.status === 'ended') {
        return new Response(JSON.stringify({ 
          error: `Event is already ${event.status}` 
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // 1. Delete the Cloudflare Live Input (free up dashboard clutter)
      if (event.live_input_id) {
        try {
          const deleteResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
              },
            }
          );
          const deleteResult = await deleteResponse.json() as any;
          if (deleteResult.success) {
            console.log(`🗑️ Deleted Live Input for cancelled event: ${slug}`);
          } else {
            console.error(`Failed to delete Live Input for ${slug}:`, deleteResult.errors);
          }
        } catch (err) {
          console.error(`Error deleting Live Input for ${slug}:`, err);
          // Continue with cancellation even if CF delete fails
        }
      }

      // 2. Update event status to cancelled and release the slug immediately.
      // A cancelled event never streamed (credentials were never revealed), so no
      // replay exists and there is nothing for the 90-day cooldown to protect.
      // Same tombstone format as release_expired_slugs(); the daily cleanup pass
      // deletes the cover file using original_slug.
      const { error: updateError } = await supabase
        .from('events')
        .update({
          status: 'cancelled',
          stream_state: 'inactive',
          live_input_id: null,  // Clear since we deleted it
          original_slug: event.slug,
          slug: `released_${event.id}`,
          slug_released_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', event.id);

      if (updateError) {
        console.error('Error cancelling event:', updateError);
        return new Response(JSON.stringify({ error: 'Failed to cancel event' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // 3. Refund ALL credits spent on this event (initial creation + any top-ups)
      const { data: eventTransactions } = await supabase
        .from('credit_transactions')
        .select('amount')
        .eq('event_id', event.id)
        .in('type', ['event_created', 'event_topup']);

      // Sum the absolute values of all deductions for this event
      const creditsToRefund = (eventTransactions || []).reduce(
        (sum: number, tx: { amount: number }) => sum + Math.abs(tx.amount), 0
      );

      if (creditsToRefund < 1) {
        console.warn(`Cancel ${slug}: no credit transactions found, defaulting to 1`);
      }

      const refundAmount = Math.max(creditsToRefund, 1); // At least 1 credit

      const { data: user } = await supabase
        .from('users')
        .select('credits')
        .eq('id', userId)
        .single();

      if (user) {
        await supabase
          .from('users')
          .update({ credits: user.credits + refundAmount })
          .eq('id', userId);
      }

      // 4. Log the refund transaction
      await supabase.from('credit_transactions').insert({
        user_id: userId,
        amount: refundAmount,
        type: 'event_cancelled',
        event_id: event.id,
      });

      console.log(`✅ Event ${slug} cancelled, ${refundAmount} credit(s) refunded to user ${userId}`);

      return new Response(JSON.stringify({ 
        success: true,
        creditsRefunded: refundAmount,
        message: `Event cancelled. ${refundAmount} credit(s) returned to your balance.`
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    /**
     * POST /api/events/:slug/add-credits — Add viewing hours to an existing event (authenticated)
     * 
     * Deducts 1 credit from user balance and adds MINUTES_PER_CREDIT (250 viewing hours)
     * to the event's viewer_hour_limit. Works on live, scheduled, or ready events.
     * 
     * Body: {} (no body needed, always adds 1 credit worth)
     * Returns: { newLimit, creditsRemaining }
     */
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/add-credits$/) && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: corsHeaders,
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401, headers: corsHeaders,
        });
      }

      const slug = pathname.split('/')[3];

      // Verify ownership. Status, expiry and test checks happen below.
      const { data: event, error: eventError } = await supabase
        .from('events')
        .select('id, slug, user_id, status, viewer_hour_limit, is_test, is_demo, recordings, recordings_expire_at')
        .eq('slug', slug)
        .single();

      if (eventError || !event) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Not your event' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Test events have their own fixed rolling cap and never take credits.
      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Test events cannot take viewing hours' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Cancelled events never streamed and their link is already released.
      if (event.status === 'cancelled') {
        return new Response(JSON.stringify({ error: 'Cannot add viewing hours to a cancelled event' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Ended events keep serving replay until recordings_expire_at (isReplayExpired), so
      // top-ups stay open exactly as long as there is a replay to watch, including after a
      // paid storage extension. Released slugs never reach this route: the released_<id>
      // placeholder contains an underscore, which the route regex rejects.
      if (event.status === 'ended') {
        if (isReplayExpired(event)) {
          return new Response(JSON.stringify({ error: 'Recordings for this event have expired, so viewing hours can no longer be added' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // Ended without ever recording: no replay exists, so extra viewing hours buy nothing.
        if (!event.recordings_expire_at && !(Array.isArray(event.recordings) && event.recordings.length > 0)) {
          return new Response(JSON.stringify({ error: 'This event has no recordings, so viewing hours cannot be added' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Check user has at least 1 credit
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('credits')
        .eq('id', userId)
        .single();

      if (userError || !user || user.credits < 1) {
        return new Response(JSON.stringify({ error: 'Insufficient credits' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Add one credit's viewing (MINUTES_PER_CREDIT, top of file) to the event limit.
      // Top-ups always use the current rate, so a pre-change 200-hour event gains 250 per top-up.
      const currentLimit = event.viewer_hour_limit || MINUTES_PER_CREDIT;
      const newLimit = currentLimit + MINUTES_PER_CREDIT;

      const { error: updateError } = await supabase
        .from('events')
        .update({ viewer_hour_limit: newLimit })
        .eq('id', event.id);

      if (updateError) {
        console.error('Error adding credits to event:', updateError);
        return new Response(JSON.stringify({ error: 'Failed to update event' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Deduct 1 credit from user
      const newBalance = user.credits - 1;
      await supabase
        .from('users')
        .update({ credits: newBalance })
        .eq('id', userId);

      // Log the transaction
      const { error: txError } = await supabase.from('credit_transactions').insert({
        user_id: userId,
        amount: -1,
        type: 'event_topup',
        event_id: event.id,
      });

      if (txError) {
        // If the insert fails (e.g. type constraint), log it loudly
        // The credit was already deducted and the limit already increased,
        // so we don't rollback, but this will break refund accounting
        console.error(`⚠️ CRITICAL: event_topup transaction insert failed for event ${slug}:`, txError);
      }

      console.log(`✅ Event ${slug}: +${HOURS_PER_CREDIT} viewing hours (limit now ${newLimit} min), user balance: ${newBalance}`);

      return new Response(JSON.stringify({
        success: true,
        newLimit,
        newLimitHours: Math.round(newLimit / 60),
        creditsRemaining: newBalance,
        message: `Added ${HOURS_PER_CREDIT} viewing hours. Event now has ${Math.round(newLimit / 60)} total hours.`,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // PATCH /api/events/:slug/status - Update event status (authenticated)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/status$/) && method === 'PATCH') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const slug = pathname.split('/')[3];
      const body = await request.json() as any;

      // Get event
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('id, user_id, status, stream_started_at, is_test')
        .eq('slug', slug)
        .single();

      if (getError || !event) {
        return new Response(
          JSON.stringify({ error: 'Event not found' }),
          { status: 404, headers: corsHeaders }
        );
      }

      if (event.user_id !== userId) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 403, headers: corsHeaders }
        );
      }

      if (event.is_test) {
        return new Response(
          JSON.stringify({ error: 'Test event status is managed automatically' }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Update event
      const updates: any = {};
      if (body.status) updates.status = body.status;
      if (body.streamState) updates.stream_state = body.streamState;
      if (body.streamState === 'active' && !event.stream_started_at) {
        updates.stream_started_at = new Date().toISOString();
      }

      const { data: updated, error: updateError } = await supabase
        .from('events')
        .update(updates)
        .eq('slug', slug)
        .select()
        .single();

      if (updateError) {
        return new Response(
          JSON.stringify({ error: 'Update failed' }),
          { status: 500, headers: corsHeaders }
        );
      }

      return new Response(JSON.stringify(updated), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // PATCH /api/events/:slug/title - Update event title (authenticated, pre-stream only)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/title$/) && method === 'PATCH') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const slug = pathname.split('/')[3];
      const body = await request.json() as any;
      const { title } = body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return new Response(JSON.stringify({ error: 'Title is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Verify ownership and check that streaming hasn't started
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('id, user_id, status, stream_credentials_revealed, is_test')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Test event title cannot be changed' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Block title changes once streaming has started or event has ended
      if (event.stream_credentials_revealed || event.status === 'ended') {
        return new Response(JSON.stringify({ error: 'Title cannot be changed after streaming has started' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { error: updateError } = await supabase
        .from('events')
        .update({ title: title.trim() })
        .eq('id', event.id);

      if (updateError) {
        console.error('Title update error:', updateError);
        return new Response(JSON.stringify({ error: 'Failed to update title' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true, title: title.trim() }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // PATCH /api/events/:slug/cover - Update cover image URL (authenticated)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/cover$/) && method === 'PATCH') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const slug = pathname.split('/')[3];
      const body = await request.json() as any;
      // coverImageUrl can be a string (set/replace) or null (delete).
      // Only reject if the key is completely missing from the payload.
      const { coverImageUrl } = body;

      if (!('coverImageUrl' in body)) {
        return new Response(JSON.stringify({ error: 'coverImageUrl is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Verify ownership
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('id, user_id, is_test')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Test events do not support cover photos' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { error: updateError } = await supabase
        .from('events')
        .update({ cover_image_url: coverImageUrl })
        .eq('id', event.id);

      if (updateError) {
        console.error('Cover update error:', updateError);
        return new Response(JSON.stringify({ error: 'Failed to update cover' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true, coverImageUrl }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /api/events - List user's events (authenticated)
    if (pathname === '/api/events' && method === 'GET') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const { data: events, error } = await supabase
        .from('events')
        .select('*')
        .eq('user_id', userId)
        .order('scheduled_date', { ascending: false });

      if (error) {
        return new Response(
          JSON.stringify({ error: 'Query failed' }),
          { status: 500, headers: corsHeaders }
        );
      }

      return new Response(JSON.stringify(events), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /api/events/:slug/analytics - Fetch analytics (authenticated)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/analytics$/) && method === 'GET') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      const slug = pathname.split('/')[3];

      // Get event
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('id, user_id, recordings, is_test, recordings_expire_at, viewer_hour_limit, viewer_minutes_consumed, viewer_minutes_banked, viewer_minutes_banked_through')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 403, headers: corsHeaders }
        );
      }

      // Live usage: the same banked math the 10-minute sync uses (computeViewerUsage),
      // computed fresh but not saved. Falls back to the stored value when the event can no
      // longer gain minutes, has no recordings, or Cloudflare's analytics are unavailable.
      let consumedMinutes = Number(event.viewer_minutes_consumed) || 0;
      const uids = eventRecordingUids(event);
      if (uids.length > 0 && isViewerSyncEligible(event)) {
        const analytics = await fetchViewerMinutesByDay(uids, env);
        if (analytics) {
          consumedMinutes = computeViewerUsage(event, eventMinutesByDay(event, analytics.byUid)).consumed;
        }
      }

      // Response stays in hours (1 decimal) for the dashboard. Limit math stays in minutes.
      const viewerHours = Math.round((consumedMinutes / 60) * 10) / 10;
      const limitMinutes = Number(event.viewer_hour_limit) || MINUTES_PER_CREDIT; // MINUTES despite the name
      const limitWarning = consumedMinutes >= limitMinutes
        ? 'limit-exceeded'
        : consumedMinutes >= limitMinutes * 0.8
        ? 'limit-warning'
        : undefined;

      return new Response(
        JSON.stringify({
          viewerHoursUsed: viewerHours,
          limitWarning,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // =========================================================================
    // Stripe Integration — Credit Purchase Flow
    // =========================================================================

    /**
     * POST /api/checkout — Create a Stripe Checkout Session (authenticated)
     * 
     * Body: { tierId: 'single' | 'pro5' | 'studio10' }
     * Returns: { url: string } — the Stripe Checkout URL to redirect the user to
     * 
     * Pricing tiers (must match CREDIT_TIERS on the dashboard home page.tsx):
     *   single:   1 credit  @ $30.00
     *   pro5:     5 credits @ $140.00  ($28.00/ea)
     *   studio10: 10 credits @ $260.00 ($26.00/ea)
     */
    if (pathname === '/api/checkout' && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: corsHeaders,
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401, headers: corsHeaders,
        });
      }

      const body = await request.json() as { tierId?: string };
      if (!body.tierId) {
        return new Response(JSON.stringify({ error: 'Missing tierId' }), {
          status: 400, headers: corsHeaders,
        });
      }

      // Tier definitions — prices in cents for Stripe
      const tiers: Record<string, { credits: number; priceInCents: number; label: string }> = {
        single:   { credits: 1,  priceInCents: 3000,  label: 'MomentCast Credit' },
        pro5:     { credits: 5,  priceInCents: 14000, label: '5 MomentCast Credits' },
        studio10: { credits: 10, priceInCents: 26000, label: '10 MomentCast Credits' },
      };

      const tier = tiers[body.tierId];
      if (!tier) {
        return new Response(JSON.stringify({ error: 'Invalid tierId' }), {
          status: 400, headers: corsHeaders,
        });
      }

      // Fetch user email (for creating the Stripe Customer) and any existing customer ID
      const { data: userData } = await supabase
        .from('users')
        .select('email, stripe_customer_id')
        .eq('id', userId)
        .single();

      try {
        // Verify Stripe key is configured
        if (!env.STRIPE_SECRET_KEY) {
          console.error('STRIPE_SECRET_KEY is not configured');
          return new Response(JSON.stringify({ error: 'Stripe is not configured. Add STRIPE_SECRET_KEY to worker secrets.' }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Reuse the user's Stripe Customer, or create it on their first purchase
        const stripeCustomerId = await getOrCreateStripeCustomer(
          userId,
          userData?.email,
          userData?.stripe_customer_id,
          env,
          supabase
        );

        // Create Stripe Checkout Session via REST API (no SDK needed in Workers)
        const stripeParams = new URLSearchParams({
          'mode': 'payment',
          'success_url': `https://app.momentcast.live/?purchase=success&credits=${tier.credits}`,
          'cancel_url': 'https://app.momentcast.live/?purchase=cancelled',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][product_data][name]': tier.label,
          'line_items[0][price_data][product_data][description]': `${tier.credits} event credit${tier.credits > 1 ? 's' : ''}, ${HOURS_PER_CREDIT} viewing hours each`,
          'line_items[0][price_data][unit_amount]': tier.priceInCents.toString(),
          'line_items[0][quantity]': '1',
          'metadata[user_id]': userId,
          'metadata[tier_id]': body.tierId,
          'metadata[credits]': tier.credits.toString(),
          // 'customer' and 'customer_email' are mutually exclusive in Checkout
          'customer': stripeCustomerId,
          // Checkout does not write to an existing Customer by default. Without these,
          // the Customer keeps only the email we created it with (no name, no country).
          'customer_update[name]': 'auto',
          'customer_update[address]': 'auto',
        });

        console.log(`Stripe checkout request: key prefix=${env.STRIPE_SECRET_KEY.substring(0, 8)}..., tier=${body.tierId}`);

        const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: stripeParams.toString(),
        });

        const session = await stripeResponse.json() as any;

        if (!stripeResponse.ok || !session.url) {
          // Surface the actual Stripe error for debugging
          const stripeError = session.error?.message || session.error?.type || JSON.stringify(session.error) || 'Unknown Stripe error';
          console.error(`Stripe Checkout error (${stripeResponse.status}):`, JSON.stringify(session));
          return new Response(JSON.stringify({ 
            error: `Stripe error: ${stripeError}`,
            stripeStatus: stripeResponse.status,
          }), {
            status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`✅ Stripe Checkout created for user ${userId}: ${tier.label} ($${(tier.priceInCents / 100).toFixed(2)})`);

        return new Response(JSON.stringify({ url: session.url }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

      } catch (err) {
        console.error('Stripe Checkout error:', err);
        return new Response(JSON.stringify({ error: 'Stripe checkout failed' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    /**
     * POST /api/webhooks/stripe — Handle Stripe webhook events (unauthenticated)
     * 
     * Verifies the Stripe-Signature header, then processes checkout.session.completed
     * to credit the user's balance and log the transaction.
     * 
     * Required env vars: STRIPE_WEBHOOK_SECRET
     */
    if (pathname === '/api/webhooks/stripe' && method === 'POST') {
      const signature = request.headers.get('stripe-signature');
      if (!signature) {
        return new Response(JSON.stringify({ error: 'Missing Stripe signature' }), {
          status: 400, headers: corsHeaders,
        });
      }

      const rawBody = await request.text();

      // Verify webhook signature (Stripe HMAC-SHA256)
      try {
        const signatureParts = signature.split(',').reduce((acc: Record<string, string>, part: string) => {
          const [key, value] = part.split('=');
          acc[key] = value;
          return acc;
        }, {} as Record<string, string>);

        const timestamp = signatureParts['t'];
        const expectedSig = signatureParts['v1'];

        if (!timestamp || !expectedSig) {
          return new Response(JSON.stringify({ error: 'Invalid signature format' }), {
            status: 400, headers: corsHeaders,
          });
        }

        // Reject if timestamp is too old (5 minutes tolerance)
        const ageSeconds = Math.floor(Date.now() / 1000) - parseInt(timestamp);
        if (ageSeconds > 300) {
          return new Response(JSON.stringify({ error: 'Webhook timestamp too old' }), {
            status: 400, headers: corsHeaders,
          });
        }

        // Compute expected signature
        const signedPayload = `${timestamp}.${rawBody}`;
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          'raw',
          encoder.encode(env.STRIPE_WEBHOOK_SECRET),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
        const computedSig = [...new Uint8Array(sig)]
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        if (computedSig !== expectedSig) {
          console.error('Stripe webhook signature mismatch');
          return new Response(JSON.stringify({ error: 'Invalid signature' }), {
            status: 400, headers: corsHeaders,
          });
        }
      } catch (err) {
        console.error('Stripe signature verification error:', err);
        return new Response(JSON.stringify({ error: 'Signature verification failed' }), {
          status: 400, headers: corsHeaders,
        });
      }

      // Signature verified — process the event
      const event = JSON.parse(rawBody) as any;
      console.log(`Stripe webhook received: ${event.type}`);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        const credits = parseInt(session.metadata?.credits || '0');
        const tierId = session.metadata?.tier_id || 'unknown';

        if (!userId || credits < 1) {
          console.error('Stripe webhook: missing metadata', { userId, credits });
          return new Response(JSON.stringify({ error: 'Invalid metadata' }), {
            status: 400, headers: corsHeaders,
          });
        }

        // Idempotency: check if we already processed this session
        const stripeSessionId = session.id;
        const { data: existing } = await supabase
          .from('credit_transactions')
          .select('id')
          .eq('stripe_session_id', stripeSessionId)
          .maybeSingle();

        if (existing) {
          console.log(`Stripe webhook: session ${stripeSessionId} already processed, skipping`);
          return new Response(JSON.stringify({ received: true, duplicate: true }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Credit the user
        const { data: user } = await supabase
          .from('users')
          .select('credits')
          .eq('id', userId)
          .single();

        if (!user) {
          console.error(`Stripe webhook: user ${userId} not found`);
          return new Response(JSON.stringify({ error: 'User not found' }), {
            status: 404, headers: corsHeaders,
          });
        }

        const newBalance = user.credits + credits;
        await supabase
          .from('users')
          .update({ credits: newBalance })
          .eq('id', userId);

        // Log the transaction with Stripe reference for idempotency
        await supabase.from('credit_transactions').insert({
          user_id: userId,
          amount: credits,
          type: 'purchase',
          event_id: null,
          stripe_session_id: stripeSessionId,
        });

        const amountPaid = (session.amount_total / 100).toFixed(2);
        console.log(`✅ Stripe: +${credits} credits for user ${userId} (${tierId}, $${amountPaid}), balance now ${newBalance}`);
      }

      // Always return 200 to Stripe (even for event types we don't handle)
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /api/events/:slug/recordings/downloads - Enable MP4 download generation
    // for every recording produced by this event's Live Input (authenticated, owner only).
    // Cloudflare Stream MP4 downloads are async: this kicks off generation and returns
    // the current status. The frontend polls the matching GET endpoint until ready.
    // Constraint: live recordings over 4 hours cannot be downloaded as MP4 per Cloudflare.
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/recordings\/downloads$/) && method === 'POST') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const slug = pathname.split('/')[3];

      // Verify ownership. Downloads are gated per-recording (readyToStream), not per-event status,
      // so a live event with finalized segments is a valid candidate.
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('id, slug, user_id, status, live_input_id, stream_credentials_revealed, is_test')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Downloads are not available for test events' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Block cancelled events and events that haven't started streaming yet.
      // For active/ended events, individual recording readiness is enforced below
      // by the eligibleVideos filter (status.state === 'ready' && readyToStream).
      if (event.status === 'cancelled' || !event.stream_credentials_revealed) {
        return new Response(JSON.stringify({
          error: 'Downloads are not available for this event',
        }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!event.live_input_id) {
        return new Response(JSON.stringify({ error: 'No recordings available for this event' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Fetch the list of recordings (videos) tied to this Live Input
      let videos: any[] = [];
      try {
        const recordingsResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}/videos`,
          {
            headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
          }
        );
        const recordingsData = await recordingsResponse.json() as any;
        if (recordingsData.success && Array.isArray(recordingsData.result)) {
          videos = recordingsData.result;
        }
      } catch (err) {
        console.error('Failed to fetch recordings for downloads:', err);
        return new Response(JSON.stringify({ error: 'Failed to fetch recordings' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Sort by creation time so "Part 1, Part 2..." matches chronological order
      videos.sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

      // Filter to only recordings that are ready to be processed for download
      const eligibleVideos = videos.filter(v => v.status?.state === 'ready' && v.readyToStream);

      if (eligibleVideos.length === 0) {
        return new Response(JSON.stringify({
          error: 'No recordings are ready for download yet',
          recordings: [],
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Filename pattern: single-part → "{slug}.mp4", multi-part → "{slug}-part-{N}.mp4"
      const isMultiPart = eligibleVideos.length > 1;
      const FOUR_HOURS_SECONDS = 4 * 60 * 60;

      // Kick off MP4 generation for each recording. Cloudflare's POST is idempotent:
      // calling it on a video that already has an enabled download just returns current status.
      const recordings = await Promise.all(eligibleVideos.map(async (video, index) => {
        const partNumber = index + 1;
        const filename = isMultiPart
          ? `${event.slug}-part-${partNumber}.mp4`
          : `${event.slug}.mp4`;
        const durationSeconds = video.duration || 0;
        const tooLongForMp4 = durationSeconds > FOUR_HOURS_SECONDS;

        // Skip the API call entirely for recordings that exceed Cloudflare's 4-hour MP4 limit
        if (tooLongForMp4) {
          return {
            uid: video.uid,
            partNumber,
            totalParts: eligibleVideos.length,
            durationSeconds,
            tooLongForMp4: true,
            status: 'unsupported',
            url: null,
            hlsUrl: await signedHlsUrl(video.uid, env), // FFmpeg fallback; works for PLAYBACK_TOKEN_TTL_HOURS
            filename,
            percentComplete: 0,
          };
        }

        try {
          const downloadsResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${video.uid}/downloads`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
            }
          );
          const downloadsData = await downloadsResponse.json() as any;
          const def = downloadsData.result?.default;

          // Signed MP4 link with a clean filename (see signedDownloadUrl)
          const urlWithFilename = await signedDownloadUrl(def?.url, video.uid, filename, env);

          return {
            uid: video.uid,
            partNumber,
            totalParts: eligibleVideos.length,
            durationSeconds,
            tooLongForMp4: false,
            status: def?.status || 'unknown', // "inprogress" | "ready"
            url: urlWithFilename,
            filename,
            percentComplete: def?.percentComplete ?? 0,
          };
        } catch (err) {
          console.error(`Failed to enable MP4 download for ${video.uid}:`, err);
          return {
            uid: video.uid,
            partNumber,
            totalParts: eligibleVideos.length,
            durationSeconds,
            tooLongForMp4: false,
            status: 'error',
            url: null,
            filename,
            percentComplete: 0,
          };
        }
      }));

      return new Response(JSON.stringify({ recordings }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /api/events/:slug/recordings/downloads - Poll MP4 generation status
    // for every recording. Used by the dashboard to show progress and surface
    // download URLs once each MP4 reaches "ready" state. Authenticated, owner only.
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/recordings\/downloads$/) && method === 'GET') {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const userId = await verifyJWT(token, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const slug = pathname.split('/')[3];

      // Verify ownership
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('id, slug, user_id, status, live_input_id, is_test')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (event.is_test) {
        return new Response(JSON.stringify({ error: 'Downloads are not available for test events' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!event.live_input_id) {
        return new Response(JSON.stringify({ recordings: [] }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Same recording lookup as the POST handler (kept consistent so the UI stays in sync)
      let videos: any[] = [];
      try {
        const recordingsResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${event.live_input_id}/videos`,
          {
            headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
          }
        );
        const recordingsData = await recordingsResponse.json() as any;
        if (recordingsData.success && Array.isArray(recordingsData.result)) {
          videos = recordingsData.result;
        }
      } catch (err) {
        console.error('Failed to fetch recordings for downloads status:', err);
        return new Response(JSON.stringify({ error: 'Failed to fetch recordings' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      videos.sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());
      const eligibleVideos = videos.filter(v => v.status?.state === 'ready' && v.readyToStream);
      const isMultiPart = eligibleVideos.length > 1;
      const FOUR_HOURS_SECONDS = 4 * 60 * 60;

      // GET each video's downloads endpoint to read current generation status.
      // Returns 404 if downloads were never enabled for that video — we surface
      // that as status "not_started" so the UI can render a "Prepare" button.
      const recordings = await Promise.all(eligibleVideos.map(async (video, index) => {
        const partNumber = index + 1;
        const filename = isMultiPart
          ? `${event.slug}-part-${partNumber}.mp4`
          : `${event.slug}.mp4`;
        const durationSeconds = video.duration || 0;
        const tooLongForMp4 = durationSeconds > FOUR_HOURS_SECONDS;

        if (tooLongForMp4) {
          return {
            uid: video.uid,
            partNumber,
            totalParts: eligibleVideos.length,
            durationSeconds,
            tooLongForMp4: true,
            status: 'unsupported',
            url: null,
            hlsUrl: await signedHlsUrl(video.uid, env), // FFmpeg fallback; works for PLAYBACK_TOKEN_TTL_HOURS
            filename,
            percentComplete: 0,
          };
        }

        try {
          const downloadsResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${video.uid}/downloads`,
            {
              method: 'GET',
              headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
            }
          );

          // 404 means downloads have never been enabled for this video yet
          if (downloadsResponse.status === 404) {
            return {
              uid: video.uid,
              partNumber,
              totalParts: eligibleVideos.length,
              durationSeconds,
              tooLongForMp4: false,
              status: 'not_started',
              url: null,
              filename,
              percentComplete: 0,
            };
          }

          const downloadsData = await downloadsResponse.json() as any;
          const def = downloadsData.result?.default;

          // If the result object is empty/missing, treat as not started
          if (!def) {
            return {
              uid: video.uid,
              partNumber,
              totalParts: eligibleVideos.length,
              durationSeconds,
              tooLongForMp4: false,
              status: 'not_started',
              url: null,
              filename,
              percentComplete: 0,
            };
          }

          // Signed MP4 link with a clean filename (see signedDownloadUrl)
          const urlWithFilename = await signedDownloadUrl(def.url, video.uid, filename, env);

          return {
            uid: video.uid,
            partNumber,
            totalParts: eligibleVideos.length,
            durationSeconds,
            tooLongForMp4: false,
            status: def.status || 'unknown',
            url: urlWithFilename,
            filename,
            percentComplete: def.percentComplete ?? 0,
          };
        } catch (err) {
          console.error(`Failed to fetch download status for ${video.uid}:`, err);
          return {
            uid: video.uid,
            partNumber,
            totalParts: eligibleVideos.length,
            durationSeconds,
            tooLongForMp4: false,
            status: 'error',
            url: null,
            filename,
            percentComplete: 0,
          };
        }
      }));

      return new Response(JSON.stringify({ recordings }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET/POST /api/events/:slug/storage-extension - Paid replay storage extension (owner only).
    // GET returns the quote (what each credit count buys). POST { credits } buys one option:
    // the worker recomputes the quote, so the client's numbers are never trusted, then the
    // database applies it atomically (extend_replay_storage) and Cloudflare gets the new date.
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+\/storage-extension$/) && (method === 'GET' || method === 'POST')) {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const token = extractToken(request.headers.get('authorization'));
      if (!token) return json({ error: 'Unauthorized' }, 401);
      const userId = await verifyJWT(token, env);
      if (!userId) return json({ error: 'Invalid token' }, 401);

      const slug = pathname.split('/')[3];
      const { data: event } = await supabase
        .from('events')
        .select('id, slug, user_id, status, is_test, is_demo, slug_released_at, recordings, recordings_expire_at, recordings_extended_months')
        .eq('slug', slug)
        .single();
      if (!event || event.user_id !== userId) return json({ error: 'Event not found' }, 404);

      let quote: StorageExtensionQuote;
      try {
        quote = await storageExtensionQuote(event, env);
      } catch (err) {
        console.error(`storage-extension quote failed for ${slug}:`, err);
        return json({ error: 'Could not check the recordings right now. Please try again.' }, 502);
      }

      if (method === 'GET') return json(quote);

      // POST: buy the option matching the requested credit count
      if (!quote.eligible) return json({ error: quote.reason }, 400);
      let body: any = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const option = quote.options.find(o => o.credits === Number(body?.credits));
      if (!option) return json({ error: 'That option is no longer available. Refresh and try again.' }, 400);

      const { data: rows, error: rpcError } = await supabase.rpc('extend_replay_storage', {
        p_user_id: userId,
        p_event_id: event.id,
        p_credits: option.credits,
        p_months: option.months,
        p_max_months: MAX_STORAGE_EXTENSION_MONTHS,
        p_min_lead_minutes: STORAGE_EXTENSION_MIN_LEAD_MINUTES,
      });
      if (rpcError) {
        const messages: Record<string, [string, number]> = {
          insufficient_credits: ['You don\'t have enough credits for this option.', 402],
          over_cap: [`This replay already has the maximum extra storage (${MAX_STORAGE_EXTENSION_MONTHS} months).`, 400],
          too_late: ['This replay expires too soon to extend.', 400],
          not_eligible: ['Storage can\'t be extended for this event.', 400],
          not_found: ['Event not found', 404],
        };
        const key = Object.keys(messages).find(k => rpcError.message?.includes(k));
        if (!key) console.error(`extend_replay_storage failed for ${slug}:`, rpcError);
        const [message, status] = key ? messages[key] : ['Could not extend storage. No credits were used.', 500];
        return json({ error: message }, status);
      }
      const result = Array.isArray(rows) ? rows[0] : rows;

      // Push the new date to Cloudflare now. The flag set by the purchase makes the 5-minute
      // cron retry anything this misses, so a failure here is logged, not returned.
      try {
        await reconcileRecordingRetention(
          { slug: event.slug, recordings: event.recordings, recordings_expire_at: result.new_expires_at },
          env,
          RETENTION_RECONCILE_BUDGET
        );
      } catch (err) {
        console.error(`storage-extension: immediate reconcile failed for ${slug}:`, err);
      }

      console.log(`🗄️ ${slug}: +${option.months} months for ${option.credits} credit(s), replay until ${result.new_expires_at}`);
      return json({
        success: true,
        monthsAdded: option.months,
        creditsSpent: option.credits,
        newExpiry: result.new_expires_at,
        extendedMonths: result.total_extended_months,
        creditsRemaining: result.credits_remaining,
      });
    }

    // GET /api/config - Public business constants for the dashboard and watch page.
    // Read-only, takes no input, exposes nothing private: the values are already
    // stated publicly on the marketing site. Clients read this instead of keeping copies.
    if (pathname === '/api/config' && method === 'GET') {
      return new Response(
        JSON.stringify({
          defaultRetentionDays: DEFAULT_RETENTION_DAYS,
          slugCooldownDays: SLUG_COOLDOWN_DAYS,
          maxStorageExtensionMonths: MAX_STORAGE_EXTENSION_MONTHS,
        }),
        {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300', // 5 min: changes land quickly, few repeat calls
          },
        }
      );
    }

    // GET /ping - Health check
    if (pathname === '/ping' && method === 'GET') {
      return new Response(
        JSON.stringify({ message: 'pong', status: 'ok' }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Default 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error('Request error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

export default {
  fetch: handleRequest,
  
  async scheduled(event: any, env: WorkerEnv, ctx: any) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    // ONE cron trigger ("*/5 * * * *" in wrangler.toml) drives every scheduled job.
    // The Free plan allows 5 cron triggers per ACCOUNT, shared with your other Workers,
    // so this Worker uses a single trigger and routes each 5-minute tick by its UTC time.
    // One job per tick keeps every run under the 50-subrequest limit.
    //   03:00          daily cleanup (slug release, expired-window sweep, Live Input cleanup)
    //   hh:00          MailerLite retry (every other hour, on the hour)
    //   hh:10 - hh:50  viewer-hours sync (every 10 minutes)
    //   hh:05 - hh:55  test-session cap + retention reconcile (every 10 minutes)
    // scheduledTime is the slot's planned time, so a late-starting run still routes correctly.
    const tick = new Date(event.scheduledTime);
    const minute = tick.getUTCMinutes();
    const isDailyTick = tick.getUTCHours() === DAILY_JOB_HOUR_UTC && minute === 0;

    if (isDailyTick) {
      // === Release slugs of events past the cooldown ===
      // Runs first and in its own try/catch: the cleanup below returns early when it
      // has nothing to do, and a failure here must not block that cleanup.
      try {
        console.log(`🔓 Releasing slugs older than ${SLUG_COOLDOWN_DAYS} days...`);
        const { data: releasedCount, error: releaseError } = await supabase
          .rpc('release_expired_slugs', { cooldown_days: SLUG_COOLDOWN_DAYS });

        if (releaseError) {
          console.error('Slug release failed:', releaseError);
        } else {
          console.log(`✅ Released ${releasedCount} slug(s)`);
        }

        // Cleanup pass for released rows: delete the Live Input, delete the cover file,
        // then null both columns. Idempotent: a row that fails here is retried tomorrow.
        // Capped per run to stay under the Workers subrequest limit; a larger backlog
        // drains over several days. Raise the limit if you're on a paid Workers plan.
        const { data: releasedRows } = await supabase
          .from('events')
          .select('id, user_id, original_slug, live_input_id, cover_image_url')
          .not('slug_released_at', 'is', null)
          .or('live_input_id.not.is.null,cover_image_url.not.is.null')
          .limit(15);

        for (const rel of releasedRows || []) {
          const updates: Record<string, any> = {};

          if (rel.live_input_id) {
            try {
              const delRes = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${rel.live_input_id}`,
                { method: 'DELETE', headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } }
              );
              const delJson = await delRes.json() as any;
              // Error 10009 = already deleted, which is the outcome we want
              if (delJson.success || delJson.errors?.[0]?.code === 10009) {
                updates.live_input_id = null;
              } else {
                console.error(`Failed to delete Live Input for released event ${rel.id}:`, delJson.errors);
              }
            } catch (err) {
              console.error(`Error deleting Live Input for released event ${rel.id}:`, err);
            }
          }

          if (rel.cover_image_url && rel.original_slug) {
            // Covers live at covers/{user_id}/{slug}; older uploads carry an extension
            const base = `${rel.user_id}/${rel.original_slug}`;
            const { error: rmError } = await supabase.storage.from('covers').remove([
              base,
              ...['jpg', 'jpeg', 'png', 'webp'].map(ext => `${base}.${ext}`),
            ]);
            if (rmError) {
              console.error(`Failed to delete cover for released event ${rel.id}:`, rmError);
            } else {
              updates.cover_image_url = null;
            }
          }

          if (Object.keys(updates).length > 0) {
            await supabase.from('events').update(updates).eq('id', rel.id);
          }
        }
      } catch (err) {
        console.error('Slug release step crashed:', err);
      }

      // === Expire events whose 24h streaming window has passed ===
      // Without this, an event nobody touches after expiry stays 'ready' forever,
      // blocking account deletion and keeping its Live Input alive.
      try {
        const windowCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { error: sweepError } = await supabase
          .from('events')
          .update({ status: 'ended', stream_state: 'disconnected' })
          .eq('is_test', false)
          .eq('status', 'ready')
          .lt('stream_started_manually_at', windowCutoff);
        if (sweepError) {
          console.error('Expired-event sweep failed:', sweepError);
        } else {
          console.log('✅ Expired-event sweep completed');
        }
      } catch (err) {
        console.error('Expired-event sweep crashed:', err);
      }

      // === Daily cleanup of expired Live Inputs ===
      console.log('🧹 Running daily cleanup of expired Live Inputs...');

      const { data: expiredEvents } = await supabase
        .from('events')
        .select('id, slug, live_input_id, stream_started_manually_at')
        .eq('status', 'ended')
        .not('live_input_id', 'is', null);

      if (!expiredEvents || expiredEvents.length === 0) {
        console.log('✅ No expired Live Inputs to clean up');
        return;
      }

      console.log(`Found ${expiredEvents.length} ended events with Live Inputs`);

      for (const evt of expiredEvents) {
        // Last chance to list this input's recordings: save any the event is missing
        // before the Live Input (and with it Cloudflare's per-input listing) is deleted.
        await saveMissingRecordings(evt, env, supabase);

        try {
          const deleteResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${evt.live_input_id}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
              },
            }
          );

          const deleteResult = await deleteResponse.json() as any;

          if (deleteResult.success) {
            console.log(`🗑️ Deleted Live Input for ended event: ${evt.slug}`);
          } else if (deleteResult.errors?.[0]?.code === 10009) {
            console.log(`ℹ️ Live Input already deleted for: ${evt.slug}`);
          } else {
            console.error(`Failed to delete Live Input for ${evt.slug}:`, deleteResult.errors);
          }
        } catch (err) {
          console.error(`Error deleting Live Input for ${evt.slug}:`, err);
        }
      }

      console.log('✅ Daily cleanup completed');

    } else if (minute % 10 === 0 && minute !== 0) {
      // === Sync viewer hours from Cloudflare Stream analytics ===
      console.log('📊 Running viewer-hours sync...');
      await syncViewerHours(env, supabase);
      console.log('✅ Viewer-hours sync completed');

    } else if (minute % 10 === 5) {
      // === Cap test-event sessions at 15 minutes connected ===
      // Runs on the :05 ticks (every 10 minutes): worst case a session runs 25 minutes.
      console.log('🧪 Checking for test sessions over the cap...');
      const TEST_SESSION_CAP_MS = 15 * 60 * 1000;
      const { data: overCapped } = await supabase
        .from('events')
        .select('id, slug, live_input_id, test_session_connected_at, test_sessions_today, test_sessions_day')
        .eq('is_test', true)
        .not('test_session_connected_at', 'is', null);

      if (overCapped && overCapped.length > 0) {
        const now = Date.now();
        for (const evt of overCapped) {
          const connectedAt = new Date(evt.test_session_connected_at).getTime();
          if (now - connectedAt > TEST_SESSION_CAP_MS) {
            console.log(`⏱️ Test event ${evt.slug} exceeded 15-min cap, disabling`);
            try {
              await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/live_inputs/${evt.live_input_id}`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` },
                  body: JSON.stringify({ enabled: false }),
                }
              );
            } catch (err) {
              console.error(`Failed to disable capped test input for ${evt.slug}:`, err);
            }

            // Cron-side disconnect (e.g. the webhook was missed) still
            // counts as a real, connected session — same accounting as
            // the normal disconnect path.
            const { sessionsToday, sessionsDay } = incrementDailyTestSessionCount(
              evt.test_sessions_today,
              evt.test_sessions_day
            );

            await supabase
              .from('events')
              .update({
                status: 'scheduled',
                stream_state: 'inactive',
                test_session_armed_at: null,
                test_session_connected_at: null,
                test_session_last_ended_at: new Date().toISOString(),
                test_sessions_today: sessionsToday,
                test_sessions_day: sessionsDay,
              })
              .eq('id', evt.id);
          }
        }
      }
      console.log('✅ Test session cap check completed');

      // === Reconcile replay retention (one deletion date per event) ===
      // Runs every 10 minutes, so a recording is synced soon after Cloudflare finalizes it.
      try {
        await reconcileRetentionBatch(env, supabase);
      } catch (err) {
        console.error('Retention reconcile crashed:', err);
      }
    } else if (minute === 0) {
      // === Hourly MailerLite retry for confirmed users the webhook missed ===
      // Own tick on purpose: the sync and reconcile ticks already spend subrequests.
      console.log('📬 Running MailerLite reconcile...');
      await reconcileMailerLite(env, supabase);
    }
  }
} as ExportedHandler<WorkerEnv>;