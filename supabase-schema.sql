-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE IF NOT EXISTS users (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
email VARCHAR(255) UNIQUE NOT NULL,
stripe_customer_id VARCHAR(255),
credits INTEGER DEFAULT 0,
created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
slug VARCHAR(255) UNIQUE NOT NULL,
title VARCHAR(255) NOT NULL,
scheduled_date TIMESTAMP WITH TIME ZONE NOT NULL,
live_input_id VARCHAR(255),
rtmps_url VARCHAR(255),
rtmps_key VARCHAR(255),
status VARCHAR(50) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended','cancelled')),
stream_state VARCHAR(50) DEFAULT 'inactive' CHECK (stream_state IN ('inactive', 'active','paused', 'finalized')),
stream_started_at TIMESTAMP WITH TIME ZONE,
recordings JSONB DEFAULT '[]'::jsonb,
merged_video_id VARCHAR(255),
viewer_hours_used NUMERIC DEFAULT 0,
viewer_hour_limit INTEGER DEFAULT 5000,
tier VARCHAR(50) DEFAULT 'standard' CHECK (tier IN ('standard', 'premium')),
created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
MomentCast MVP - Complete ProductionCodebase
1. Database Schema (
supabase-schema.sql
)

-- Credit transactions table
CREATE TABLE IF NOT EXISTS credit_transactions (
id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
amount INTEGER NOT NULL,
type VARCHAR(50) NOT NULL CHECK (type IN ('purchase', 'event_created','event_cancelled', 'refund')),
stripe_payment_id VARCHAR(255),
event_id UUID REFERENCES events(id) ON DELETE SET NULL,
created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_events_slug ON events(slug);
CREATE INDEX idx_events_user_id ON events(user_id);
CREATE INDEX idx_events_scheduled_date ON events(scheduled_date);
CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_users_email ON users(email);

-- Row Level Security Policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;

-- Users: Users can only see their own record
CREATE POLICY users_select_own ON users
FOR SELECT USING (auth.uid() = id);
CREATE POLICY users_update_own ON users
FOR UPDATE USING (auth.uid() = id);

-- Events: Users can see only their own events, OR public can view any by slug
CREATE POLICY events_select_own ON events
FOR SELECT USING (
auth.uid() = user_id OR auth.jwt() ->> 'role' = 'anon'
);
CREATE POLICY events_insert_own ON events
FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY events_update_own ON events
FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY events_delete_own ON events
FOR DELETE USING (auth.uid() = user_id);

-- Credit transactions: Users can see only their own
CREATE POLICY credit_transactions_select_own ON credit_transactions
FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY credit_transactions_insert_own ON credit_transactions
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS
LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_events_updated_at BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();