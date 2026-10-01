'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

// Password-reset form. Reached from /auth/confirm (new email links) or from
// /auth/callback?next=/reset-password (old PKCE links already in inboxes).
// Both paths leave a recovery session in cookies, so this page only needs to
// check for a session and call updateUser.

// Must match Supabase: Auth > Providers > Email > Minimum password length.
const MIN_PASSWORD_LENGTH = 8

type View = 'checking' | 'form' | 'expired' | 'done'

// Same check as the login page: separates "can't reach the server" from a real auth error
function isNetworkError(e: any): boolean {
  const msg = String(e?.message ?? e ?? '')
  return (
    e?.name === 'AuthRetryableFetchError' ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(msg) ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  )
}

// Never includes email, password, or tokens. Safe to paste into a support email.
function describeAuthError(step: string, e: any, fallback: string): { message: string; details: string } {
  const network = isNetworkError(e)
  const raw = String(e?.message ?? e ?? 'Unknown error')
  const details = [
    'MomentCast login error',
    `Time: ${new Date().toISOString()}`,
    `Step: ${step}`,
    `Kind: ${network ? 'network' : 'auth'}`,
    `Message: ${raw}`,
    e?.code && `Code: ${e.code}`,
    e?.status && `Status: ${e.status}`,
    `Online: ${navigator.onLine}`,
    `UA: ${navigator.userAgent}`,
  ].filter(Boolean).join('\n')

  return {
    message: network
      ? "Can't reach the server. Check your connection or VPN and try again."
      : (e instanceof Error ? e.message : fallback),
    details,
  }
}

function ErrorBox({ error, details }: { error: string | null; details: string | null }) {
  const [copied, setCopied] = useState(false)
  if (!error) return null
  return (
    <div className="bg-[var(--mc-live-bg)] text-[var(--mc-live)] p-4 rounded-lg text-sm border border-red-200">
      <p>{error}</p>
      {details && (
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(details).then(() => setCopied(true))
          }}
          className="mt-2 underline text-xs"
        >
          {copied ? 'Copied' : 'Copy details for support'}
        </button>
      )}
    </div>
  )
}

export default function ResetPasswordPage() {
  const supabase = createClient()

  const [view, setView] = useState<View>('checking')
  // True when the account has a Google identity. Changes the copy only.
  const [hasGoogle, setHasGoogle] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)

  // Confirm a recovery session exists before showing the form.
  useEffect(() => {
    let cancelled = false

    async function check() {
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled) return
      if (session) {
        const providers: string[] = session.user.app_metadata?.providers ?? []
        setHasGoogle(providers.includes('google'))
        setView('form')
      } else {
        setView('expired')
      }
    }
    check()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // After a successful reset, show the confirmation briefly, then go to the dashboard.
  useEffect(() => {
    if (view !== 'done') return
    const t = setTimeout(() => { window.location.href = '/' }, 1500)
    return () => clearTimeout(t)
  }, [view])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setErrorDetails(null)

    // Client-side checks first so the user gets an instant message.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error

      // Sign out every other device. Best effort: the password is already changed,
      // so a failure here must not show the user an error.
      try {
        await supabase.auth.signOut({ scope: 'others' })
      } catch (err) {
        console.error('Sign out others failed:', err)
      }

      setView('done')
    } catch (err) {
      console.error('Password update error:', err)
      const d = describeAuthError('update_password', err, 'Failed to update password')
      setError(d.message)
      setErrorDetails(d.details)
      setLoading(false)
    }
  }

  // --- Checking for a session ---
  if (view === 'checking') {
    return (
      <div className="min-h-screen bg-[var(--mc-bg)] flex items-center justify-center">
        <p className="text-[var(--mc-text-3)]">Loading...</p>
      </div>
    )
  }

  // --- No session: link expired, used, or page opened directly ---
  if (view === 'expired') {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold mb-4">This link has expired</h1>
        <p className="text-[var(--mc-text-2)] mb-6">
          Reset links work once and expire after one hour. Go back to sign in and choose
          &ldquo;Forgot password?&rdquo; to get a new one.
        </p>
        <a
          href="/login"
          className="block w-full px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] text-white rounded-lg font-medium transition-colors"
        >
          Back to Sign In
        </a>
      </Shell>
    )
  }

  // --- Success ---
  if (view === 'done') {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold mb-4">Password updated</h1>
        <p className="text-[var(--mc-text-2)]">
          Taking you to your dashboard...
        </p>
      </Shell>
    )
  }

  // --- New password form ---
  return (
    <Shell>
      <h1 className="text-2xl font-semibold text-center mb-3">Set a new password</h1>

      {hasGoogle && (
        <p className="text-[var(--mc-text-2)] text-sm mb-6">
          This adds a password to your account. You can still sign in with Google.
        </p>
      )}
      {!hasGoogle && <div className="mb-3" />}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium mb-2 text-left">New password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:border-[var(--mc-gold)]"
            required
          />
          <p className="text-xs text-[var(--mc-text-3)] mt-2 text-left">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2 text-left">Confirm new password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            className="w-full px-4 py-3 bg-[var(--mc-surface-2)] border border-[var(--mc-border)] rounded focus:outline-none focus:border-[var(--mc-gold)]"
            required
          />
        </div>

        <ErrorBox error={error} details={errorDetails} />

        <button
          type="submit"
          disabled={loading}
          className="w-full px-6 py-3 bg-[var(--mc-gold)] hover:bg-[var(--mc-gold-hover)] disabled:bg-[var(--mc-surface-2)] disabled:text-[var(--mc-text-3)] disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
        >
          {loading ? 'Saving...' : 'Update Password'}
        </button>
      </form>
    </Shell>
  )
}

// Copy of the Shell in app/login/page.tsx (not exported there).
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