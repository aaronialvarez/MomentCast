import { createClient } from '@supabase/supabase-js';
import type { WorkerEnv, Event, User, CreateEventRequest, CreateEventResponse } from './types';

/**
 * Utility: Generate URL-safe slug from title
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-')
    .substring(0, 50);
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
          preferLowLatency: true,  // ← Enables Low-Latency HLS (beta)
          recording: {
            mode: 'automatic',
            timeoutSeconds: 86400,
          },
          requireSignedURLs: false,
          allowedOrigins: [],
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
      rtmpsUrl: input.rtmps?.url,
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
      
      // Cloudflare sends lifecycle events for live inputs
      if (body.notification && body.notification.eventType === 'live_input.connected') {
        const liveInputId = body.liveInputUID;
        
        // Find event by live_input_id
        const { data: event, error } = await supabase
          .from('events')
          .select('id, slug, status')
          .eq('liveinputid', liveInputId)
          .single();
        
        if (event && event.status !== 'live') {
          // Update to live
          await supabase
            .from('events')
            .update({
              status: 'live',
              streamstate: 'active',
              streamstartedat: new Date().toISOString()
            })
            .eq('id', event.id);
          
          console.log(`Event ${event.slug} is now live`);
        }
      }
      
      if (body.notification && body.notification.eventType === 'live_input.disconnected') {
        const liveInputId = body.liveInputUID;
        
        // Update to ended
        const { data: event } = await supabase
          .from('events')
          .select('id, slug')
          .eq('liveinputid', liveInputId)
          .single();
        
        if (event) {
          await supabase
            .from('events')
            .update({
              streamstate: 'disconnected'
            })
            .eq('id', event.id);
          
          console.log(`Event ${event.slug} disconnected`);
        }
      }
      
      return new Response(JSON.stringify({ received: true }), {
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

      // Generate slug
      const slug = generateSlug(body.title);

      // Check slug uniqueness
      const { data: existingEvent } = await supabase
        .from('events')
        .select('id')
        .eq('slug', slug)
        .single();

      if (existingEvent) {
        return new Response(
          JSON.stringify({ error: 'Event slug already exists' }),
          { status: 409, headers: corsHeaders }
        );
      }

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
        .select('title, scheduled_date, status, stream_state, live_input_id, recordings, merged_video_id')
        .eq('slug', slug)
        .single();

      if (error || !event) {
        return new Response(
          JSON.stringify({ error: 'Event not found' }),
          { status: 404, headers: corsHeaders }
        );
      }

      return new Response(JSON.stringify(event), {
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
        .select('id, user_id, live_input_id, viewer_hours_used, viewer_hour_limit')
        .eq('slug', slug)
        .single();

      if (getError || !event || event.user_id !== userId) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 403, headers: corsHeaders }
        );
      }

      // Fetch analytics from Cloudflare
      const analyticsResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/analytics/views?creator=${event.live_input_id}`,
        {
          headers: {
            'Authorization': `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
          },
        }
      );

      const analyticsData = await analyticsResponse.json() as any;
      const viewerMinutes = analyticsData.result?.data?.[0]?.viewerMinutes || 0;
      const viewerHours = Math.ceil(viewerMinutes / 60);

      const limitWarning = viewerHours >= event.viewer_hour_limit
        ? 'limit-exceeded'
        : viewerHours >= event.viewer_hour_limit * 0.8
        ? 'limit-warning'
        : undefined;

      return new Response(
        JSON.stringify({
          viewerHoursUsed: viewerHours,
          concurrentViewers: analyticsData.result?.data?.[0]?.concurrentViewersMax || 0,
          totalViews: analyticsData.result?.data?.[0]?.views || 0,
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
} as ExportedHandler<WorkerEnv>;
