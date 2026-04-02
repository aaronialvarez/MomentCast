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
  status: 'scheduled' | 'live' | 'ended' | 'cancelled' | 'ready';
  stream_state: 'inactive' | 'active' | 'paused' | 'finalized';
  live_input_id?: string;
  rtmps_url?: string;
  rtmps_key?: string;
  tier: string;
  viewer_hour_limit: number;
  stream_credentials_revealed: boolean;
  stream_started_manually_at?: string;
  can_be_rescheduled: boolean;
  timezone?: string;
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
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [newDateTime, setNewDateTime] = useState('');
  const [newTimezone, setNewTimezone] = useState('');
  const [rescheduling, setRescheduling] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [coverSuccess, setCoverSuccess] = useState(false);
  const [deletingCover, setDeletingCover] = useState(false);
  // Title editing state — only available before streaming starts
  const [editingTitle, setEditingTitle] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  // Cancel event state
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Same timezone list as create-event page
  const timezoneOptions = [
    { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
    { value: 'America/Denver', label: 'Mountain Time (MT)' },
    { value: 'America/Chicago', label: 'Central Time (CT)' },
    { value: 'America/New_York', label: 'Eastern Time (ET)' },
    { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
    { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  ];
  // Minimum datetime for rescheduling: now (prevents past dates)
  const minRescheduleDateTime = (() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  })();

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

  useEffect(() => {
    // Only run for ready/live events with streaming started
    if (!event || !event.stream_started_manually_at) {
      setTimeRemaining(null);
      return;
    }

    if (event.status !== 'ready' && event.status !== 'live') {
      setTimeRemaining(null);
      return;
    }

    function calculateTimeRemaining() {
      if (!event?.stream_started_manually_at) return null;

      const startedAt = new Date(event.stream_started_manually_at).getTime();
      const expiresAt = startedAt + (24 * 60 * 60 * 1000);
      const now = Date.now();
      const remaining = expiresAt - now;

      if (remaining <= 0) {
        return "Expired";
      }

      const hours = Math.floor(remaining / (60 * 60 * 1000));
      const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));

      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    // Calculate immediately
    setTimeRemaining(calculateTimeRemaining());

    // Update every minute
    const interval = setInterval(() => {
      setTimeRemaining(calculateTimeRemaining());
    }, 60000);

    return () => clearInterval(interval);
  }, [event]);

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  // Allow streaming starting 2 hours before the scheduled time.
  // Gives photographers a setup window without opening access days early.
  function canStartStreaming(scheduledDate: string): boolean {
    const scheduled = new Date(scheduledDate).getTime();
    const now = Date.now();
    const twoHoursBefore = scheduled - (2 * 60 * 60 * 1000);
    return now >= twoHoursBefore;
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

  async function handleCoverUpload() {
    if (!coverFile || !event) return;

    setUploadingCover(true);
    setCoverError(null);
    setCoverSuccess(false);
    console.log('[CoverUpload] Starting upload:', coverFile.name, coverFile.type, `${(coverFile.size / 1024).toFixed(1)}KB`);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }

      // Upload to Supabase Storage: covers/{userId}/{slug}
      // Fixed path (no extension) ensures every upload overwrites the same file,
      // eliminating orphans when switching between jpg/png/webp.
      // Supabase serves the correct Content-Type from the contentType option below.
      const filePath = `${session.user.id}/${event.slug}`;
      console.log('[CoverUpload] Storage path:', filePath);

      // Clean up any legacy extension-based files (one-time orphan removal).
      // Safe to call even if files don't exist; Supabase won't error.
      const legacyPaths = ['jpg', 'jpeg', 'png', 'webp'].map(
        ext => `${session.user.id}/${event.slug}.${ext}`
      );
      console.log('[CoverUpload] Cleaning legacy paths:', legacyPaths);
      await supabase.storage.from('covers').remove(legacyPaths);

      const { error: uploadError } = await supabase.storage
        .from('covers')
        .upload(filePath, coverFile, {
          contentType: coverFile.type,
          upsert: true,
        });

      if (uploadError) {
        throw new Error(uploadError.message);
      }
      console.log('[CoverUpload] Storage upload succeeded');

      // Get public URL and append cache-busting param so browser/CDN
      // treats each replacement as a new resource (the underlying path is identical)
      const { data: urlData } = supabase.storage
        .from('covers')
        .getPublicUrl(filePath);

      const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;
      console.log('[CoverUpload] Public URL (cache-busted):', publicUrl);

      // Save URL to event via API
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${event.slug}/cover`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ coverImageUrl: publicUrl }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save cover photo');
      }

      setCoverSuccess(true);
      setCoverFile(null);
      console.log('[CoverUpload] API save succeeded, reloading event data...');

      // Reload event data to reflect change
      const { data: eventData } = await supabase
        .from('events')
        .select('*')
        .eq('id', event.id)
        .single();

      if (eventData) {
        console.log('[CoverUpload] Event reloaded, cover_image_url:', (eventData as any).cover_image_url);
        setEvent(eventData);
      }
    } catch (err) {
      console.error('[CoverUpload] Error:', err);
      setCoverError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploadingCover(false);
    }
  }

  /** Delete the cover photo from Supabase Storage and null out the DB field */
  async function handleCoverDelete() {
    if (!event) return;

    setDeletingCover(true);
    setCoverError(null);
    setCoverSuccess(false);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }

      // Remove file from Supabase Storage (fixed path, no extension)
      const filePath = `${session.user.id}/${event.slug}`;
      console.log('[CoverDelete] Removing storage file:', filePath);

      // Remove the current file plus any legacy extension-based orphans
      const allPaths = [
        filePath,
        ...['jpg', 'jpeg', 'png', 'webp'].map(ext => `${filePath}.${ext}`)
      ];
      const { error: removeError } = await supabase.storage
        .from('covers')
        .remove(allPaths);

      if (removeError) {
        console.error('[CoverDelete] Storage remove error:', removeError);
        // Continue anyway; the file may already be gone
      }

      // Null out the URL in the database via API
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${event.slug}/cover`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ coverImageUrl: null }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to remove cover photo');
      }

      console.log('[CoverDelete] API nulled cover_image_url, reloading event...');

      // Clear local preview state
      setCoverPreview(null);
      setCoverFile(null);

      // Reload event data to reflect change
      const { data: eventData } = await supabase
        .from('events')
        .select('*')
        .eq('id', event.id)
        .single();

      if (eventData) {
        console.log('[CoverDelete] Event reloaded, cover_image_url:', (eventData as any).cover_image_url);
        setEvent(eventData);
      }
    } catch (err) {
      console.error('[CoverDelete] Error:', err);
      setCoverError(err instanceof Error ? err.message : 'Failed to remove cover photo');
    } finally {
      setDeletingCover(false);
    }
  }

  async function handleReschedule() {
    if (!event || !newDateTime) return;
    
    setRescheduling(true);
    setRescheduleError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        router.push('/login');
        return;
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${event.slug}/reschedule`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            newDateTime,                                          // e.g. "2026-04-05T16:00"
            timezone: newTimezone || event.timezone || 'America/Los_Angeles',  // IANA timezone
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to reschedule event');
      }

      // Reload event data
      const { data: eventData } = await supabase
        .from('events')
        .select('*')
        .eq('id', event.id)
        .single();

      if (eventData) {
        setEvent(eventData);
        setShowRescheduleModal(false);
        setNewDateTime('');
        setNewTimezone('');
      }

    } catch (err) {
      console.error('Reschedule error:', err);
      setRescheduleError(err instanceof Error ? err.message : 'Failed to reschedule event');
    } finally {
      setRescheduling(false);
    }
  }

  async function handleCancelEvent() {
    if (!event) return;
    
    setCancelling(true);
    setCancelError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        router.push('/login');
        return;
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${event.slug}/cancel`,
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
        throw new Error(data.error || 'Failed to cancel event');
      }

      // Redirect to dashboard after successful cancellation
      router.push('/');

    } catch (err) {
      console.error('Cancel event error:', err);
      setCancelError(err instanceof Error ? err.message : 'Failed to cancel event');
    } finally {
      setCancelling(false);
    }
  }

  /** Save updated event title via API (only allowed before streaming starts) */
  async function handleTitleSave() {
    if (!event || !editedTitle.trim()) return;

    setSavingTitle(true);
    setTitleError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${event.slug}/title`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: editedTitle.trim() }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update title');
      }

      // Reload event data to reflect change
      const { data: eventData } = await supabase
        .from('events')
        .select('*')
        .eq('id', event.id)
        .single();

      if (eventData) {
        setEvent(eventData);
      }

      setEditingTitle(false);
    } catch (err) {
      console.error('Title save error:', err);
      setTitleError(err instanceof Error ? err.message : 'Failed to update title');
    } finally {
      setSavingTitle(false);
    }
  }

  // Track loaded cover image dimensions for the 1:1 crop overlay
  const [coverDimensions, setCoverDimensions] = useState<{ width: number; height: number } | null>(null);

  /**
   * CoverPreviewWithCrop — shows the full image at its natural aspect ratio
   * with semi-transparent dark overlays on the non-square edges.
   * Landscape photos get side bars; portrait photos get top/bottom bars.
   * This previews the 1:1 crop region that the watch page actually displays.
   */
  function CoverPreviewWithCrop({ src, borderColor = 'border-gray-700' }: { src: string; borderColor?: string }) {
    const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

    // Determine overlay bar sizes as percentages
    let topBar = '0%', bottomBar = '0%', leftBar = '0%', rightBar = '0%';
    if (dims) {
      if (dims.w > dims.h) {
        // Landscape: side bars, square height = 100%, square width = (h/w)*100%
        const barWidth = ((dims.w - dims.h) / dims.w / 2) * 100;
        leftBar = `${barWidth}%`;
        rightBar = `${barWidth}%`;
      } else if (dims.h > dims.w) {
        // Portrait: top/bottom bars, square width = 100%, square height = (w/h)*100%
        const barHeight = ((dims.h - dims.w) / dims.h / 2) * 100;
        topBar = `${barHeight}%`;
        bottomBar = `${barHeight}%`;
      }
      // Square: no bars needed
    }

    return (
      <div className={`relative w-96 max-w-full rounded-lg ${borderColor} border overflow-hidden`}>
        <img
          src={src}
          alt="Cover preview"
          className="w-full h-auto block"
          onLoad={(e) => {
            const img = e.currentTarget;
            setDims({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
        {dims && (
          <>
            {/* Top bar (portrait photos) */}
            <div className="absolute top-0 left-0 right-0 pointer-events-none" style={{ height: topBar, background: 'rgba(0,0,0,0.6)' }} />
            {/* Bottom bar (portrait photos) */}
            <div className="absolute bottom-0 left-0 right-0 pointer-events-none" style={{ height: bottomBar, background: 'rgba(0,0,0,0.6)' }} />
            {/* Left bar (landscape photos) */}
            <div className="absolute top-0 left-0 bottom-0 pointer-events-none" style={{ width: leftBar, background: 'rgba(0,0,0,0.6)' }} />
            {/* Right bar (landscape photos) */}
            <div className="absolute top-0 right-0 bottom-0 pointer-events-none" style={{ width: rightBar, background: 'rgba(0,0,0,0.6)' }} />
          </>
        )}
      </div>
    );
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
          {/* Event title — editable before streaming starts */}
          {editingTitle ? (
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                maxLength={100}
                autoFocus
                className="text-3xl font-bold bg-white/10 border border-white/30 rounded-lg px-3 py-1 text-white w-full max-w-lg focus:outline-none focus:border-white/60"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTitleSave();
                  if (e.key === 'Escape') { setEditingTitle(false); setTitleError(null); }
                }}
              />
              <button
                onClick={handleTitleSave}
                disabled={savingTitle || !editedTitle.trim()}
                className="px-4 py-2 bg-white/20 hover:bg-white/30 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
              >
                {savingTitle ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => { setEditingTitle(false); setTitleError(null); }}
                className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold">{event.title}</h1>
              {/* Edit button — only show before streaming has started */}
              {!event.stream_credentials_revealed && event.status !== 'ended' && (
                <button
                  onClick={() => { setEditedTitle(event.title); setEditingTitle(true); setTitleError(null); }}
                  className="p-1.5 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                  title="Edit title"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {titleError && (
            <p className="text-red-200 text-sm mt-1">{titleError}</p>
          )}
          <p className="text-white/80 mt-2">
            {new Date(event.scheduled_date).toLocaleString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              timeZoneName: 'short',
              timeZone: event.timezone || 'America/Los_Angeles'
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

        {/* Change Date Button - Only show if event can be rescheduled */}
        {event.can_be_rescheduled && event.status !== 'ended' && event.status !== 'cancelled' && (
          <div className="mb-6 flex items-start gap-4">
            <div>
              <button
                onClick={() => setShowRescheduleModal(true)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
              >
                Change Event Date & Time
              </button>
              <p className="text-gray-400 text-xs mt-2">
                ℹ️ You can change the date and time before starting the stream
              </p>
            </div>
            {!event.stream_credentials_revealed && (
              <div>
                <button
                  onClick={() => setShowCancelModal(true)}
                  className="px-4 py-2 bg-red-900/50 hover:bg-red-900 text-red-200 border border-red-800 rounded-lg font-medium transition-colors"
                >
                  Cancel Event
                </button>
                <p className="text-gray-400 text-xs mt-2">
                  Credit will be returned to your balance
                </p>
              </div>
            )}
          </div>
        )}

        {/* Cover Photo */}
        <div className="bg-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-semibold mb-2">Cover Photo</h2>
          <p className="text-gray-400 text-sm mb-4">
            Shown behind the countdown on your watch page. Max 2MB. JPG, PNG, or WebP.
          </p>

          {/* Current cover preview — full image with 1:1 crop overlay to match watch page */}
          {(event as any).cover_image_url && !coverPreview && (
            <div className="mb-4">
              <CoverPreviewWithCrop src={(event as any).cover_image_url} borderColor="border-gray-700" />
              <p className="text-green-400 text-xs mt-2">✓ Cover photo is live on your watch page</p>
            </div>
          )}

          {/* New file preview — full image with 1:1 crop overlay to match watch page */}
          {coverPreview && (
            <div className="mb-4">
              <CoverPreviewWithCrop src={coverPreview} borderColor="border-gray-600" />
              <p className="text-gray-400 text-xs mt-2">Preview (not saved yet)</p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <label className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium cursor-pointer transition-colors text-sm">
              {(event as any).cover_image_url ? 'Replace Photo' : 'Choose Photo'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;

                  if (file.size > 2 * 1024 * 1024) {
                    setCoverError('File must be under 2MB');
                    return;
                  }

                  setCoverFile(file);
                  setCoverError(null);
                  setCoverSuccess(false);
                  setCoverPreview(URL.createObjectURL(file));
                }}
              />
            </label>

            {coverFile && (
              <button
                onClick={handleCoverUpload}
                disabled={uploadingCover}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-medium transition-colors text-sm"
              >
                {uploadingCover ? 'Uploading...' : 'Save Cover Photo'}
              </button>
            )}

            {/* Remove button: only show when a cover exists and no new file is staged */}
            {(event as any).cover_image_url && !coverFile && (
              <button
                onClick={handleCoverDelete}
                disabled={deletingCover}
                className="px-4 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium transition-colors text-sm"
              >
                {deletingCover ? 'Removing...' : 'Remove'}
              </button>
            )}
          </div>

          {coverError && (
            <p className="text-red-400 text-sm mt-3">{coverError}</p>
          )}
          {coverSuccess && (
            <p className="text-green-400 text-sm mt-3">✓ Cover photo saved successfully</p>
          )}
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
        {event.status === 'ended' ? (
          // Event ended - show completion message instead of credentials
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Event Completed</h2>
            <div className="bg-gray-700/50 rounded-lg p-6 text-center">
              <p className="text-gray-400 mb-2">
                This event ended on {event.stream_started_manually_at ? 
                  new Date(new Date(event.stream_started_manually_at).getTime() + 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric'
                  }) : 
                  new Date(event.scheduled_date).toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                    timeZone: 'UTC'
                  })
                }
              </p>
              <p className="text-gray-300 font-medium mb-4">
                Recordings are available at the watch page
              </p>
              <a 
                href={`https://go.momentcast.live/${event.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-medium transition-colors"
              >
                View Recordings →
              </a>
            </div>
          </div>
        ) : !event.stream_credentials_revealed ? (
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-4">Start Streaming</h2>
            
            {canStartStreaming(event.scheduled_date) ? (
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
                  ⏱️ Once started, you'll have 24 hours to stream. This cannot be undone.
                </p>
              </>
            ) : (
              <div className="py-6">
                <p className="text-gray-400 mb-4">
                  Ready to go live? Click below to start your 24-hour streaming window and get your streaming credentials.
                </p>
                <button
                  disabled={true}
                  className="w-full bg-gray-600 text-gray-300 font-semibold py-3 px-6 rounded-lg cursor-not-allowed"
                >
                  Start Streaming
                </button>
                <p className="text-gray-400 text-sm mt-3 text-center">
                  Streaming will be available on{' '}
                  <span className="font-medium text-white">
                    {new Date(event.scheduled_date).toLocaleString('en-US', {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZoneName: 'short',
                      timeZone: event.timezone || 'America/Los_Angeles'
                    })}
                  </span>
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2">Streaming Credentials</h2>
            {event.stream_started_manually_at && (
              <div className="mb-4">
                <p className="text-sm text-gray-400 mb-4">
                  Started: {new Date(event.stream_started_manually_at).toLocaleString()}
                  {timeRemaining && timeRemaining !== "Expired" && (() => {
                    const hours = parseInt(timeRemaining.split(':')[0]);
                    const minutes = timeRemaining.split(':')[1];
                    const colorClass = hours >= 12 ? 'text-green-400' : 'text-yellow-400';
                    return (
                      <span className={colorClass}> • {hours} hours {minutes} minutes left to stream</span>
                    );
                  })()}
                </p>
              </div>
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
                  <span className="font-semibold">{analytics.viewerHoursUsed.toFixed(1)}</span>
                  {' of '}
                  <span className="font-semibold">{analytics.viewerHoursLimit.toLocaleString()}</span>
                  {' used'}
                  <span className="text-gray-400 text-xs ml-2">
                    ({(analytics.viewerHoursLimit - analytics.viewerHoursUsed).toFixed(1)} left)
                  </span>
                </p>
              ) : (
                <p className="text-gray-500">Loading...</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Reschedule Modal */}
      {showRescheduleModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-xl font-semibold mb-4">Change Event Date & Time</h3>
            
            {rescheduleError && (
              <div className="bg-red-900 text-red-100 p-3 rounded-lg mb-4 text-sm">
                {rescheduleError}
              </div>
            )}
            
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">New Event Date and Time</label>
              <input
                type="datetime-local"
                value={newDateTime}
                onChange={(e) => setNewDateTime(e.target.value)}
                min={minRescheduleDateTime}
                step={900} // 15-minute increments
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white"
              />
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">Timezone</label>
              <select
                value={newTimezone || event.timezone || 'America/Los_Angeles'}
                onChange={(e) => setNewTimezone(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded text-white"
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
            
            <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-3 mb-4">
              <p className="text-sm text-blue-200">
                ✓ Your watch URL will stay the same<br/>
                ✓ No additional credit needed
              </p>
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowRescheduleModal(false);
                  setNewDateTime('');
                  setNewTimezone('');
                  setRescheduleError(null);
                }}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded font-medium"
                disabled={rescheduling}
              >
                Cancel
              </button>
              <button
                onClick={handleReschedule}
                disabled={!newDateTime || rescheduling}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium"
              >
                {rescheduling ? 'Updating...' : 'Update Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Cancel Event Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-xl font-semibold mb-4 text-red-400">Cancel Event</h3>
            
            {cancelError && (
              <div className="bg-red-900 text-red-100 p-3 rounded-lg mb-4 text-sm">
                {cancelError}
              </div>
            )}
            
            <p className="text-gray-300 mb-4">
              Are you sure you want to cancel <span className="font-semibold text-white">{event.title}</span>?
            </p>

            <div className="bg-gray-700/50 rounded-lg p-3 mb-4 space-y-1">
              <p className="text-sm text-green-300">
                ✓ {event.tier === 'premium' ? '2 credits' : '1 credit'} will be returned to your balance
              </p>
              <p className="text-sm text-gray-400">
                ✓ The watch page link will stop working
              </p>
              <p className="text-sm text-gray-400">
                ✓ This cannot be undone
              </p>
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowCancelModal(false);
                  setCancelError(null);
                }}
                className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded font-medium"
                disabled={cancelling}
              >
                Keep Event
              </button>
              <button
                onClick={handleCancelEvent}
                disabled={cancelling}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium"
              >
                {cancelling ? 'Cancelling...' : 'Yes, Cancel Event'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}