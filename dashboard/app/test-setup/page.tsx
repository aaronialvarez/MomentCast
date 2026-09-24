'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

interface TestEventData {
  eventId: string;
  slug: string;
  watchUrl: string;
  rtmpsUrl: string;
  rtmpsKey: string;
  armed?: boolean;
  connected?: boolean;
}

export default function TestSetupPage() {
  const router = useRouter();
  const [supabase] = useState(() =>
    createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  );

  const [loading, setLoading] = useState(true);
  const [testEvent, setTestEvent] = useState<TestEventData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Fetch (or lazily create) the permanent test event on load
  useEffect(() => {
    async function load() {
      try {
        const { data: authData } = await supabase.auth.getSession();
        if (!authData?.session) {
          router.push('/login');
          return;
        }

        const response = await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/test-event`, {
          headers: { 'Authorization': `Bearer ${authData.session.access_token}` },
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to load test event');
        }

        const data = await response.json();
        setTestEvent(data);
        setArmed(!!data.armed);
      } catch (err) {
        console.error('Test event load error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load test event');
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [supabase, router]);

  async function handleStart() {
    setError(null);
    setActionLoading(true);
    try {
      const { data: authData } = await supabase.auth.getSession();
      if (!authData?.session) {
        router.push('/login');
        return;
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/test-event/start`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authData.session.access_token}` },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to start test session');
      }

      const data = await response.json();
      setTestEvent((prev) => (prev ? { ...prev, ...data } : data));
      setArmed(true);
    } catch (err) {
      console.error('Test event start error:', err);
      setError(err instanceof Error ? err.message : 'Failed to start test session');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStop() {
    setError(null);
    setActionLoading(true);
    try {
      const { data: authData } = await supabase.auth.getSession();
      if (!authData?.session) {
        router.push('/login');
        return;
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/test-event/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authData.session.access_token}` },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to stop test session');
      }

      setArmed(false);
    } catch (err) {
      console.error('Test event stop error:', err);
      setError(err instanceof Error ? err.message : 'Failed to stop test session');
    } finally {
      setActionLoading(false);
    }
  }

  function copyToClipboard(value: string, field: string) {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }

  return (
    <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-1)]">
      {/* Header */}
      <div className="bg-[#1a1a1f] p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl font-bold text-white">Test Your Setup</h1>
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-8">
        {loading ? (
          <div className="bg-[var(--mc-surface)] rounded-lg p-12 border border-[var(--mc-border)] text-center text-[var(--mc-text-2)]">
            Loading...
          </div>
        ) : (
          <div className="bg-[var(--mc-surface)] rounded-lg p-8 border border-[var(--mc-border)]">
            <p className="text-[var(--mc-text-2)] mb-6">
              Check your OBS setup, camera, and audio before a real event, no credit used,
              no time restriction. Sessions auto-stop after 15 minutes and nothing is saved,
              this is a gear check, not a recording.
            </p>

            {error && (
              <div className="bg-[var(--mc-live-bg)] text-[var(--mc-live)] p-4 rounded-lg mb-6 border border-red-200">
                {error}
              </div>
            )}

            {!armed ? (
              <button
                onClick={handleStart}
                disabled={actionLoading}
                className="w-full px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-colors"
              >
                {actionLoading ? 'Starting...' : 'Start Test Session'}
              </button>
            ) : (
              <>
                <div className="mb-6">
                  <label className="block text-sm font-medium mb-2">RTMPS Server URL</label>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={testEvent?.rtmpsUrl || ''}
                      className="flex-1 px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded text-[var(--mc-text-1)]"
                    />
                    <button
                      onClick={() => copyToClipboard(testEvent?.rtmpsUrl || '', 'url')}
                      className="px-4 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg font-semibold transition-colors"
                    >
                      {copiedField === 'url' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>

                <div className="mb-6">
                  <label className="block text-sm font-medium mb-2">Stream Key</label>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      type="password"
                      value={testEvent?.rtmpsKey || ''}
                      className="flex-1 px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded text-[var(--mc-text-1)]"
                    />
                    <button
                      onClick={() => copyToClipboard(testEvent?.rtmpsKey || '', 'key')}
                      className="px-4 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg font-semibold transition-colors"
                    >
                      {copiedField === 'key' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>

                <div className="mb-8">
                  <label className="block text-sm font-medium mb-2">Watch Page URL</label>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={testEvent?.watchUrl || ''}
                      className="flex-1 px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded text-[var(--mc-text-1)]"
                    />
                    <button
                      onClick={() => copyToClipboard(testEvent?.watchUrl || '', 'watch')}
                      className="px-4 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg font-semibold transition-colors"
                    >
                      {copiedField === 'watch' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-[var(--mc-text-2)] text-sm mt-1">
                    Open this in another tab or browser to see what your test stream looks like.
                  </p>
                </div>

                <button
                  onClick={handleStop}
                  disabled={actionLoading}
                  className="w-full px-6 py-3 border border-[var(--mc-border)] hover:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed rounded-lg font-semibold transition-colors"
                >
                  {actionLoading ? 'Stopping...' : 'Stop Test Session'}
                </button>
              </>
            )}

            <button
              onClick={() => router.push('/')}
              className="w-full mt-4 px-6 py-3 text-[var(--mc-text-3)] hover:text-[var(--mc-text-1)] transition-colors"
            >
              Back to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}