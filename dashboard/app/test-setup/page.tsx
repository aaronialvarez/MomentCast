'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

interface TestEventData {
  eventId: string;
  slug: string;
  liveInputId?: string;
  watchUrl: string;
  rtmpsUrl: string;
  rtmpsKey: string;
  armedAt?: string | null;
  connectedAt?: string | null;
  sessionsRemainingToday?: number;
}

const SESSION_CAP_SECONDS = 15 * 60;
const POLL_INTERVAL_MS = 8000;

// Formats a whole number of seconds as M:SS for the countdown displays.
function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
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
  const [actionLoading, setActionLoading] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Cooldown: seconds remaining before another session can start.
  const [cooldownSeconds, setCooldownSeconds] = useState<number | null>(null);
  // Daily limit: human-readable message when the 3/day cap is hit. Separate
  // from cooldown since it isn't a short countdown — resets at UTC midnight.
  const [dailyLimitMessage, setDailyLimitMessage] = useState<string | null>(null);

  // Session countdown: only runs once OBS has actually connected, mirrors
  // exactly what the 15-min cap cron enforces server-side (keyed off
  // connectedAt, not armedAt) so this never drifts out of sync with reality.
  const [sessionSecondsLeft, setSessionSecondsLeft] = useState<number | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cooldownTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const armed = !!testEvent?.armedAt;
  const connected = !!testEvent?.connectedAt;

  async function getAuthToken(): Promise<string | null> {
    const { data: authData } = await supabase.auth.getSession();
    if (!authData?.session) {
      router.push('/login');
      return null;
    }
    return authData.session.access_token;
  }

  function clearPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function clearSessionTick() {
    if (sessionTickRef.current) {
      clearInterval(sessionTickRef.current);
      sessionTickRef.current = null;
    }
  }

  function clearCooldownTick() {
    if (cooldownTickRef.current) {
      clearInterval(cooldownTickRef.current);
      cooldownTickRef.current = null;
    }
  }

  // Stops the session server-side without surfacing a fresh error banner —
  // used for the auto-exit-at-zero path, where the user didn't ask for this,
  // the timer did, so a failure here shouldn't read as something they broke.
  const silentStop = useCallback(async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/test-event/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch (err) {
      console.error('Auto-stop error:', err);
    }
  }, [supabase]);

  // Fetches current state from the server. Used for the initial load and
  // every poll tick while armed — this is what makes the page self-healing:
  // if the cap cron (or a disconnect) changes things server-side, the next
  // poll picks it up without the user having to refresh.
  const refresh = useCallback(async (): Promise<TestEventData | null> => {
    const token = await getAuthToken();
    if (!token) return null;

    const response = await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/test-event`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to load test event');
    }

    const data: TestEventData = await response.json();
    setTestEvent(data);
    return data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  // Initial load.
  useEffect(() => {
    async function load() {
      try {
        await refresh();
      } catch (err) {
        console.error('Test event load error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load test event');
      } finally {
        setLoading(false);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling while armed: detects connection, detects server-side changes
  // (cap firing, a stray disconnect), keeps the UI honest without a manual
  // refresh. Stops itself the moment the row isn't armed anymore.
  useEffect(() => {
    clearPolling();
    if (!armed) return;

    pollRef.current = setInterval(async () => {
      try {
        const data = await refresh();
        if (data && !data.armedAt) {
          // Session ended server-side (cap cron, or something else) while
          // this tab was open. Reflect it immediately, start the cooldown
          // display, no manual refresh needed.
          clearSessionTick();
          setSessionSecondsLeft(null);
          setCooldownSeconds(SESSION_CAP_SECONDS); // best available estimate; corrected on next 429
        }
      } catch (err) {
        console.error('Poll error:', err);
      }
    }, POLL_INTERVAL_MS);

    return clearPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed]);

  // Session countdown: starts only once connectedAt is populated, ticks
  // every second, auto-stops and redirects at zero.
  useEffect(() => {
    clearSessionTick();
    if (!connected || !testEvent?.connectedAt) {
      setSessionSecondsLeft(null);
      return;
    }

    const connectedAtMs = new Date(testEvent.connectedAt).getTime();

    function tick() {
      const elapsed = (Date.now() - connectedAtMs) / 1000;
      const remaining = SESSION_CAP_SECONDS - elapsed;
      if (remaining <= 0) {
        setSessionSecondsLeft(0);
        clearSessionTick();
        clearPolling();
        silentStop().finally(() => router.push('/'));
        return;
      }
      setSessionSecondsLeft(remaining);
    }

    tick();
    sessionTickRef.current = setInterval(tick, 1000);
    return clearSessionTick;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, testEvent?.connectedAt]);

  // Cooldown countdown: ticks every second, clears itself at zero so the
  // Start button re-enables without needing a page reload.
  useEffect(() => {
    clearCooldownTick();
    if (cooldownSeconds === null) return;
    if (cooldownSeconds <= 0) {
      setCooldownSeconds(null);
      return;
    }

    cooldownTickRef.current = setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearCooldownTick();
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return clearCooldownTick;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cooldownSeconds !== null]);

  useEffect(() => {
    return () => {
      clearPolling();
      clearSessionTick();
      clearCooldownTick();
    };
  }, []);

  async function handleStart() {
    setError(null);
    setDailyLimitMessage(null);
    setActionLoading(true);
    try {
      const token = await getAuthToken();
      if (!token) return;

      const response = await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/test-event/start`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const data = await response.json();

      if (response.status === 429) {
        if (typeof data.retryAfterSeconds === 'number') {
          setCooldownSeconds(data.retryAfterSeconds);
        } else if (data.resetsAt) {
          const resetLocal = new Date(data.resetsAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          });
          setDailyLimitMessage(
            `You've used all 3 test sessions for today. You can start another after ${resetLocal} (your local time).`
          );
        } else {
          setError(data.error || 'Please wait before starting another test session');
        }
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start test session');
      }

      setTestEvent(data);
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
      const token = await getAuthToken();
      if (!token) return;

      const response = await fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/test-event/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to stop test session');
      }

      const data = await response.json();

      clearSessionTick();
      clearPolling();
      setSessionSecondsLeft(null);
      setTestEvent((prev) => (prev ? { ...prev, armedAt: null, connectedAt: null } : prev));
      // Only a session that actually connected costs a cooldown or moves
      // the daily count — a stop before anything streamed is a free cancel,
      // so there's nothing new to fetch in that case.
      if (data.counted) {
        setCooldownSeconds(SESSION_CAP_SECONDS);
        refresh().catch((err) => console.error('Post-stop refresh error:', err));
      }
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

  const cooldownActive = cooldownSeconds !== null && cooldownSeconds > 0;
  const startDisabled = actionLoading || cooldownActive || !!dailyLimitMessage;

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
              Check your camera, audio, and streaming setup before a real event, no credit used.
              Works with any software that streams over RTMPS, OBS, Streamlabs, or similar.
              Sessions run up to 15 minutes once connected and auto-stop, nothing is saved,
              this is a gear check, not a recording.{' '}
              {typeof testEvent?.sessionsRemainingToday === 'number' ? (
                <>
                  You have <strong>{testEvent.sessionsRemainingToday} of 3</strong> test
                  {testEvent.sessionsRemainingToday === 1 ? ' session' : ' sessions'} left today,
                  with a 15-minute wait between them.
                </>
              ) : (
                'Up to 3 sessions per day, with a 15-minute wait between them.'
              )}
            </p>

            {error && (
              <div className="bg-[var(--mc-live-bg)] text-[var(--mc-live)] p-4 rounded-lg mb-6 border border-red-200">
                {error}
              </div>
            )}

            {dailyLimitMessage && (
              <div className="bg-[var(--mc-info-bg)] text-[var(--mc-info)] p-4 rounded-lg mb-6">
                {dailyLimitMessage}
              </div>
            )}

            {!armed ? (
              <>
                {cooldownActive && (
                  <div className="bg-[var(--mc-surface-2)] rounded-lg p-4 mb-4 text-center">
                    <p className="text-[var(--mc-text-2)] text-sm mb-1">Next test session available in</p>
                    <p className="text-2xl font-bold tabular-nums">{formatMMSS(cooldownSeconds!)}</p>
                  </div>
                )}
                <button
                  onClick={handleStart}
                  disabled={startDisabled}
                  className="w-full px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-colors"
                >
                  {actionLoading ? 'Starting...' : 'Start Test Session'}
                </button>
              </>
            ) : (
              <>
                <div className="mb-6 rounded-lg p-4 text-center bg-[var(--mc-surface-2)]">
                  {connected ? (
                    <>
                      <p className="text-[var(--mc-text-2)] text-sm mb-1">
                        Streaming — session ends automatically in
                      </p>
                      <p className="text-2xl font-bold tabular-nums">
                        {sessionSecondsLeft !== null ? formatMMSS(sessionSecondsLeft) : '15:00'}
                      </p>
                    </>
                  ) : (
                    <p className="text-[var(--mc-text-2)]">
                      Waiting for your streaming software to connect. Enter the RTMPS
                      details below into your app and start streaming. The 15-minute timer
                      starts once it connects.
                    </p>
                  )}
                </div>

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

                <p className="text-[var(--mc-text-3)] text-xs mb-6 font-mono">
                  Live Input ID: {testEvent?.liveInputId} — for support/debugging
                </p>

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