'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
export const runtime = 'edge';

interface Event {
  id: string;
  slug: string;
  title: string;
  scheduled_date: string;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  stream_state: 'inactive' | 'active' | 'paused' | 'finalized';
  live_input_id?: string;
  rtmps_url?: string;
  rtmps_key?: string;
  tier: string;
  viewer_hour_limit: number;
  stream_credentials_revealed: boolean;
  stream_started_manually_at?: string;
  can_be_rescheduled: boolean;
}

export default function EventDetailPage() {
  const router = useRouter();
  const params = useParams();
  const eventId = params.id as string;

  const [supabase] = useState(() =>
    createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  );

  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [startingStream, setStartingStream] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [showStreamKey, setShowStreamKey] = useState(false);
  const [analytics, setAnalytics] = useState<{
    viewerHoursUsed: number;
    viewerHoursLimit: number;
  } | null>(null);

  useEffect(() => {
    async function loadEvent() {
      try {
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
        
        if (authError || !authUser) {
          router.push('/login');
          return;
        }

        const { data: eventData, error: eventError } = await supabase
          .from('events')
          .select('*')
          .eq('id', eventId)
          .eq('user_id', authUser.id)
          .single();

        if (eventError) {
          console.error('Event fetch error:', eventError);
          setError('Event not found');
          setLoading(false);
          return;
        }

        setEvent(eventData);
      } catch (err) {
        console.error('Load event error:', err);
        setError('Failed to load event');
      } finally {
        setLoading(false);
      }
    }

    loadEvent();
  }, [supabase, router, eventId]);

  useEffect(() => {
    async function fetchAnalytics() {
      if (!event || !event.slug) return;

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        const response = await fetch(
          `${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${event.slug}/analytics`,
          {
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          setAnalytics({
            viewerHoursUsed: data.viewerHoursUsed || 0,
            viewerHoursLimit: event.viewer_hour_limit,
          });
        }
      } catch (err) {
        console.error('Failed to fetch analytics:', err);
      }
    }

    fetchAnalytics();
  }, [event, supabase]);

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  function isEventToday(scheduledDate: string): boolean {
    const today = new Date();
    const todayLocal = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return scheduledDate === todayLocal;
  }

  async function handleStartStreaming() {
    if (!event) return;
    
    setStartingStream(true);
    setStreamError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        router.push('/login');
        return;
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${event.slug}/start-streaming`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start streaming');
      }

      // Reload event to get updated credentials
      const { data: eventData } = await supabase
        .from('events')
        .select('*')
        .eq('id', event.id)
        .single();

      if (eventData) {
        setEvent(eventData);
      }

    } catch (err) {
      console.error('Start streaming error:', err);
      setStreamError(err instanceof Error ? err.message : 'Failed to start streaming');
    } finally {
      setStartingStream(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading event...</div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="max-w-md text-center">
          <div className="bg-red-900 text-red-100 p-6 rounded-lg mb-4">
            {error || 'Event not found'}
          </div>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-medium"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple-600 to-pink-600 p-8">
        <div className="max-w-6xl mx-auto">
          <button
            onClick={() => router.push('/')}
            className="text-white/80 hover:text-white mb-4 flex items-center gap-2"
          >
            ← Back to Dashboard
          </button>
          <h1 className="text-3xl font-bold">{event.title}</h1>
          <p className="text-white/80 mt-2">
            {new Date(event.scheduled_date).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
              timeZone: 'UTC'  // Forces UTC interpretation
            })}
          </p>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8">
        {/* Status Badge */}
        <div className="mb-8">
          <span
            className={`inline-block px-4 py-2 rounded-full text-sm font-medium ${
              event.status === 'live'
                ? 'bg-red-900 text-red-100'
                : event.status === 'ended'
                ? 'bg-gray-600 text-gray-100'
                : 'bg-blue-900 text-blue-100'
            }`}
          >
            {event.status.toUpperCase()}
          </span>
        </div>

        {/* Watch URL */}
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Watch Page URL</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={`https://go.momentcast.live/${event.slug}`}
              readOnly
              className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded text-white"
            />
            <button
              onClick={() => copyToClipboard(`https://go.momentcast.live/${event.slug}`, 'watch-url')}
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded font-medium"
            >
              {copied === 'watch-url' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-gray-400 text-sm mt-2">
            Share this URL with your guests to watch the live stream
          </p>
        </div>

        {/* Streaming Details */}
        {!event.stream_credentials_revealed ? (
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Start Streaming</h2>
            
            {isEventToday(event.scheduled_date) ? (
              <>
                <p className="text-gray-400 mb-6">
                  Ready to go live? Click below to start your 24-hour streaming window and get your streaming credentials.
                </p>
                
                {streamError && (
                  <div className="bg-red-900 text-red-100 p-4 rounded-lg mb-4">
                    {streamError}
                  </div>
                )}
                
                <button
                  onClick={handleStartStreaming}
                  disabled={startingStream}
                  className="w-full px-6 py-4 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-semibold text-lg transition-colors"
                >
                  {startingStream ? 'Starting...' : 'Start Streaming'}
                </button>
                
                <p className="text-sm text-gray-500 mt-4">
                  âœ… Once started, you'll have 24 hours to stream
                </p>
              </>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-400 mb-2">
                  Streaming will be available on
                </p>
                <p className="text-xl font-semibold">
                  {new Date(event.scheduled_date).toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                    timeZone: 'UTC'  // Forces UTC interpretation
                  })}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2">Streaming Credentials</h2>
            {event.stream_started_manually_at && (
              <p className="text-sm text-gray-400 mb-4">
                Started: {new Date(event.stream_started_manually_at).toLocaleString()} • 
                Expires: {new Date(new Date(event.stream_started_manually_at).getTime() + 24 * 60 * 60 * 1000).toLocaleString()}
              </p>
            )}
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">RTMPS Server URL</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={event.rtmps_url || ''}
                    readOnly
                    className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded text-white font-mono text-sm"
                  />
                  <button
                    onClick={() => copyToClipboard(event.rtmps_url || '', 'rtmps-url')}
                    className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded font-medium"
                  >
                    {copied === 'rtmps-url' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Stream Key</label>
                <div className="flex gap-2">
                  <input
                    type={showStreamKey ? "text" : "password"}
                    value={event.rtmps_key || ''}
                    readOnly
                    className="flex-1 px-4 py-3 bg-gray-700 border border-gray-600 rounded text-white font-mono text-sm"
                  />
                  <button
                    onClick={() => setShowStreamKey(!showStreamKey)}
                    className="px-4 py-3 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded"
                    title={showStreamKey ? "Hide stream key" : "Show stream key"}
                  >
                    {showStreamKey ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => copyToClipboard(event.rtmps_key || '', 'stream-key')}
                    className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded font-medium"
                  >
                    {copied === 'stream-key' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-yellow-500 text-sm mt-2">
                  ⚠️ Keep this private! Anyone with this key can stream to your event.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Event Info */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-4">Event Information</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-gray-400 text-sm">Event ID</p>
              <p className="font-mono text-sm">{event.id}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Slug</p>
              <p className="font-mono text-sm">{event.slug}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Tier</p>
              <p className="capitalize">{event.tier}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Viewer Hours</p>
              {analytics ? (
                <p>
                  <span className="font-semibold">{analytics.viewerHoursUsed.toLocaleString()}</span>
                  {' of '}
                  <span className="font-semibold">{analytics.viewerHoursLimit.toLocaleString()}</span>
                  {' used'}
                  <span className="text-gray-400 text-xs ml-2">
                    ({(analytics.viewerHoursLimit - analytics.viewerHoursUsed).toLocaleString()} left)
                  </span>
                </p>
              ) : (
                <p className="text-gray-500">Loading...</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}