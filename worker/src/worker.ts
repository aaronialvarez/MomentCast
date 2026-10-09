import { createClient } from '@supabase/supabase-js';
import type { WorkerEnv, Event, User, CreateEventRequest, CreateEventResponse } from './types';
import QRCode from 'qrcode-svg';

// Days after an event's start before its URL slug is released for reuse.
// Must stay >= 32: Cloudflare deletes recordings ~30-31 days after creation, and
// releasing sooner could hand the slug to a stranger while the old replay still plays.
// The SQL function release_expired_slugs() enforces the same floor.
const SLUG_COOLDOWN_DAYS = 90;

// Viewing cap for each user's permanent test event, in MINUTES (viewer_hour_limit is stored in
// minutes). 1500 = 25 hours. syncViewerHours lets test rows fall as old views age out of the
// 30-day analytics window, so this is a rolling cap, not a lifetime one.
const TEST_EVENT_VIEWER_LIMIT_MINUTES = 1500;

// Origins allowed to embed the Stream Player. Hostnames only, no scheme.
// If you add a custom domain (e.g. live.aaronalvarez.com), it MUST be added here
// or the player will refuse to load on that domain.
// app.momentcast.live is included in case the dashboard previews streams.
// Wildcards match subdomains only, never the apex, so both forms are listed.
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
          recording: {
            mode: recordingMode,
            timeoutSeconds: 300,  // 5 minutes - allows quick reconnects, finalizes recordings after disconnect
            requireSignedURLs: false,
            allowedOrigins: ALLOWED_PLAYBACK_ORIGINS,
          },
          deleteRecordingAfterDays: 30,
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
 * Utility: Sync viewer_hours_consumed for all active events
 * Queries Cloudflare Stream GraphQL API for minutesViewed per recording UID,
 * then writes the totals (as hours, 1 decimal) back to each event row.
 */
async function syncViewerHours(env: WorkerEnv, supabase: any): Promise<void> {
  // Fetch events that could have viewable recordings.
  // stream_started_manually_at / scheduled_date feed the age filter below.
  const { data: fetched, error } = await supabase
    .from('events')
    .select('id, slug, recordings, viewer_hours_consumed, stream_started_manually_at, scheduled_date, is_test')
    // Test rows sit at status 'scheduled' between sessions, so the status filter alone would skip them
    .or('status.in.(live,ready,ended),is_test.eq.true')
    .not('recordings', 'is', null);

  if (error) {
    console.error('syncViewerHours: failed to fetch events:', error);
    return;
  }

  // Recordings are deleted from Cloudflare ~30 days after creation, so nothing
  // accrues past that point. Skipping older events keeps the GraphQL query small
  // and stops us touching rows whose data has aged out.
  const SYNC_MAX_AGE_DAYS = 32;
  const cutoffMs = Date.now() - SYNC_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const events = (fetched || []).filter((e: any) => {
    // Test rows: scheduled_date is the row's creation time, so age-filtering would freeze
    // them 32 days after signup. Their recording list is already limited to what Cloudflare holds.
    if (e.is_test) return true;
    const ref = e.stream_started_manually_at || e.scheduled_date;
    return ref && new Date(ref).getTime() >= cutoffMs;
  });

  if (events.length === 0) {
    console.log('syncViewerHours: no events in sync window');
    return;
  }

  // Build a map: recording UID → event ID (so we can attribute minutes back)
  const uidToEventId = new Map<string, string>();
  const eventMinutes = new Map<string, number>(); // event ID → total minutes

  for (const event of events) {
    const raw = event.recordings || [];
    const recs: any[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const uids = recs.map((r: any) => r.uid).filter(Boolean);

    for (const uid of uids) {
      uidToEventId.set(uid, event.id);
    }
    eventMinutes.set(event.id, 0);
  }

  const allUids = Array.from(uidToEventId.keys());
  if (allUids.length === 0) {
    console.log('syncViewerHours: no recording UIDs found across events');
    return;
  }

  // Query Cloudflare GraphQL for minutesViewed, grouped by UID
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const graphqlQuery = {
    query: `
      query SyncViewerHours($accountTag: String!, $startDate: String!, $endDate: String!, $uids: [String!]!) {
        viewer {
          accounts(filter: { accountTag: $accountTag }) {
            streamMinutesViewedAdaptiveGroups(
              filter: {
                date_geq: $startDate,
                date_lt: $endDate,
                uid_in: $uids
              }
              limit: 100
            ) {
              sum {
                minutesViewed
              }
              dimensions {
                uid
              }
            }
          }
        }
      }
    `,
    variables: {
      accountTag: env.CLOUDFLARE_ACCOUNT_ID,
      startDate: thirtyDaysAgo.toISOString().split('T')[0],
      endDate: tomorrow.toISOString().split('T')[0],  // date_lt is exclusive, so use tomorrow to include today's data
      uids: allUids
    }
  };

  try {
    // The query returns one row per uid, capped by `limit`, so a single query silently drops
    // every uid past the cap. Batch the uids (50 per query, limit 100 leaves headroom).
    // Any failure aborts the whole run before the write-back, so a partial pass can never
    // lower a stored value.
    const UID_BATCH_SIZE = 50;
    for (let i = 0; i < allUids.length; i += UID_BATCH_SIZE) {
      graphqlQuery.variables.uids = allUids.slice(i, i + UID_BATCH_SIZE);

      const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(graphqlQuery)
      });

      const data = await response.json() as any;

      // Abort on any API failure. Without this, an error response yields zero
      // minutes for every event and the write-back below wipes real data.
      if (!response.ok || data.errors?.length || !data.data?.viewer?.accounts?.[0]) {
        console.error('syncViewerHours: GraphQL failure, aborting run without writing:', response.status, JSON.stringify(data.errors));
        return;
      }
      const groups = data.data.viewer.accounts[0].streamMinutesViewedAdaptiveGroups;

      if (groups && groups.length > 0) {
        for (const group of groups) {
          const uid = group.dimensions?.uid;
          const minutes = group.sum?.minutesViewed || 0;
          if (uid && uidToEventId.has(uid)) {
            const eventId = uidToEventId.get(uid)!;
            eventMinutes.set(eventId, (eventMinutes.get(eventId) || 0) + minutes);
          }
        }
      }
    }

    // Write back to each event (only if the value increased)
    let updatedCount = 0;
    for (const event of events) {
      const totalMinutes = eventMinutes.get(event.id) || 0;
      const hours = Math.round((totalMinutes / 60) * 10) / 10;
      const currentHours = event.viewer_hours_consumed || 0;

      // Monotonic: only ever raise the stored value. The 31-day GraphQL window
      // slides forward, so a lower computed number means views aged out of the
      // window, not that they were undone. Historic hours must never decrease.
      // Test rows are the exception to the monotonic rule: their cap is "viewing in the last
      // ~30 days", so the value must fall as old views leave the window. Otherwise one heavy
      // month would lock the test page forever.
      const shouldWrite = event.is_test ? hours !== currentHours : hours > currentHours;
      if (shouldWrite) {
        const { error: updateError } = await supabase
          .from('events')
          .update({ viewer_hours_consumed: hours })
          .eq('id', event.id);

        if (updateError) {
          console.error(`syncViewerHours: failed to update ${event.slug}:`, updateError);
        } else {
          console.log(`📊 ${event.slug}: ${currentHours}h → ${hours}h`);
          updatedCount++;
        }
      }
    }

    console.log(`syncViewerHours: checked ${events.length} events, updated ${updatedCount}`);
  } catch (err) {
    console.error('syncViewerHours: GraphQL request failed:', err);
  }
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
        .select('id, status, is_test, stream_state, live_input_id, recordings, merged_video_id')
        .eq('user_id', userId);
      if (eventsErr) {
        console.error('account/delete: events query failed', userId, eventsErr);
        return reply(500, { error: 'Could not load your events. Please try again.' });
      }

      // Never kill a stream mid-event or strand a paid event. Test events do not block.
      const blocking = (events || []).filter((e: any) =>
        !e.is_test && (['live', 'ready', 'scheduled'].includes(e.status) || e.stream_state === 'active')
      );
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
        viewer_hour_limit: 12000, // 200 viewing hours per credit (in minutes)
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
            body: JSON.stringify({ enabled: true }),
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
        .select('id, user_id, title, scheduled_date, timezone, status, stream_state, live_input_id, recordings, merged_video_id, viewer_hours_consumed, viewer_hour_limit, stream_started_manually_at, last_stream_activity, qr_code_data_url, cover_image_url, is_test')
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
      
      // Recordings are deleted from Cloudflare ~30 days after creation, so past 32 days
      // there is nothing to fetch. The watch page shows its EXPIRED state at day 30 anyway.
      const eventRefDate = event.stream_started_manually_at || event.scheduled_date;
      const eventAgeDays = (Date.now() - new Date(eventRefDate).getTime()) / (24 * 60 * 60 * 1000);

      // Test rows have no meaningful age (scheduled_date is the row's creation time) and
      // Cloudflare's list only returns recordings that still exist, so refetch whenever
      // the test is not live.
      const refetchTestRecordings = !!event.is_test && event.status !== 'live' && !!event.live_input_id;

      if (refetchTestRecordings || ((event.status === 'ready' || event.status === 'ended') && event.live_input_id && eventAgeDays <= 32)) {
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
          }
        } catch (err) {
          console.error('Error fetching recordings:', err);
          // Fall back to stored recordings in database if fetch fails
        }
      }

      // Test events expose only their newest recording. Older ones stay stored until
      // Cloudflare deletes them but are never linked from the watch page.
      if (event.is_test && Array.isArray(recordings)) {
        recordings = [...recordings]
          .sort((a: any, b: any) => new Date(b.created).getTime() - new Date(a.created).getTime())
          .slice(0, 1);
      }

      // Check if viewer limit exceeded (only applies to live/replay viewing).
      // viewer_hours_consumed is in HOURS; viewer_hour_limit is stored in MINUTES
      // (12000 = 200 hours). Convert before comparing.
      const viewerHoursConsumed = Number(event.viewer_hours_consumed) || 0;
      const viewerHourLimitMinutes = event.viewer_hour_limit || 12000; // 200 viewing hours default
      const limitExceeded = viewerHoursConsumed >= viewerHourLimitMinutes / 60;

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
     * Deducts 1 credit from user balance and adds 12,000 minutes (200 viewing hours)
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

      // Verify event belongs to this user and is not ended/cancelled
      const { data: event, error: eventError } = await supabase
        .from('events')
        .select('id, slug, user_id, status, viewer_hour_limit')
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

      if (event.status === 'ended' || event.status === 'cancelled') {
        return new Response(JSON.stringify({ error: 'Cannot add credits to an ended or cancelled event' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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

      // Add 12,000 minutes (200 viewing hours) to event limit
      const MINUTES_PER_CREDIT = 12000;
      const currentLimit = event.viewer_hour_limit || 12000;
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

      console.log(`✅ Event ${slug}: +200 viewing hours (limit now ${newLimit} min), user balance: ${newBalance}`);

      return new Response(JSON.stringify({
        success: true,
        newLimit,
        newLimitHours: Math.round(newLimit / 60),
        creditsRemaining: newBalance,
        message: `Added 200 viewing hours. Event now has ${Math.round(newLimit / 60)} total hours.`,
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
        .select('id, user_id, live_input_id, recordings, viewer_hours_consumed, viewer_hour_limit, stream_started_manually_at, scheduled_date')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 403, headers: corsHeaders }
        );
      }

      // Past the sync window, Cloudflare's 31-day query can no longer see this
      // event's views, so a live query would return 0. Serve the banked value
      // from the database and skip the Cloudflare call entirely.
      // Keep in sync with SYNC_MAX_AGE_DAYS in syncViewerHours().
      const refDate = event.stream_started_manually_at || event.scheduled_date;
      const ageDays = refDate ? (Date.now() - new Date(refDate).getTime()) / (24 * 60 * 60 * 1000) : 0;
      if (ageDays > 32) {
        return new Response(
          JSON.stringify({
            viewerHoursUsed: event.viewer_hours_consumed || 0,
            frozen: true,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Extract recording UIDs from stored recordings jsonb
      // Guard: parse if Supabase returns a JSON string instead of a parsed array
      const rawRecordings = event.recordings || [];
      const parsedRecordings: any[] = typeof rawRecordings === 'string'
        ? JSON.parse(rawRecordings)
        : rawRecordings;
      const recordingUids: string[] = parsedRecordings
        .map((r: any) => r.uid)
        .filter(Boolean);

      // No recordings = no viewer hours possible, skip the API call
      let viewerHours = 0;

      if (recordingUids.length > 0) {
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const graphqlQuery = {
          query: `
            query StreamAnalytics($accountTag: String!, $startDate: String!, $endDate: String!, $uids: [String!]!) {
              viewer {
                accounts(filter: { accountTag: $accountTag }) {
                  streamMinutesViewedAdaptiveGroups(
                    filter: { 
                      date_geq: $startDate, 
                      date_lt: $endDate,
                      uid_in: $uids
                    }
                    limit: 100
                  ) {
                    sum {
                      minutesViewed
                    }
                  }
                }
              }
            }
          `,
          variables: {
            accountTag: env.CLOUDFLARE_ACCOUNT_ID,
            startDate: thirtyDaysAgo.toISOString().split('T')[0],
            endDate: tomorrow.toISOString().split('T')[0],  // date_lt is exclusive, so use tomorrow to include today's data
            uids: recordingUids
          }
        };

        const analyticsResponse = await fetch(
          'https://api.cloudflare.com/client/v4/graphql',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(graphqlQuery)
          }
        );

        const analyticsData = await analyticsResponse.json() as any;
            
        // Sum minutesViewed across all recording UIDs
        let viewerMinutes = 0;
        const groups = analyticsData.data?.viewer?.accounts?.[0]?.streamMinutesViewedAdaptiveGroups;
        if (groups && groups.length > 0) {
          viewerMinutes = groups.reduce((total: number, group: any) => {
            return total + (group.sum?.minutesViewed || 0);
          }, 0);
        }
        
        viewerHours = Math.round((viewerMinutes / 60) * 10) / 10;
      }

      // Inside the window, never report less than what the sync job has already
      // banked. Also covers events with no recordings yet (live query = 0).
      viewerHours = Math.max(viewerHours, event.viewer_hours_consumed || 0);

      // viewer_hour_limit is stored in MINUTES (12000 = 200 h); viewerHours is in hours.
      const limitHours = event.viewer_hour_limit / 60;
      const limitWarning = viewerHours >= limitHours
        ? 'limit-exceeded'
        : viewerHours >= limitHours * 0.8
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
     * Pricing tiers (launch promo, 15% off $35 regular):
     *   single:   1 credit  @ $30.00
     *   pro5:     5 credits @ $142.50  ($28.50/ea)
     *   studio10: 10 credits @ $270.00 ($27.00/ea)
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
        pro5:     { credits: 5,  priceInCents: 14250, label: '5 MomentCast Credits' },
        studio10: { credits: 10, priceInCents: 27000, label: '10 MomentCast Credits' },
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
          'line_items[0][price_data][product_data][description]': `${tier.credits} event credit${tier.credits > 1 ? 's' : ''}, 200 viewing hours each`,
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

          // Append ?filename= so the browser saves a clean name instead of "default.mp4"
          const baseUrl = def?.url as string | undefined;
          const urlWithFilename = baseUrl
            ? `${baseUrl}?filename=${encodeURIComponent(filename)}`
            : null;

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

          const baseUrl = def.url as string | undefined;
          const urlWithFilename = baseUrl
            ? `${baseUrl}?filename=${encodeURIComponent(filename)}`
            : null;

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

    // Route based on which cron trigger fired
    if (event.cron === '0 3 * * *') {
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

    } else if (event.cron === '*/10 * * * *') {
      // === Sync viewer hours from Cloudflare Stream analytics ===
      console.log('📊 Running viewer-hours sync...');
      await syncViewerHours(env, supabase);
      console.log('✅ Viewer-hours sync completed');

    } else if (event.cron === '*/5 * * * *') {
      // === Cap test-event sessions at 15 minutes connected ===
      // Own 5-minute trigger: worst case a session runs 20 minutes instead of 25.
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
    } else if (event.cron === '0 * * * *') {
      // === Hourly MailerLite retry for confirmed users the webhook missed ===
      // Own branch on purpose: the 10-minute branch already spends subrequests on
      // viewer-hours sync and the test-session cap.
      console.log('📬 Running MailerLite reconcile...');
      await reconcileMailerLite(env, supabase);
    }
  }
} as ExportedHandler<WorkerEnv>;