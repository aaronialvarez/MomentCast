// Type definitions for MomentCast API

export interface User {
  id: string;
  email: string;
  stripe_customer_id?: string;
  credits: number;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  scheduled_date: string;
  live_input_id?: string;
  rtmps_url?: string;
  rtmps_key?: string;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled';
  stream_state: 'inactive' | 'active' | 'paused' | 'finalized';
  stream_started_at?: string;
  recordings: Recording[];
  merged_video_id?: string;
  viewer_hours_used: number;
  viewer_hour_limit: number;
  tier: 'standard' | 'premium';
  created_at: string;
  updated_at: string;
}

export interface Recording {
  id: string;
  uid: string;
  duration: number;
  title: string;
  thumbnail?: string;
  created_at: string;
}

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  type: 'purchase' | 'event_created' | 'event_cancelled' | 'refund';
  stripe_payment_id?: string;
  event_id?: string;
  created_at: string;
}

export interface CreateEventRequest {
  title: string;
  scheduledDate: string;
  tier?: 'standard' | 'premium';
}

export interface CreateEventResponse {
  eventId: string;
  slug: string;
  watchUrl: string;
  liveInputId: string;
  rtmpsUrl: string;
  rtmpsKey: string;
}

export interface UpdateEventStatusRequest {
  status?: 'scheduled' | 'live' | 'ended' | 'cancelled';
  streamState?: 'inactive' | 'active' | 'paused' | 'finalized';
}

export interface EventDetailsResponse {
  title: string;
  scheduledDate: string;
  status: string;
  streamState: string;
  liveInputId?: string;
  recordings: Recording[];
  mergedVideoId?: string;
}

export interface AnalyticsResponse {
  viewerHoursUsed: number;
  concurrentViewers: number;
  totalViews: number;
  limitWarning?: string;
}

export interface CloudflareStreamLiveInput {
  uid: string;
  createdAt: string;
  deleteAfter?: string;
  meta?: {
    name: string;
  };
  rtmps?: {
    url: string;
    streamKey: string;
  };
  playback?: {
    hls: string;
    dash: string;
  };
}

export interface CloudflareStreamAnalytics {
  data?: Array<{
    date: string;
    viewerMinutes?: number;
    views?: number;
    concurrentViewersMax?: number;
  }>;
}

export interface WorkerEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_STREAM_API_TOKEN: string;
  ENVIRONMENT: 'production' | 'staging' | 'development';
}
