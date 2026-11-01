'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * "Keep This Replay Longer" card on an ended event's page.
 *
 * Every number shown comes from the worker (GET /api/events/:slug/storage-extension), the
 * same quote the purchase uses, so the page never offers a price the worker would refuse.
 * Buying POSTs { credits }; the worker recomputes, charges atomically, and pushes the new
 * expiry to Cloudflare. The parent then updates its own copy of the event and credit balance.
 */

type Option = { credits: number; months: number; newExpiry: string };
type Quote =
  | { eligible: false; reason: string }
  | {
      eligible: true;
      recordedMinutes: number;
      currentExpiry: string;
      extendedMonths: number;
      remainingMonths: number;
      maxMonths: number;
      options: Option[];
    };

export default function StorageExtensionCard({
  slug,
  supabase,
  userCredits,
  viewerHours,
  formatDay,
  onExtended,
}: {
  slug: string;
  supabase: any;
  userCredits: number | null;
  viewerHours: { used: number; limit: number } | null; // from the page's Viewing Hours meter
  formatDay: (d: Date) => string;
  onExtended: (result: { newExpiry: string; creditsRemaining: number }) => void;
}) {
  const router = useRouter();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null); // credits of the chosen option
  const [buying, setBuying] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const workerFetch = useCallback(async (init?: RequestInit) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      router.push('/login');
      return null;
    }
    return fetch(`${process.env.NEXT_PUBLIC_WORKER_API_URL}/api/events/${slug}/storage-extension`, {
      ...init,
      headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    });
  }, [supabase, slug, router]);

  const loadQuote = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await workerFetch();
      if (!res) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load storage options');
      setQuote(data);
      setSelected(data.eligible && data.options.length > 0 ? data.options[0].credits : null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load storage options');
    }
  }, [workerFetch]);

  useEffect(() => { loadQuote(); }, [loadQuote]);

  async function handleBuy() {
    if (!quote?.eligible || selected === null) return;
    const option = quote.options.find(o => o.credits === selected);
    if (!option) return;

    const ok = window.confirm(
      `Spend ${option.credits} credit${option.credits !== 1 ? 's' : ''} to keep this replay online until ` +
      `${formatDay(new Date(option.newExpiry))} (+${option.months} month${option.months !== 1 ? 's' : ''})?\n\n` +
      `This doesn't add viewing hours` +
      (hoursLeft !== null && viewerHours ? ` (${hoursLeft.toFixed(1)} of ${viewerHours.limit} hours left).` : '.') +
      ` Storage credits are non-refundable.`
    );
    if (!ok) return;

    setBuying(true);
    setMessage(null);
    try {
      const res = await workerFetch({ method: 'POST', body: JSON.stringify({ credits: option.credits }) });
      if (!res) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not extend storage');

      onExtended({ newExpiry: data.newExpiry, creditsRemaining: data.creditsRemaining });
      setMessage({ text: `Done. This replay now stays online until ${formatDay(new Date(data.newExpiry))}.`, error: false });
      await loadQuote(); // the remaining options shrink after a purchase
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Could not extend storage', error: true });
      await loadQuote(); // a stale option is the usual cause; show the current ones
    } finally {
      setBuying(false);
    }
  }

  const cheapest = quote?.eligible ? quote.options[0]?.credits ?? null : null;
  // Viewing hours left on the event, shown in the notice and the purchase confirmation
  const hoursLeft = viewerHours ? Math.max(0, viewerHours.limit - viewerHours.used) : null;
  const cannotAfford = userCredits !== null && cheapest !== null && userCredits < cheapest;

  return (
    <div className="bg-[var(--mc-surface)] rounded-lg p-6 mb-6 border border-[var(--mc-border)]">
      <h3 className="text-lg font-semibold mb-1">Keep This Replay Longer</h3>

      {!quote && !loadError && (
        <p className="text-[var(--mc-text-3)] text-sm">Checking your recordings…</p>
      )}

      {loadError && (
        <p className="text-[var(--mc-live)] text-sm">
          {loadError}{' '}
          <button onClick={loadQuote} className="underline">Try again</button>
        </p>
      )}

      {quote && !quote.eligible && (
        <p className="text-[var(--mc-text-2)] text-sm">{quote.reason}</p>
      )}

      {quote?.eligible && (
        <>
          <p className="text-[var(--mc-text-2)] text-sm mb-4">
            This replay is deleted on {formatDay(new Date(quote.currentExpiry))}. Spend credits to keep it
            online longer, up to {quote.maxMonths} extra months in total.
            {quote.extendedMonths > 0 && ` Already extended ${quote.extendedMonths} month${quote.extendedMonths !== 1 ? 's' : ''}.`}
          </p>

          <div className="space-y-2 mb-4">
            {quote.options.map(o => {
              const affordable = userCredits === null || userCredits >= o.credits;
              return (
                <label
                  key={o.credits}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selected === o.credits
                      ? 'border-[var(--mc-gold)] bg-[var(--mc-surface-2)]'
                      : 'border-[var(--mc-border)]'
                  } ${affordable ? '' : 'opacity-50 cursor-not-allowed'}`}
                >
                  <input
                    type="radio"
                    name="storage-extension"
                    checked={selected === o.credits}
                    disabled={!affordable || buying}
                    onChange={() => setSelected(o.credits)}
                  />
                  <span className="text-sm">
                    <span className="font-semibold">{o.credits} credit{o.credits !== 1 ? 's' : ''}</span>
                    {' '}keeps it online until{' '}
                    <span className="font-semibold">{formatDay(new Date(o.newExpiry))}</span>
                    <span className="text-[var(--mc-text-3)]"> (+{o.months} month{o.months !== 1 ? 's' : ''})</span>
                  </span>
                </label>
              );
            })}
          </div>

          {cannotAfford ? (
            <button
              onClick={() => router.push('/?buyCredits=true')}
              className="px-5 py-2.5 bg-[var(--mc-info)] hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              Buy Credits to Extend Storage
            </button>
          ) : (
            <button
              onClick={handleBuy}
              disabled={buying || selected === null}
              className="px-5 py-2.5 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {buying ? 'Extending…' : 'Extend Storage'}
            </button>
          )}
          <p className="text-xs text-[var(--mc-text-3)] mt-1.5">
            {userCredits !== null && `${userCredits} credit${userCredits !== 1 ? 's' : ''} available. `}
            Storage credits are non-refundable.
          </p>

          {/* Storage and viewing hours are separate purchases. Say so, with the real numbers,
              so nobody pays to keep a replay online that guests can no longer open. */}
          {viewerHours && (
            viewerHours.used >= viewerHours.limit ? (
              <p className="text-sm text-[var(--mc-live)] mt-3">
                This event has no viewing hours left, so guests can&apos;t open the replay. Extending storage
                doesn&apos;t add hours. Add viewing hours on this page first.
              </p>
            ) : (
              <p className="text-xs text-[var(--mc-text-3)] mt-3">
                Extending storage doesn&apos;t add viewing hours: {hoursLeft?.toFixed(1)} of{' '}
                {viewerHours.limit} hours left. Add more anytime from Viewing Hours on this page.
              </p>
            )
          )}
        </>
      )}

      {message && (
        <p className={`mt-3 text-sm font-medium ${message.error ? 'text-[var(--mc-live)]' : 'text-[var(--mc-success)]'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}