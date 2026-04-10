'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

export default function CreateEventPage() {
  const router = useRouter();
  const [supabase] = useState(() =>
    createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  );

  // Common US timezones (covers continental US + Hawaii)
  // Expandable later for national rollout
  const timezoneOptions = [
    { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
    { value: 'America/Denver', label: 'Mountain Time (MT)' },
    { value: 'America/Chicago', label: 'Central Time (CT)' },
    { value: 'America/New_York', label: 'Eastern Time (ET)' },
    { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
    { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  ];

  // Default to photographer's browser timezone, fallback to Pacific
  const [timezone, setTimezone] = useState(() => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const isSupported = timezoneOptions.some(tz => tz.value === browserTz);
    return isSupported ? browserTz : 'America/Los_Angeles';
  });

  // Minimum datetime: now (prevents past event creation)
  const [minDateTime] = useState(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  });

  const [title, setTitle] = useState('');
  const [scheduledDateTime, setScheduledDateTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // User credits gate
  const [userCredits, setUserCredits] = useState<number | null>(null);
  const [loadingCredits, setLoadingCredits] = useState(true);

  // Viewing hours estimator sliders
  const [estDuration, setEstDuration] = useState(2);   // hours (1-12)
  const [estViewers, setEstViewers] = useState(100);    // viewers (10-500)
  const estViewingHours = estDuration * estViewers;
  const estCreditsNeeded = Math.ceil(estViewingHours / 200);
  const HOURS_PER_CREDIT = 200;

  // Load user credits on mount
  useEffect(() => {
    async function checkCredits() {
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (!authUser) {
          router.push('/login');
          return;
        }

        const { data: userData } = await supabase
          .from('users')
          .select('credits')
          .eq('id', authUser.id)
          .single();

        setUserCredits(userData?.credits ?? 0);
      } catch (err) {
        console.error('Credits check error:', err);
        setUserCredits(0);
      } finally {
        setLoadingCredits(false);
      }
    }

    checkCredits();
  }, [supabase, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { data: authData } = await supabase.auth.getSession();
      
      if (!authData?.session) {
        router.push('/login');
        return;
      }

      console.log('Creating event...');
      console.log('API URL:', process.env.NEXT_PUBLIC_WORKER_API_URL);

      const response = await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authData.session.access_token}`,
        },
        body: JSON.stringify({
          title,
          scheduledDateTime,  // e.g. "2026-04-04T16:00"
          timezone,           // e.g. "America/Los_Angeles"
        }),
      });

      console.log('Response status:', response.status);

      if (!response.ok) {
        const data = await response.json();
        console.error('API error:', data);
        throw new Error(data.error || 'Failed to create event');
      }

      const data = await response.json();
      console.log('Event created successfully:', data);
      
      // Redirect back to dashboard
      router.push(`/events/${data.eventId}`);
    } catch (err) {
      console.error('Create event error:', err);
      setError(err instanceof Error ? err.message : 'Failed to create event');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-1)]">
      {/* Header */}
      <div className="bg-[#1a1a1f] p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl font-bold text-white">Create New Event</h1>
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-8">
        {/* Loading state */}
        {loadingCredits ? (
          <div className="bg-[var(--mc-surface)] rounded-lg p-12 border border-[var(--mc-border)] text-center text-[var(--mc-text-2)]">
            Loading...
          </div>
        ) : userCredits !== null && userCredits < 1 ? (
          /* Zero credits gate */
          <div className="bg-[var(--mc-surface)] rounded-lg p-8 border border-[var(--mc-border)] text-center">
            <div className="text-5xl mb-4">0</div>
            <h2 className="text-xl font-semibold mb-2">No Credits Available</h2>
            <p className="text-[var(--mc-text-2)] mb-6">
              You need at least 1 credit to create an event. Each credit includes 200 viewing hours.
            </p>
            <button
              onClick={() => router.push('/')}
              className="px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg font-semibold transition-colors"
            >
              Buy Credits
            </button>
          </div>
        ) : (
          /* Create event form */
          <form onSubmit={handleSubmit} className="bg-[var(--mc-surface)] rounded-lg p-8 border border-[var(--mc-border)]">
            {/* Credits remaining indicator */}
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--mc-border)]">
              <p className="text-sm text-[var(--mc-text-2)]">
                Credits available: <span className="font-semibold text-[var(--mc-gold)]">{userCredits}</span>
              </p>
              <p className="text-sm text-[var(--mc-text-2)]">
                Cost: <span className="font-semibold text-[var(--mc-text-1)]">1 credit</span> (200 viewing hours)
              </p>
            </div>

            {/* Title Field */}
            <div className="mb-6">
              <label className="block text-sm font-medium mb-2">Event Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Sofia's Quinceañera"
                className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:ring-2 focus:ring-[var(--mc-gold)] text-[var(--mc-text-1)]"
                required
              />
              <p className="text-[var(--mc-text-2)] text-sm mt-1">
                This will be the watch page name
              </p>
            </div>

            {/* Scheduled Date & Time Field */}
            <div className="mb-6">
              <label className="block text-sm font-medium mb-2">
                Event Date and Time
              </label>
              <input
                type="datetime-local"
                value={scheduledDateTime}
                onChange={(e) => setScheduledDateTime(e.target.value)}
                min={minDateTime}
                step={900}
                className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:ring-2 focus:ring-[var(--mc-gold)] text-[var(--mc-text-1)]"
                required
              />
              <p className="text-[var(--mc-text-2)] text-sm mt-1">
                When should viewers expect the stream to start?
              </p>
            </div>

            {/* Timezone Selector */}
            <div className="mb-6">
              <label className="block text-sm font-medium mb-2">
                Event Timezone
              </label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:ring-2 focus:ring-[var(--mc-gold)] text-[var(--mc-text-1)]"
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
              <p className="text-[var(--mc-text-2)] text-sm mt-1">
                The event's local timezone (used for the viewer countdown)
              </p>
            </div>

            {/* Viewing Hours Estimator */}
            <div className="mb-8 bg-[var(--mc-surface-2)] rounded-lg p-5 border border-[var(--mc-border)]">
              <label className="block text-sm font-medium mb-4">Viewing Hours Estimator</label>

              {/* Duration slider */}
              <div className="mb-4">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-[var(--mc-text-2)]">Expected event length</span>
                  <span className="font-semibold">{estDuration} hour{estDuration !== 1 ? 's' : ''}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={12}
                  step={1}
                  value={estDuration}
                  onChange={(e) => setEstDuration(Number(e.target.value))}
                  className="w-full accent-[var(--mc-gold)]"
                />
                <div className="flex justify-between text-xs text-[var(--mc-text-3)] mt-0.5">
                  <span>1 hr</span>
                  <span>6 hrs</span>
                  <span>12 hrs</span>
                </div>
              </div>

              {/* Viewers slider */}
              <div className="mb-4">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-[var(--mc-text-2)]">Expected viewers</span>
                  <span className="font-semibold">{estViewers}</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={500}
                  step={10}
                  value={estViewers}
                  onChange={(e) => setEstViewers(Number(e.target.value))}
                  className="w-full accent-[var(--mc-gold)]"
                />
                <div className="flex justify-between text-xs text-[var(--mc-text-3)] mt-0.5">
                  <span>10</span>
                  <span>250</span>
                  <span>500</span>
                </div>
              </div>

              {/* Estimate result */}
              <div className="mt-4 pt-4 border-t border-[var(--mc-border)]">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-[var(--mc-text-2)]">Estimated viewing hours</span>
                  <span className="text-lg font-bold">{estViewingHours.toLocaleString()} hrs</span>
                </div>

                {/* Recommendation message */}
                <div className={`mt-3 rounded-lg p-3 text-sm ${
                  estViewingHours <= HOURS_PER_CREDIT
                    ? 'bg-[var(--mc-success-bg)] text-[var(--mc-success)]'
                    : 'bg-[var(--mc-info-bg)] text-[var(--mc-info)]'
                }`}>
                  {estViewingHours <= HOURS_PER_CREDIT ? (
                    <>
                      ✓ <span className="font-medium">1 credit covers this event.</span> You'll have {HOURS_PER_CREDIT - estViewingHours} hours of headroom.
                    </>
                  ) : (
                    <>
                      ℹ This event may use ~{estCreditsNeeded} credits ({estViewingHours.toLocaleString()} hrs).{' '}
                      <span className="font-medium">Start with 1 credit (200 hrs) and add more anytime</span> from the event page if needed. No need to over-allocate upfront.
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="bg-[var(--mc-live-bg)] text-[var(--mc-live)] p-4 rounded-lg mb-6 border border-red-200">
                {error}
              </div>
            )}

            {/* Submit Button */}
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => router.back()}
                className="flex-1 px-6 py-3 border border-[var(--mc-border)] rounded-lg hover:bg-[var(--mc-surface-2)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-colors"
              >
                {loading ? 'Creating...' : 'Create Event (1 Credit)'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}