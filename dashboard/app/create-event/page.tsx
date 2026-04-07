'use client';

import { useState } from 'react';
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
  const [tier, setTier] = useState<'standard' | 'premium'>('standard');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          tier,
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
        <form onSubmit={handleSubmit} className="bg-[var(--mc-surface)] rounded-lg p-8 border border-[var(--mc-border)]">
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
              step={900} // 15-minute increments
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

          {/* Tier Selection */}
          <div className="mb-8">
            <label className="block text-sm font-medium mb-3">Event Tier</label>
            <div className="space-y-3">
              {/* Standard Tier */}
              <div
                className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                  tier === 'standard'
                    ? 'border-[var(--mc-gold)] bg-[var(--mc-gold-dim)]'
                    : 'border-[var(--mc-border)] hover:border-[var(--mc-text-3)]'
                }`}
                onClick={() => setTier('standard')}
              >
                <div className="flex items-center">
                  <input
                    type="radio"
                    name="tier"
                    value="standard"
                    checked={tier === 'standard'}
                    onChange={() => setTier('standard')}
                    className="mr-3"
                  />
                  <div>
                    <div className="font-medium">1 Credit - 400 viewer hours</div>
                    <div className="text-sm text-[var(--mc-text-2)]">$40 • Perfect for most events</div>
                  </div>
                </div>
              </div>

              {/* Premium Tier */}
              <div
                className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                  tier === 'premium'
                    ? 'border-[var(--mc-gold)] bg-[var(--mc-gold-dim)]'
                    : 'border-[var(--mc-border)] hover:border-[var(--mc-text-3)]'
                }`}
                onClick={() => setTier('premium')}
              >
                <div className="flex items-center">
                  <input
                    type="radio"
                    name="tier"
                    value="premium"
                    checked={tier === 'premium'}
                    onChange={() => setTier('premium')}
                    className="mr-3"
                  />
                  <div>
                    <div className="font-medium">2 Credits - 1,000 viewer hours</div>
                    <div className="text-sm text-[var(--mc-text-2)]">$70 • For long events or large audiences</div>
                  </div>
                </div>
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
              {loading ? 'Creating...' : 'Create Event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}