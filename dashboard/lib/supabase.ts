import { createBrowserClient as supabaseCreateBrowserClient } from '@supabase/ssr';
import { createServerClient as supabaseCreateServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

/**
 * Browser client for client-side operations
 * Use in 'use client' components
 */
export function createBrowserClient() {
  return supabaseCreateBrowserClient(supabaseUrl, supabaseAnonKey);
}

/**
 * Server client for server-side operations
 * Use in Server Components and API routes
 */
export async function createServerClient() {
  const cookieStore = await cookies();

  return supabaseCreateServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Cookies might not be set if in async server context
        }
      },
    },
  });
}

/**
 * Get authenticated user
 */
export async function getUser() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * Sign out user
 */
export async function signOut() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
}
