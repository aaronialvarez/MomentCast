'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// Landing page for emailed auth links (password reset and signup confirmation):
//   https://app.momentcast.live/auth/confirm?token_hash=...&type=recovery
//   https://app.momentcast.live/auth/confirm?token_hash=...&type=email
//
// Why a button instead of verifying on load: email scanners (Gmail, Yahoo, Outlook
// Safe Links) prefetch every link in a message with a GET. If verifyOtp ran on page
// load, the scanner would burn the one-time token before the user ever clicked.
// Scanners don't click buttons, so verification only happens on a real click.

// Wrapper with Suspense boundary (required by Next.js 15 for useSearchParams)
export default function AuthConfirmPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[var(--mc-bg)] flex items-center justify-center">
        <p className="text-[var(--mc-text-3)]">Loading...</p>
      </div>
    }>
      <ConfirmForm />
    </Suspense>
  )
}

// Same check as the login page: separates "can't reach the server" from "bad token"
function isNetworkError(e: any): boolean {
  const msg = String(e?.message ?? e ?? '')
  return (
    e?.name === 'AuthRetryableFetchError' ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(msg) ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  )
}

function ConfirmForm() {
  const searchParams = useSearchParams()
  const supabase = createClient()

  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // true once Supabase rejects the token (expired, already used, or tampered)
  const [linkDead, setLinkDead] = useState(false)

  // Two link types are valid: password reset ('recovery') and signup confirmation ('email').
  // Anything else, or a missing token, has nothing to verify: show the dead-link state.
  const isRecovery = type === 'recovery'
  const isSignup = type === 'email'
  const malformed = !tokenHash || (!isRecovery && !isSignup)

  async function handleContinue() {
    if (!tokenHash) return
    setError(null)
    setLoading(true)

    try {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: isRecovery ? 'recovery' : 'email',
      })
      if (error) throw error

      // Session cookie is set. Full navigation so the next page boots with it.
      // Reset links go to the new-password form; signup confirmations go to the dashboard.
      window.location.href = isRecovery ? '/reset-password' : '/'
    } catch (err) {
      console.error('Recovery verify error:', err)
      if (isNetworkError(err)) {
        // Token is still unused. Let the user retry.
        setError("Can't reach the server. Check your connection or VPN and try again.")
      } else {
        setLinkDead(true)
      }
      setLoading(false)
    }
  }

  // --- Dead link: expired, already used, or malformed ---
  if (malformed || linkDead) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold mb-4">This link has expired</h1>
        {isSignup ? (
          <p className="text-[var(--mc-text-2)] mb-6">
            Confirmation links work once and expire after one hour. If you already confirmed,
            sign in. If not, sign up again with the same email to get a new link.
          </p>
        ) : (
          <p className="text-[var(--mc-text-2)] mb-6">
            Reset links work once and expire after one hour. Go back to sign in and choose
            &ldquo;Forgot password?&rdquo; to get a new one.
          </p>
        )}
        <a
          href="/login"
          className="block w-full px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg font-medium transition-colors"
        >
          Back to Sign In
        </a>
      </Shell>
    )
  }

  // --- Ready: wait for a real click ---
  return (
    <Shell>
      <h1 className="text-2xl font-semibold mb-4">
        {isSignup ? 'Confirm your email' : 'Reset your password'}
      </h1>
      <p className="text-[var(--mc-text-2)] mb-6">
        {isSignup
          ? 'Continue to activate your MomentCast account.'
          : 'Continue to choose a new password for your MomentCast account.'}
      </p>

      {error && (
        <div className="bg-[var(--mc-live-bg)] text-[var(--mc-live)] p-4 rounded-lg text-sm border border-red-200 mb-5">
          <p>{error}</p>
        </div>
      )}

      <button
        type="button"
        onClick={handleContinue}
        disabled={loading}
        className="w-full px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
      >
        {loading ? 'Verifying...' : 'Continue'}
      </button>
    </Shell>
  )
}

// Copy of the Shell in app/login/page.tsx (not exported there).
// Extract both into a shared component later if you want one source of truth.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--mc-bg)] text-[var(--mc-text-1)] flex items-center justify-center p-8">
      <div className="max-w-md w-full bg-[var(--mc-surface)] rounded-lg p-8 border border-[var(--mc-border)] shadow-sm text-center">
        <div className="flex justify-center mb-6">
          <img src="/momentcast-logo-gold-on-light.png" alt="MomentCast" className="h-12 w-auto" />
        </div>
        {children}
      </div>
    </div>
  )
}