'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type View = 'sign_in' | 'sign_up' | 'check_email'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const [view, setView] = useState<View>('sign_in')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pick up error from auth callback redirect (?error=auth_failed)
  useEffect(() => {
    if (searchParams.get('error') === 'auth_failed') {
      setError('Authentication failed. Please try again.')
    }
  }, [searchParams])

  // Clear error when switching views
  function switchView(newView: View) {
    setError(null)
    setView(newView)
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (error) throw error

      router.push('/')
      router.refresh()
    } catch (err) {
      console.error('Login error:', err)
      setError(err instanceof Error ? err.message : 'Failed to sign in')
    } finally {
      setLoading(false)
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })
      if (error) throw error

      // Show confirmation screen instead of auto-redirecting
      setView('check_email')
    } catch (err) {
      console.error('Signup error:', err)
      setError(err instanceof Error ? err.message : 'Failed to sign up')
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogleSignIn() {
    setError(null)
    setLoading(true)

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      })
      if (error) throw error
    } catch (err) {
      console.error('Google sign-in error:', err)
      setError(err instanceof Error ? err.message : 'Failed to sign in with Google')
      setLoading(false)
    }
  }

  // --- Check Email Confirmation Screen ---
  if (view === 'check_email') {
    return (
      <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-1)] flex items-center justify-center p-8">
        <div className="max-w-md w-full bg-[var(--mc-surface)] rounded-lg p-8 border border-[var(--mc-border)] shadow-sm text-center">
          <div className="flex justify-center mb-6">
            <img src="/momentcast-logo-gold-on-light.png" alt="MomentCast" className="h-12 w-auto" />
          </div>
          <h1 className="text-2xl font-semibold mb-4">Check your email</h1>
          <p className="text-[var(--mc-text-2)] mb-6">
            We sent a confirmation link to <strong>{email}</strong>. Click the link in your inbox to activate your account.
          </p>
          <button
            onClick={() => switchView('sign_in')}
            className="w-full px-6 py-3 border border-[var(--mc-border)] hover:bg-[var(--mc-surface-2)] rounded-lg font-medium transition-colors"
          >
            Back to Sign In
          </button>
        </div>
      </div>
    )
  }

  // --- Sign In / Sign Up Form ---
  return (
    <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-1)] flex items-center justify-center p-8">
      <div className="max-w-md w-full bg-[var(--mc-surface)] rounded-lg p-8 border border-[var(--mc-border)] shadow-sm">
        <div className="flex justify-center mb-6">
          <img src="/momentcast-logo-gold-on-light.png" alt="MomentCast" className="h-12 w-auto" />
        </div>

        <h1 className="text-2xl font-semibold text-center mb-6">
          {view === 'sign_up' ? 'Create an Account' : 'Sign In'}
        </h1>

        {/* Google OAuth Button */}
        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full px-6 py-3 mb-4 border border-[var(--mc-border)] hover:bg-[var(--mc-surface-2)] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium transition-colors flex items-center justify-center gap-3"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Continue with Google
        </button>

        {/* Divider */}
        <div className="flex items-center gap-4 mb-4">
          <div className="flex-1 h-px bg-[var(--mc-border)]" />
          <span className="text-[var(--mc-text-3)] text-sm">or</span>
          <div className="flex-1 h-px bg-[var(--mc-border)]" />
        </div>

        <form onSubmit={view === 'sign_up' ? handleSignUp : handleSignIn} className="space-y-5">
          {/* Full Name (sign-up only) */}
          {view === 'sign_up' && (
            <div>
              <label className="block text-sm font-medium mb-2">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Your full name"
                className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:border-[var(--mc-gold)]"
                required
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-2">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:border-[var(--mc-gold)]"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:border-[var(--mc-gold)]"
              required
            />
          </div>

          {error && (
            <div className="bg-[var(--mc-live-bg)] text-[var(--mc-live)] p-4 rounded-lg text-sm border border-red-200">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
          >
            {loading
              ? (view === 'sign_up' ? 'Creating Account...' : 'Signing In...')
              : (view === 'sign_up' ? 'Create Account' : 'Sign In')
            }
          </button>
        </form>

        {/* Toggle between sign-in and sign-up */}
        <p className="text-center text-sm mt-6">
          <span className="text-[var(--mc-text-3)]">
            {view === 'sign_up' ? 'Already have an account? ' : "Don't have an account? "}
          </span>
          <button
            onClick={() => switchView(view === 'sign_up' ? 'sign_in' : 'sign_up')}
            className="underline font-medium hover:text-[var(--mc-gold)] transition-colors"
          >
            {view === 'sign_up' ? 'Sign in' : 'Sign up'}
          </button>
        </p>

        {view === 'sign_in' && (
          <p className="text-[var(--mc-text-3)] text-xs mt-4 text-center">
            New accounts receive 5 free event credits
          </p>
        )}
      </div>
    </div>
  )
}