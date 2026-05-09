import { createClient } from '@supabase/supabase-js';
import type { WorkerEnv, Event, User, CreateEventRequest, CreateEventResponse } from './types';
import QRCode from 'qrcode-svg';

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
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents (for Spanish characters)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .substring(0, 50);
}

/**
 * Utility: Get unique slug with time-window collision detection
 * Checks for conflicts within ±180 days of event date
 * Returns clean slug if no conflicts, minimal suffix if conflict exists
 */
async function getUniqueSlug(
  title: string,
  scheduledDate: string,
  supabase: any
): Promise<string> {
  const baseSlug = generateSlug(title);
  const eventDate = new Date(scheduledDate);
  
  // Define time window: ±180 days from event date
  const windowStart = new Date(eventDate.getTime() - 180 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(eventDate.getTime() + 180 * 24 * 60 * 60 * 1000);
  
  // Check for conflicts in time window
  const { data: conflicts, error } = await supabase
    .from('events')
    .select('slug')
    .eq('slug', baseSlug)
    .gte('scheduled_date', windowStart.toISOString())
    .lte('scheduled_date', windowEnd.toISOString());
  
  if (error) {
    console.error('Slug conflict check error:', error);
  }
  
  // No temporal conflicts = use clean slug
  if (!conflicts || conflicts.length === 0) {
    return baseSlug;
  }
  
  // Conflict exists - generate family-safe 3-char suffix
  // Uses consonants and numbers only to avoid forming offensive words
  const safeChars = 'bdfghjkmnpqrstvwxyz23456789';
  const timestamp = Date.now();
  let num = timestamp % (safeChars.length ** 3); // 13,824 combinations
  let suffix = '';
  
  for (let i = 0; i < 3; i++) {
    suffix = safeChars[num % safeChars.length] + suffix;
    num = Math.floor(num / safeChars.length);
  }
  
  return `${baseSlug}-${suffix}`;
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
  env: WorkerEnv
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
            mode: 'automatic',
            timeoutSeconds: 300,  // 5 minutes - allows quick reconnects, finalizes recordings after disconnect
            requireSignedURLs: false,
            allowedOrigins: [],
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
 * Utility: Sync viewer_hours_consumed for all active events
 * Queries Cloudflare Stream GraphQL API for minutesViewed per recording UID,
 * then writes the totals (as hours, 1 decimal) back to each event row.
 */
async function syncViewerHours(env: WorkerEnv, supabase: any): Promise<void> {
  // Fetch events that could have viewable recordings
  const { data: events, error } = await supabase
    .from('events')
    .select('id, slug, recordings, viewer_hours_consumed')
    .in('status', ['live', 'ready', 'ended'])
    .not('recordings', 'is', null);

  if (error) {
    console.error('syncViewerHours: failed to fetch events:', error);
    return;
  }

  if (!events || events.length === 0) {
    console.log('syncViewerHours: no events with recordings found');
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
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(graphqlQuery)
    });

    const data = await response.json() as any;
    const groups = data.data?.viewer?.accounts?.[0]?.streamMinutesViewedAdaptiveGroups;

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

    // Write back to each event (only if value actually changed)
    let updatedCount = 0;
    for (const event of events) {
      const totalMinutes = eventMinutes.get(event.id) || 0;
      const hours = Math.round((totalMinutes / 60) * 10) / 10;
      const currentHours = event.viewer_hours_consumed || 0;

      if (hours !== currentHours) {
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
 * Main Router
 */
async function handleRequest(request: Request, env: WorkerEnv): Promise<Response> {
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
          .select('id, slug, status, stream_started_manually_at')
          .eq('live_input_id', liveInputId)
          .single();
        
        if (error) {
          console.error('Error finding event:', error);
        }
        
        if (event) {
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
          .select('id, slug, status, stream_started_manually_at')
          .eq('live_input_id', liveInputId)
          .single();
        
        if (event) {
          console.log('Found event:', event.slug, 'current status:', event.status);
          
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

      // Generate unique slug with time-window collision detection
      const slug = await getUniqueSlug(body.title, scheduledDateUtc, supabase);

      // Generate QR code for the watch page URL (once, stored forever)
      const watchUrl = `https://go.momentcast.live/${slug}`;
      const qrCodeDataUrl = generateQrDataUrl(watchUrl);

      // Create event — scheduled_date stores UTC, timezone stores the event's local tz
      const { data: event, error: createError } = await supabase
        .from('events')
        .insert({
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
        })
        .select()
        .single();

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

    // GET /api/events/:slug - Get event details (public)
    if (pathname.match(/^\/api\/events\/[a-z0-9-]+$/) && method === 'GET') {
      const slug = pathname.split('/').pop();

      const { data: event, error } = await supabase
        .from('events')
        .select('id, user_id, title, scheduled_date, timezone, status, stream_state, live_input_id, recordings, merged_video_id, viewer_hours_consumed, viewer_hour_limit, stream_started_manually_at, last_stream_activity, qr_code_data_url, cover_image_url')
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
      
      if ((event.status === 'ready' || event.status === 'ended') && event.live_input_id) {
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

      // Check if viewer limit exceeded (only applies to live/replay viewing)
      const viewerHoursConsumed = event.viewer_hours_consumed || 0;
      const viewerHourLimit = event.viewer_hour_limit || 12000; // 200 viewing hours default
      const limitExceeded = viewerHoursConsumed >= viewerHourLimit;

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
        eventTimezone = newTimezone || 'America/Los_Angeles';
        scheduledDateUtc = localDateTimeToUTC(newDateTime, eventTimezone);
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

      // 2. Update event status to cancelled
      const { error: updateError } = await supabase
        .from('events')
        .update({
          status: 'cancelled',
          stream_state: 'inactive',
          live_input_id: null,  // Clear since we deleted it
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
        .select('id, user_id, status, stream_started_at')
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
        .select('id, user_id, status, stream_credentials_revealed')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
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
        .select('id, user_id')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
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
        .select('id, user_id, live_input_id, recordings, viewer_hours_consumed, viewer_hour_limit')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 403, headers: corsHeaders }
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

      const limitWarning = viewerHours >= event.viewer_hour_limit
        ? 'limit-exceeded'
        : viewerHours >= event.viewer_hour_limit * 0.8
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
     *   single:   1 credit  @ $29.99
     *   pro5:     5 credits @ $137.99  ($27.60/ea)
     *   studio10: 10 credits @ $259.99 ($26.00/ea)
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
        single:   { credits: 1,  priceInCents: 2999,  label: '1 MomentCast Credit' },
        pro5:     { credits: 5,  priceInCents: 13799, label: '5 MomentCast Credits' },
        studio10: { credits: 10, priceInCents: 25999, label: '10 MomentCast Credits' },
      };

      const tier = tiers[body.tierId];
      if (!tier) {
        return new Response(JSON.stringify({ error: 'Invalid tierId' }), {
          status: 400, headers: corsHeaders,
        });
      }

      // Fetch user email for Stripe pre-fill
      const { data: userData } = await supabase
        .from('users')
        .select('email')
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
          ...(userData?.email ? { 'customer_email': userData.email } : {}),
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

      // Verify ownership and that the event has actually ended (recordings are finalized)
      const { data: event, error: getError } = await supabase
        .from('events')
        .select('id, slug, user_id, status, live_input_id')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Only allow MP4 generation for ended events; ready/live recordings aren't finalized
      if (event.status !== 'ended') {
        return new Response(JSON.stringify({
          error: 'Downloads are only available for ended events',
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
        .select('id, slug, user_id, status, live_input_id')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(JSON.stringify({ error: 'Event not found' }), {
          status: 404,
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
    }
  }
} as ExportedHandler<WorkerEnv>;