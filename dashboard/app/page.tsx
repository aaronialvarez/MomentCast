'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

interface User {
  id: string;
  email: string;
  credits: number;
}


// delete this line

interface Event {
  id: string;
  slug: string;
  title: string;
  scheduled_date: string;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
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

  const [user, setUser] = useState<User | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDashboard() {
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

        // Fetch upcoming/active events first (prioritized load)
        const { data: activeEvents, error: activeError } = await supabase
          .from('events')
          .select('id, slug, title, scheduled_date, status, stream_state')
          .eq('user_id', authUser.id)
          .in('status', ['live', 'ready', 'scheduled'])
          .order('scheduled_date', { ascending: true })
          .limit(50);

        if (activeError) {
          console.error('Events fetch error:', activeError);
          setError('Failed to load events');
          setLoading(false);
          return;
        }

        // Show active events immediately
        setEvents(activeEvents || []);
        setLoading(false);

        // Lazy-load ended events in background
        supabase
          .from('events')
          .select('id, slug, title, scheduled_date, status, stream_state')
          .eq('user_id', authUser.id)
          .eq('status', 'ended')
          .order('scheduled_date', { ascending: false })
          .limit(20)
          .then(({ data: endedEvents }) => {
            if (endedEvents) {
              setEvents(prev => [...prev, ...endedEvents]);
            }
          });

      } catch (err) {
        console.error('Dashboard load error:', err);
        setError('Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    }

    loadDashboard();
  }, [supabase, router]);

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
          {events.length === 0 ? (
            <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400">
              No events yet. Create one to get started!
            </div>
          ) : (
            <div className="grid gap-4">
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
                            : event.status === 'ended'
                            ? 'bg-gray-600 text-gray-100'
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
        </div>
      </div>
    </div>
  );
}