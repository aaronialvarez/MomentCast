'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

interface User {
  id: string;
  email: string;
  credits: number;
}

interface Event {
  id: string;
  slug: string;
  title: string;
  scheduled_date: string;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled' | 'ready';
  stream_state: 'inactive' | 'active' | 'paused' | 'finalized';
}

export default function DashboardHome() {
  const router = useRouter();
  const [supabase] = useState(() =>
    createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  );

  const [user, setUser] = useState<User | null>(null);  // This was missing!
  const [events, setEvents] = useState<Event[]>([]);
  const [endedEvents, setEndedEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMoreEnded, setLoadingMoreEnded] = useState(false);
  const [hasMoreEnded, setHasMoreEnded] = useState(true);
  const [endedPage, setEndedPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const ENDED_EVENTS_PER_PAGE = 20; // Change to 20 in production

  useEffect(() => {
    async function loadDashboard() {
      console.log('🚀 Dashboard v2.0 - Loading with optimized queries');
      
      try {
        const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
        
        if (authError || !authUser) {
          router.push('/login');
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
          .select('id, slug, title, scheduled_date, status, stream_state')
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
      .select('id, slug, title, scheduled_date, status, stream_state')
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

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (error && !user) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="max-w-md text-center">
          <div className="bg-red-900 text-red-100 p-6 rounded-lg mb-4">
            {error}
          </div>
          <button
            onClick={() => router.push('/login')}
            className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-medium"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header with User Info */}
      <div className="bg-gradient-to-r from-purple-600 to-pink-600 p-8">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold">MomentCast Dashboard</h1>
            <p className="text-white/80 mt-2">Manage your live events</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-sm text-white/70">Logged in as</p>
              <p className="font-medium">{user?.email}</p>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg font-medium transition-colors border border-white/20"
            >
              Logout
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8">
        {/* Credits Section */}
        <div className="bg-gray-800 rounded-lg p-6 mb-8">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-xl font-semibold">Available Credits</h2>
              <p className="text-gray-400 text-sm mt-1">Each event costs 1 credit</p>
            </div>
            <div className="text-5xl font-bold text-purple-400">
              {user?.credits || 0}
            </div>
          </div>
        </div>

        {/* Create Event Button */}
        <div className="mb-8">
          <button
            onClick={() => router.push('/create-event')}
            disabled={!user || user.credits < 1}
            className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors"
          >
            Create New Event
          </button>
          {user && user.credits < 1 && (
            <p className="text-yellow-500 text-sm mt-2">
              You need credits to create an event
            </p>
          )}
        </div>

        {/* Events List */}
        <div>
          <h2 className="text-2xl font-bold mb-4">Your Events</h2>
          
          {/* Active/Upcoming Events */}
          {events.length === 0 && endedEvents.length === 0 ? (
            <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400">
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
                      className="bg-gray-800 rounded-lg p-6 cursor-pointer hover:bg-gray-700 transition-colors"
                      onClick={() => router.push(`/events/${event.id}`)}
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <h3 className="text-xl font-semibold">{event.title}</h3>
                          <p className="text-gray-400 text-sm mt-1">
                            {new Date(event.scheduled_date).toLocaleDateString('en-US', {
                              weekday: 'long',
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                          <p className="text-gray-500 text-xs mt-2">
                            Watch URL: <span className="font-mono">{event.slug}</span>
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <span
                            className={`px-3 py-1 rounded-full text-sm font-medium ${
                              event.status === 'live'
                                ? 'bg-red-900 text-red-100'
                                : event.status === 'ready'
                                ? 'bg-yellow-900 text-yellow-100'
                                : 'bg-blue-900 text-blue-100'
                            }`}
                          >
                            {event.status.toUpperCase()}
                          </span>
                          {event.stream_state === 'active' && (
                            <span className="px-3 py-1 rounded-full text-sm font-medium bg-green-900 text-green-100">
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
                  <h3 className="text-xl font-semibold mb-4 mt-8 text-gray-400">Past Events</h3>
                  <div className="grid gap-4">
                    {endedEvents.map((event) => (
                      <div
                        key={event.id}
                        className="bg-gray-800/50 rounded-lg p-6 cursor-pointer hover:bg-gray-700/50 transition-colors"
                        onClick={() => router.push(`/events/${event.id}`)}
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="text-xl font-semibold text-gray-300">{event.title}</h3>
                            <p className="text-gray-500 text-sm mt-1">
                              {new Date(event.scheduled_date).toLocaleDateString('en-US', {
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </p>
                            <p className="text-gray-600 text-xs mt-2">
                              Watch URL: <span className="font-mono">{event.slug}</span>
                            </p>
                          </div>
                          <span className="px-3 py-1 rounded-full text-sm font-medium bg-gray-600 text-gray-300">
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
                      className="w-full mt-4 py-4 bg-gray-800 hover:bg-gray-700 disabled:bg-gray-800/50 disabled:cursor-not-allowed rounded-lg text-gray-400 hover:text-white transition-colors"
                    >
                      {loadingMoreEnded ? 'Loading...' : 'Load More Past Events'}
                    </button>
                  )}
                  
                  {!hasMoreEnded && endedEvents.length > 0 && (
                    <p className="text-center text-gray-500 text-sm mt-4">
                      All past events loaded ({endedEvents.length} total)
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}