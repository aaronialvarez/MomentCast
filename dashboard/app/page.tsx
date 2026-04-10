'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface User {
  id: string;
  email: string;
  credits: number;
  logo_url: string | null;
}

interface Event {
  id: string;
  slug: string;
  title: string;
  scheduled_date: string;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled' | 'ready';
  stream_state: 'inactive' | 'active' | 'paused' | 'finalized';
  timezone?: string;
}

interface CreditTransaction {
  id: string;
  amount: number;
  type: string;
  event_id: string | null;
  created_at: string;
  // Joined from events table
  events?: { title: string; slug: string } | null;
}

export default function DashboardHome() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());

  const [user, setUser] = useState<User | null>(null);  // This was missing!
  const [events, setEvents] = useState<Event[]>([]);
  const [endedEvents, setEndedEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMoreEnded, setLoadingMoreEnded] = useState(false);
  const [hasMoreEnded, setHasMoreEnded] = useState(true);
  const [endedPage, setEndedPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Logo upload state
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const ENDED_EVENTS_PER_PAGE = 20; // Change to 20 in production
  // Credit history state
  const [creditHistory, setCreditHistory] = useState<CreditTransaction[]>([]);
  const [showCreditHistory, setShowCreditHistory] = useState(false);

  // Cancelled events state
  const [cancelledEvents, setCancelledEvents] = useState<Event[]>([]);
  const [showCancelled, setShowCancelled] = useState(false);

  // Buy Credits state
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseMessage, setPurchaseMessage] = useState<string | null>(null);

  // Credit pricing tiers — launch promo (15% off $35 regular)
  const CREDIT_TIERS = [
    { id: 'single',  credits: 1,  regular: 35.00, promo: 29.99, label: '1 Credit' },
    { id: 'pro5',    credits: 5,  regular: 175.00, promo: 137.99, label: '5 Credits', badge: 'Most Popular' },
    { id: 'studio10', credits: 10, regular: 350.00, promo: 259.99, label: '10 Credits', badge: 'Best Value' },
  ] as const;

  useEffect(() => {
    async function loadDashboard() {
      console.log('🚀 Dashboard v2.0 - Loading with optimized queries');
      
      try {
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
        
        if (authError || !authUser) {
          window.location.href = '/login';
          return;
        }

        // Fetch user data
        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('*')
          .eq('id', authUser.id)
          .single();

        if (userError) {
          console.error('User fetch error:', userError);
          setError('Failed to load user data');
          setLoading(false);
          return;
        }

        setUser(userData);
        console.log('✅ User loaded:', userData.email);

        // Fetch ALL upcoming/active events (no limit needed)
        console.log('📊 Fetching active events...');
        const startTime = performance.now();
        
        const { data: activeEvents, error: activeError } = await supabase
          .from('events')
          .select('id, slug, title, scheduled_date, status, stream_state, timezone')
          .eq('user_id', authUser.id)
          .in('status', ['live', 'ready', 'scheduled'])
          .order('scheduled_date', { ascending: true });

        const loadTime = performance.now() - startTime;
        console.log(`✅ Active events loaded in ${loadTime.toFixed(0)}ms:`, activeEvents?.length || 0);

        if (activeError) {
          console.error('Events fetch error:', activeError);
          setError('Failed to load events');
          setLoading(false);
          return;
        }

        // Sort by status priority: live > ready > scheduled
        const sortedEvents = (activeEvents || []).sort((a, b) => {
          const statusPriority: Record<string, number> = { live: 0, ready: 1, scheduled: 2 };
          const aPriority = statusPriority[a.status] ?? 999;
          const bPriority = statusPriority[b.status] ?? 999;
          const priorityDiff = aPriority - bPriority;
          
          if (priorityDiff !== 0) return priorityDiff;
          
          return new Date(a.scheduled_date).getTime() - new Date(b.scheduled_date).getTime();
        });

        setEvents(sortedEvents);
        setLoading(false);
        console.log('✅ Dashboard rendered with active events');

        // Load first page of ended events in background
        loadEndedEvents(authUser.id);

        // Handle Stripe redirect: show success/cancelled message
        const urlParams = new URLSearchParams(window.location.search);
        const purchaseStatus = urlParams.get('purchase');
        if (purchaseStatus === 'success') {
          const creditCount = urlParams.get('credits') || '?';
          setPurchaseMessage(`Payment successful! ${creditCount} credit${creditCount !== '1' ? 's' : ''} added to your account.`);
          // Clean up URL params without reload
          window.history.replaceState({}, '', window.location.pathname);
        } else if (purchaseStatus === 'cancelled') {
          setPurchaseMessage('Purchase cancelled. No charges were made.');
          setShowBuyCredits(true);
          window.history.replaceState({}, '', window.location.pathname);
        }

        // Auto-open buy panel when redirected from event detail "Buy Credits" button
        if (urlParams.get('buyCredits') === 'true') {
          setShowBuyCredits(true);
          window.history.replaceState({}, '', window.location.pathname);
        }

      } catch (err) {
        console.error('Dashboard load error:', err);
        setError('Failed to load dashboard');
        setLoading(false);
      }
    }

    loadDashboard();
  }, [supabase, router]);

  async function loadEndedEvents(userId?: string) {
    if (loadingMoreEnded || !hasMoreEnded) return;
    
    setLoadingMoreEnded(true);
    console.log(`📊 Loading ended events page ${endedPage + 1}...`);
    
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const targetUserId = userId || authUser?.id;
    
    if (!targetUserId) {
      setLoadingMoreEnded(false);
      return;
    }
    
    const offset = endedPage * ENDED_EVENTS_PER_PAGE;
    
    const { data: moreEndedEvents, error } = await supabase
      .from('events')
      .select('id, slug, title, scheduled_date, status, stream_state, timezone')
      .eq('user_id', targetUserId)
      .eq('status', 'ended')
      .order('scheduled_date', { ascending: false })
      .range(offset, offset + ENDED_EVENTS_PER_PAGE - 1);
    
    if (error) {
      console.error('Error loading ended events:', error);
      setLoadingMoreEnded(false);
      return;
    }
    
    console.log(`✅ Loaded ${moreEndedEvents?.length || 0} ended events`);
    
    if (!moreEndedEvents || moreEndedEvents.length < ENDED_EVENTS_PER_PAGE) {
      setHasMoreEnded(false);
      console.log('📭 No more ended events');
    }
    
    setEndedEvents(prev => [...prev, ...(moreEndedEvents || [])]);
    setEndedPage(prev => prev + 1);
    setLoadingMoreEnded(false);
  }

  async function loadCreditHistory() {
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) return;

      const { data, error } = await supabase
        .from('credit_transactions')
        .select('id, amount, type, event_id, created_at, stripe_session_id, events(title, slug)')
        .eq('user_id', authUser.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        console.error('Credit history fetch error:', error);
        return;
      }

      // Fix — cast through unknown first
      setCreditHistory((data as unknown as CreditTransaction[]) || []);
    } catch (err) {
      console.error('Credit history error:', err);
    }
  }

  async function loadCancelledEvents() {
    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) return;

      const { data, error } = await supabase
        .from('events')
        .select('id, slug, title, scheduled_date, status, stream_state, timezone')
        .eq('user_id', authUser.id)
        .eq('status', 'cancelled')
        .order('scheduled_date', { ascending: false });

      if (error) {
        console.error('Cancelled events fetch error:', error);
        return;
      }

      setCancelledEvents(data || []);
    } catch (err) {
      console.error('Cancelled events error:', err);
    }
  }

  // Upload logo to Supabase Storage, save public URL to users table
  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    // Client-side validation: 100 KB max
    const MAX_SIZE = 100 * 1024;
    if (file.size > MAX_SIZE) {
      setLogoError('Logo must be under 100 KB');
      return;
    }

    // Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      setLogoError('Accepted formats: PNG, JPG, SVG, WebP');
      return;
    }

    setLogoUploading(true);
    setLogoError(null);

    try {
      // Determine file extension from MIME type
      const ext = file.type === 'image/svg+xml' ? 'svg'
        : file.type === 'image/webp' ? 'webp'
        : file.type === 'image/png' ? 'png'
        : 'jpg';
      const storagePath = `${user.id}/logo.${ext}`;

      // Upload to Supabase Storage (upsert to overwrite previous logo)
      const { error: uploadError } = await supabase.storage
        .from('logos')
        .upload(storagePath, file, { upsert: true, contentType: file.type });

      if (uploadError) {
        throw new Error(uploadError.message);
      }

      // Get the public URL
      const { data: urlData } = supabase.storage
        .from('logos')
        .getPublicUrl(storagePath);

      // Cache-bust: append timestamp so browsers fetch the new file
      const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

      // Save URL to users table
      const { error: updateError } = await supabase
        .from('users')
        .update({ logo_url: publicUrl })
        .eq('id', user.id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      // Update local state immediately
      setUser({ ...user, logo_url: publicUrl });
      console.log('✅ Logo uploaded:', publicUrl);
    } catch (err: any) {
      console.error('Logo upload error:', err);
      setLogoError(err.message || 'Upload failed');
    } finally {
      setLogoUploading(false);
      // Reset file input so the same file can be re-selected
      e.target.value = '';
    }
  }

  // Remove logo: delete from storage + null the DB column
  async function handleLogoRemove() {
    if (!user || !user.logo_url) return;

    setLogoUploading(true);
    setLogoError(null);

    try {
      // List files in user's logo folder to find the exact filename
      const { data: files } = await supabase.storage
        .from('logos')
        .list(user.id);

      // Delete all files in the user's logo folder (should only be one)
      if (files && files.length > 0) {
        const filePaths = files.map((f) => `${user.id}/${f.name}`);
        await supabase.storage.from('logos').remove(filePaths);
      }

      // Null out the DB column
      const { error: updateError } = await supabase
        .from('users')
        .update({ logo_url: null })
        .eq('id', user.id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      setUser({ ...user, logo_url: null });
      console.log('✅ Logo removed');
    } catch (err: any) {
      console.error('Logo remove error:', err);
      setLogoError(err.message || 'Remove failed');
    } finally {
      setLogoUploading(false);
    }
  }

  /**
   * Purchase credits via Stripe Checkout.
   * Creates a Checkout Session on the Worker, then redirects to Stripe.
   * Falls back to direct Supabase write in test mode (toggle below).
   */
  const TEST_MODE = false; // Set true to bypass Stripe and add credits directly

  async function handlePurchase(tierId: string) {
    if (!user) return;
    
    const tier = CREDIT_TIERS.find(t => t.id === tierId);
    if (!tier) return;

    setPurchasing(true);
    setPurchaseMessage(null);

    try {
      if (TEST_MODE) {
        // --- TEST MODE: add credits directly (no Stripe) ---
        const { data: { user: authUser } } = await supabase.auth.getUser();
        if (!authUser) throw new Error('Not authenticated');

        const newBalance = user.credits + tier.credits;
        const { error: updateError } = await supabase
          .from('users')
          .update({ credits: newBalance })
          .eq('id', authUser.id);

        if (updateError) throw new Error(updateError.message);

        await supabase.from('credit_transactions').insert({
          user_id: authUser.id,
          amount: tier.credits,
          type: 'purchase',
          event_id: null,
        });

        setUser({ ...user, credits: newBalance });
        setPurchaseMessage(`Added ${tier.credits} credit${tier.credits > 1 ? 's' : ''}! New balance: ${newBalance}`);
        setSelectedTier(null);
        if (showCreditHistory) loadCreditHistory();
        console.log(`✅ Test purchase: +${tier.credits} credits, balance now ${newBalance}`);
      } else {
        // --- PRODUCTION: Stripe Checkout ---
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('Not authenticated');

        const response = await fetch('https://api.momentcast.live/api/checkout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ tierId }),
        });

        const data = await response.json() as { url?: string; error?: string };

        if (!response.ok || !data.url) {
          throw new Error(data.error || 'Failed to create checkout session');
        }

        // Redirect to Stripe Checkout
        window.location.href = data.url;
        return; // Don't reset purchasing state — we're navigating away
      }
    } catch (err: any) {
      console.error('Purchase error:', err);
      setPurchaseMessage(`Error: ${err.message}`);
    } finally {
      setPurchasing(false);
    }
  }

  /**
   * Test-mode credit removal: for testing the deduction flow.
   * Removes 1 credit from balance. Will be removed in Phase 2.
   */
  async function handleTestRemoveCredit() {
    if (!user || user.credits < 1) return;

    try {
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) return;

      const newBalance = user.credits - 1;
      await supabase
        .from('users')
        .update({ credits: newBalance })
        .eq('id', authUser.id);

      await supabase
        .from('credit_transactions')
        .insert({
          user_id: authUser.id,
          amount: -1,
          type: 'test_deduction',
          event_id: null,
        });

      setUser({ ...user, credits: newBalance });
      if (showCreditHistory) loadCreditHistory();
      console.log(`✅ Test deduction: -1 credit, balance now ${newBalance}`);
    } catch (err) {
      console.error('Test deduction error:', err);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-2)] flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (error && !user) {
    return (
      <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-1)] flex items-center justify-center">
        <div className="max-w-md text-center">
          <div className="bg-[var(--mc-live-bg)] text-[var(--mc-live)] p-6 rounded-lg mb-4 border border-red-200">
            {error}
          </div>
          <button
            onClick={() => router.push('/login')}
            className="px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg font-medium transition-colors"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-1)]">
      {/* Header with User Info */}
      <div className="bg-[#1a1a1f] p-8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <img src="/momentcast-logo-gold-on-dark.png" alt="MomentCast" className="h-10 w-auto" />
            <p className="text-white/60 mt-2">Manage your live events</p>
          </div>
          <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
            <div className="text-right">
              <p className="text-sm text-white/50">Logged in as</p>
              <p className="font-medium text-white">{user?.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg font-medium transition-colors border border-white/20 text-white"
            >
              Logout
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8">
        {/* Credits Section */}
        <div className="bg-[var(--mc-surface)] rounded-lg p-6 mb-8 border border-[var(--mc-border)]">
          {/* Balance row */}
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold text-[var(--mc-text-1)]">Available Credits</h2>
              <p className="text-[var(--mc-text-2)] text-sm mt-1">Each credit = 1 event with 200 viewing hours</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-5xl font-bold text-[var(--mc-gold)]">
                {user?.credits || 0}
              </div>
              <button
                onClick={() => setShowBuyCredits(!showBuyCredits)}
                className="bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white font-semibold py-2.5 px-5 rounded-lg transition-colors text-sm"
              >
                {showBuyCredits ? 'Hide' : 'Buy Credits'}
              </button>
            </div>
          </div>

          {/* Buy Credits Panel (expandable) */}
          {showBuyCredits && (
            <div className="mt-6 pt-6 border-t border-[var(--mc-border)]">
              {/* TEST MODE banner — only visible when TEST_MODE = true */}
              {TEST_MODE && (
              <div className="bg-[var(--mc-warning-bg)] border border-yellow-300 rounded-lg px-4 py-2.5 mb-5 flex items-center justify-between">
                <span className="text-[var(--mc-warning)] text-sm font-medium">
                  🧪 Test Mode — credits are added directly (no payment). Set TEST_MODE = false for Stripe.
                </span>
                <button
                  onClick={handleTestRemoveCredit}
                  disabled={!user || user.credits < 1}
                  className="text-xs px-3 py-1 bg-white border border-yellow-300 rounded text-[var(--mc-warning)] hover:bg-yellow-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Remove 1 Credit (test)
                </button>
              </div>
              )}

              {/* Tier Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {CREDIT_TIERS.map((tier) => {
                  const perCredit = (tier.promo / tier.credits).toFixed(2);
                  const isSelected = selectedTier === tier.id;
                  const regularPer = (tier.regular / tier.credits).toFixed(2);
                  
                  return (
                    <div
                      key={tier.id}
                      onClick={() => setSelectedTier(isSelected ? null : tier.id)}
                      className={`relative rounded-lg p-5 cursor-pointer transition-all border-2 ${
                        isSelected
                          ? 'border-[var(--mc-gold)] bg-[var(--mc-gold-dim)]'
                          : 'border-[var(--mc-border)] bg-[var(--mc-surface)] hover:border-[var(--mc-gold)]/40'
                      }`}
                    >
                      {/* Badge */}
                      {'badge' in tier && tier.badge && (
                        <span className="absolute -top-2.5 left-4 bg-[var(--mc-gold)] text-white text-xs font-semibold px-2.5 py-0.5 rounded-full">
                          {tier.badge}
                        </span>
                      )}

                      {/* Credit count */}
                      <p className="text-lg font-bold text-[var(--mc-text-1)]">{tier.label}</p>
                      
                      {/* Pricing */}
                      <div className="mt-3">
                        <div className="flex items-baseline gap-2">
                          <span className="text-2xl font-bold text-[var(--mc-text-1)]">
                            ${tier.promo.toFixed(2)}
                          </span>
                          <span className="text-sm text-[var(--mc-text-3)] line-through">
                            ${tier.regular.toFixed(2)}
                          </span>
                        </div>
                        {tier.credits > 1 && (
                          <p className="text-sm text-[var(--mc-text-2)] mt-1">
                            ${perCredit}/credit
                            <span className="text-[var(--mc-text-3)] line-through ml-1.5">${regularPer}</span>
                          </p>
                        )}
                      </div>

                      {/* Selected indicator */}
                      <div className={`mt-4 w-full h-8 rounded flex items-center justify-center text-sm font-medium transition-colors ${
                        isSelected
                          ? 'bg-[var(--mc-gold)] text-white'
                          : 'bg-[var(--mc-surface-2)] text-[var(--mc-text-2)]'
                      }`}>
                        {isSelected ? '✓ Selected' : 'Select'}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Purchase Button */}
              {selectedTier && (
                <div className="mt-5 flex items-center gap-4">
                  <button
                    onClick={() => handlePurchase(selectedTier)}
                    disabled={purchasing}
                    className="bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white font-semibold py-3 px-8 rounded-lg transition-colors"
                  >
                    {purchasing
                      ? 'Processing...'
                      : `Buy ${CREDIT_TIERS.find(t => t.id === selectedTier)?.label} — $${CREDIT_TIERS.find(t => t.id === selectedTier)?.promo.toFixed(2)}`
                    }
                  </button>
                </div>
              )}

              {/* Purchase feedback message */}
              {purchaseMessage && (
                <p className={`mt-3 text-sm font-medium ${
                  purchaseMessage.startsWith('Error')
                    ? 'text-[var(--mc-live)]'
                    : 'text-[var(--mc-success)]'
                }`}>
                  {purchaseMessage}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Purchase message (shown after Stripe redirect, outside the buy panel) */}
        {purchaseMessage && !showBuyCredits && (
          <div className={`-mt-4 mb-6 px-4 py-3 rounded-lg text-sm font-medium ${
            purchaseMessage.startsWith('Error') || purchaseMessage.startsWith('Purchase cancelled')
              ? 'bg-[var(--mc-live-bg)] text-[var(--mc-live)]'
              : 'bg-[var(--mc-success-bg)] text-[var(--mc-success)]'
          }`}>
            {purchaseMessage}
          </div>
        )}

        {/* Credit History Toggle */}
        <div className="mb-8 -mt-4">
          <button
            onClick={() => {
              if (!showCreditHistory) loadCreditHistory();
              setShowCreditHistory(!showCreditHistory);
            }}
            className="text-sm text-[var(--mc-gold)] hover:text-[var(--mc-gold-hover)] transition-colors"
          >
            {showCreditHistory ? '▾ Hide credit history' : '▸ View credit history'}
          </button>

          {showCreditHistory && (
            <div className="mt-3 bg-[var(--mc-surface)] rounded-lg overflow-hidden border border-[var(--mc-border)]">
              {creditHistory.length === 0 ? (
                <p className="text-[var(--mc-text-3)] text-sm p-4">No transactions yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--mc-border)]">
                      <th className="text-left text-[var(--mc-text-2)] font-medium px-4 py-3">Date</th>
                      <th className="text-left text-[var(--mc-text-2)] font-medium px-4 py-3">Type</th>
                      <th className="text-left text-[var(--mc-text-2)] font-medium px-4 py-3">Event</th>
                      <th className="text-right text-[var(--mc-text-2)] font-medium px-4 py-3">Credits</th>
                      <th className="text-right text-[var(--mc-text-2)] font-medium px-4 py-3">Ref</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditHistory.map((tx) => (
                      <tr key={tx.id} className="border-b border-[var(--mc-border-dim)]">
                        <td className="px-4 py-3 text-[var(--mc-text-2)]">
                          {new Date(tx.created_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric'
                          })}
                        </td>
                        <td className="px-4 py-3">
                          {tx.type === 'event_created' && 'Event created'}
                          {tx.type === 'event_topup' && 'Viewing hours added'}
                          {tx.type === 'event_cancelled' && 'Event cancelled'}
                          {tx.type === 'purchase' && 'Purchase'}
                          {tx.type === 'refund' && 'Refund'}
                          {tx.type === 'test_deduction' && 'Test deduction'}
                        </td>
                        <td className="px-4 py-3 text-[var(--mc-text-2)]">
                          {tx.events?.title || '—'}
                        </td>
                        <td className={`px-4 py-3 text-right font-medium ${
                          tx.amount > 0 ? 'text-[var(--mc-success)]' : 'text-[var(--mc-live)]'
                        }`}>
                          {tx.amount > 0 ? '+' : ''}{tx.amount}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-[var(--mc-text-3)]">
                          {(tx as any).stripe_session_id
                            ? (tx as any).stripe_session_id.slice(-8).toUpperCase()
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Logo Upload Section */}
        <div className="bg-[var(--mc-surface)] rounded-lg p-6 mb-8 border border-[var(--mc-border)]">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-xl font-semibold text-[var(--mc-text-1)]">Your Logo</h2>
              <p className="text-[var(--mc-text-2)] text-sm mt-1">
                Shown as "Presented by" on your watch pages
              </p>
            </div>

            {/* Preview + actions on the right */}
            <div className="flex items-center gap-4">
              {user?.logo_url ? (
                <>
                  {/* Current logo preview */}
                  <img
                    src={user.logo_url}
                    alt="Your logo"
                    className="h-10 max-w-[160px] object-contain rounded bg-black p-1"
                  />
                  {/* Remove button */}
                  <button
                    onClick={handleLogoRemove}
                    disabled={logoUploading}
                    className="px-3 py-1.5 text-sm bg-[var(--mc-live-bg)] hover:bg-red-100 text-[var(--mc-live)] rounded transition-colors disabled:opacity-50"
                  >
                    {logoUploading ? 'Removing...' : 'Remove'}
                  </button>
                </>
              ) : (
                <span className="text-[var(--mc-text-3)] text-sm italic">No logo set</span>
              )}
            </div>
          </div>

          {/* Upload input row */}
          <div className="mt-4 flex items-center gap-3">
            <label className="cursor-pointer px-4 py-2 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg text-sm font-medium transition-colors">
              {logoUploading ? 'Uploading...' : (user?.logo_url ? 'Replace Logo' : 'Upload Logo')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                onChange={handleLogoUpload}
                disabled={logoUploading}
                className="hidden"
              />
            </label>
            <span className="text-[var(--mc-text-3)] text-xs">PNG, JPG, SVG, or WebP. Max 100 KB.</span>
          </div>

          {/* Error message */}
          {logoError && (
            <p className="text-[var(--mc-live)] text-sm mt-2">{logoError}</p>
          )}
        </div>

        {/* Create Event Button */}
        <div className="mb-8">
          <button
            onClick={() => router.push('/create-event')}
            disabled={!user || user.credits < 1}
            className="bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors"
          >
            Create New Event
          </button>
          {user && user.credits < 1 && (
            <p className="text-[var(--mc-warning)] text-sm mt-2">
              You need credits to create an event.{' '}
              <button
                onClick={() => setShowBuyCredits(true)}
                className="underline font-medium hover:text-[var(--mc-gold)] transition-colors"
              >
                Buy credits
              </button>
            </p>
          )}
        </div>

        {/* Events List */}
        <div>
          <h2 className="text-2xl font-bold mb-4 text-[var(--mc-text-1)]">Current Events</h2>
          
          {/* Active/Upcoming Events */}
          {events.length === 0 && endedEvents.length === 0 ? (
            <div className="bg-[var(--mc-surface)] rounded-lg p-8 text-center text-[var(--mc-text-2)] border border-[var(--mc-border)]">
              No events yet. Create one to get started!
            </div>
          ) : (
            <>
              {/* Active Events Section */}
              {events.length > 0 && (
                <div className="grid gap-4 mb-8">
                  {events.map((event) => (
                    <div
                      key={event.id}
                      className="bg-[var(--mc-surface)] rounded-lg p-6 cursor-pointer hover:border-[var(--mc-gold)]/30 transition-colors border border-[var(--mc-border)]"
                      onClick={() => router.push(`/events/${event.id}`)}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="text-xl font-semibold text-[var(--mc-text-1)]">{event.title}</h3>
                          <p className="text-[var(--mc-text-2)] text-sm mt-1">
                            {new Date(event.scheduled_date).toLocaleString('en-US', {
                              weekday: 'long',
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                              timeZoneName: 'short',
                              timeZone: (event as any).timezone || 'America/Los_Angeles'
                            })}
                          </p>
                          <p className="text-[var(--mc-text-3)] text-xs mt-2">
                            Watch URL: <span className="font-mono">{event.slug}</span>
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <span
                            className={`px-3 py-1 rounded-full text-sm font-medium ${
                              event.status === 'live'
                                ? 'bg-[var(--mc-live-bg)] text-[var(--mc-live)]'
                                : event.status === 'ready'
                                ? 'bg-[var(--mc-success-bg)] text-[var(--mc-success)]'
                                : 'bg-[var(--mc-info-bg)] text-[var(--mc-info)]'
                            }`}
                          >
                            {event.status.toUpperCase()}
                          </span>
                          {event.stream_state === 'active' && (
                            <span className="px-3 py-1 rounded-full text-sm font-medium bg-[var(--mc-live-bg)] text-[var(--mc-live)]">
                              🔴 STREAMING
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Ended Events Section */}
              {endedEvents.length > 0 && (
                <>
                  <h3 className="text-xl font-semibold mb-4 mt-8 text-[var(--mc-text-2)]">Past Events</h3>
                  <div className="grid gap-4">
                    {endedEvents.map((event) => (
                      <div
                        key={event.id}
                        className="bg-[var(--mc-surface)] rounded-lg p-6 cursor-pointer hover:border-[var(--mc-gold)]/20 transition-colors border border-[var(--mc-border-dim)]"
                        onClick={() => router.push(`/events/${event.id}`)}
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="text-xl font-semibold text-[var(--mc-text-2)]">{event.title}</h3>
                            <p className="text-[var(--mc-text-3)] text-sm mt-1">
                              {new Date(event.scheduled_date).toLocaleString('en-US', {
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                                timeZoneName: 'short',
                                timeZone: (event as any).timezone || 'America/Los_Angeles'
                              })}
                            </p>
                            <p className="text-[var(--mc-text-3)] text-xs mt-2">
                              Watch URL: <span className="font-mono">{event.slug}</span>
                            </p>
                          </div>
                          <span className="px-3 py-1 rounded-full text-sm font-medium bg-[var(--mc-surface-2)] text-[var(--mc-text-3)]">
                            ENDED
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Load More Button */}
                  {hasMoreEnded && (
                    <button
                      onClick={() => loadEndedEvents()}
                      disabled={loadingMoreEnded}
                      className="w-full mt-4 py-4 bg-[var(--mc-surface)] hover:bg-[var(--mc-surface-2)] disabled:bg-[var(--mc-surface)] disabled:cursor-not-allowed rounded-lg text-[var(--mc-text-2)] hover:text-[var(--mc-text-1)] transition-colors border border-[var(--mc-border)]"
                    >
                      {loadingMoreEnded ? 'Loading...' : 'Load More Past Events'}
                    </button>
                  )}
                  
                  {!hasMoreEnded && endedEvents.length > 0 && (
                    <p className="text-center text-[var(--mc-text-3)] text-sm mt-4">
                      All past events loaded ({endedEvents.length} total)
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {/* Cancelled Events Toggle */}
          <div className="mt-8">
            <button
              onClick={() => {
                if (!showCancelled) loadCancelledEvents();
                setShowCancelled(!showCancelled);
              }}
              className="text-sm text-[var(--mc-text-3)] hover:text-[var(--mc-text-2)] transition-colors"
            >
              {showCancelled ? '▾ Hide cancelled events' : '▸ Show cancelled events'}
            </button>

            {showCancelled && cancelledEvents.length > 0 && (
              <div className="grid gap-4 mt-3">
                {cancelledEvents.map((event) => (
                  <div
                    key={event.id}
                    className="bg-[var(--mc-surface)] rounded-lg p-6 cursor-pointer hover:bg-[var(--mc-surface-2)] transition-colors opacity-60 border border-[var(--mc-border-dim)]"
                    onClick={() => router.push(`/events/${event.id}`)}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="text-xl font-semibold text-[var(--mc-text-3)] line-through">{event.title}</h3>
                        <p className="text-[var(--mc-text-3)] text-sm mt-1">
                          {new Date(event.scheduled_date).toLocaleString('en-US', {
                            weekday: 'long',
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                            timeZoneName: 'short',
                            timeZone: event.timezone || 'America/Los_Angeles'
                          })}
                        </p>
                      </div>
                      <span className="px-3 py-1 rounded-full text-sm font-medium bg-[var(--mc-live-bg)] text-[var(--mc-live)]">
                        CANCELLED
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {showCancelled && cancelledEvents.length === 0 && (
              <p className="text-[var(--mc-text-3)] text-sm mt-3">No cancelled events.</p>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-[var(--mc-border)] mt-12 py-6 text-center text-xs text-[var(--mc-text-3)]">
        <div className="max-w-6xl mx-auto px-8 flex items-center justify-center gap-4 flex-wrap">
          <span>&copy; {new Date().getFullYear()} MomentCast</span>
          <span className="hidden sm:inline">&middot;</span>
          <a href="https://momentcast.live/terms.html" target="_blank" rel="noopener" className="hover:text-[var(--mc-text-2)] transition-colors">Terms of Service</a>
          <span className="hidden sm:inline">&middot;</span>
          <a href="https://momentcast.live/privacy.html" target="_blank" rel="noopener" className="hover:text-[var(--mc-text-2)] transition-colors">Privacy Policy</a>
          <span className="hidden sm:inline">&middot;</span>
          <a href="mailto:support@momentcast.live" className="hover:text-[var(--mc-text-2)] transition-colors">Support</a>
        </div>
      </footer>
    </div>
  );
}