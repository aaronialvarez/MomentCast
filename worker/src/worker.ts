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

      // Validate input
      if (!body.title || !body.scheduledDate) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields: title, scheduledDate' }),
          { status: 400, headers: corsHeaders }
        );
      }

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
      const slug = await getUniqueSlug(body.title, body.scheduledDate, supabase);

      // Generate QR code for the watch page URL (once, stored forever)
      const watchUrl = `https://go.momentcast.live/${slug}`;
      const qrCodeDataUrl = generateQrDataUrl(watchUrl);

      // Create event
      const { data: event, error: createError } = await supabase
        .from('events')
        .insert({
          user_id: userId,
          slug,
          title: body.title,
          scheduled_date: body.scheduledDate,
          live_input_id: cfResult.liveInputId,
          rtmps_url: cfResult.rtmpsUrl,
          rtmps_key: cfResult.rtmpsKey,
          tier: body.tier || 'standard',
          viewer_hour_limit: body.tier === 'premium' ? 15000 : 5000,
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
        .select('id, user_id, title, scheduled_date, status, stream_state, live_input_id, recordings, merged_video_id, viewer_hours_consumed, viewer_hour_limit, stream_started_manually_at, last_stream_activity, qr_code_data_url, cover_image_url')
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
      const viewerHourLimit = event.viewer_hour_limit || 400;
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
      const { newDate } = body;

      if (!newDate) {
        return new Response(JSON.stringify({ error: 'New date is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Validate date format (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(newDate)) {
        return new Response(JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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

      // Update the scheduled date
      const { data: updatedEvent, error: updateError } = await supabase
        .from('events')
        .update({ 
          scheduled_date: newDate,
          updated_at: new Date().toISOString()
        })
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

      console.log(`✅ Event ${slug} rescheduled from ${event.scheduled_date} to ${newDate}`);

      return new Response(JSON.stringify({ 
        success: true,
        event: updatedEvent 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // PATCH /api/events/:slug/status - Update event status (authenticated)

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
      const recordingUids: string[] = (event.recordings || [])
        .map((r: any) => r.uid)
        .filter(Boolean);

      // No recordings = no viewer hours possible, skip the API call
      let viewerHours = 0;

      if (recordingUids.length > 0) {
        const today = new Date();
        const ninetyDaysAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
        
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
            startDate: ninetyDaysAgo.toISOString().split('T')[0],
            endDate: today.toISOString().split('T')[0],
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
        
        viewerHours = Math.ceil(viewerMinutes / 60);
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
    console.log('🧹 Running daily cleanup of expired Live Inputs...');
    
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    
    // Find all ended events that still have live_input_id
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
    
    for (const event of expiredEvents) {
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
          console.log(`🗑️ Deleted Live Input for ended event: ${event.slug}`);
        } else if (deleteResult.errors?.[0]?.code === 10009) {
          console.log(`ℹ️ Live Input already deleted for: ${event.slug}`);
        } else {
          console.error(`Failed to delete Live Input for ${event.slug}:`, deleteResult.errors);
        }
      } catch (err) {
        console.error(`Error deleting Live Input for ${event.slug}:`, err);
      }
    }
    
    console.log('✅ Daily cleanup completed');
  }
} as ExportedHandler<WorkerEnv>;