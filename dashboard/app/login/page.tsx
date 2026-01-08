'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  async function handleLogin(e: React.FormEvent) {
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
      setError(err instanceof Error ? err.message : 'Failed to login')
    } finally {
      setLoading(false)
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { data: authData, error: signupError } = await supabase.auth.signUp({
        email,
        password,
      })

      if (signupError) throw signupError
      if (!authData.user) throw new Error('No user returned')

      // Trigger will create the user record automatically
      // Just redirect to dashboard
      router.push('/')
      router.refresh()
    } catch (err) {
      console.error('Signup error:', err)
      setError(err instanceof Error ? err.message : 'Failed to sign up')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-8">
      <div className="max-w-md w-full bg-gray-800 rounded-lg p-8">
        <h1 className="text-3xl font-bold mb-6 text-center bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
          MomentCast
        </h1>
        
        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
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
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded focus:outline-none focus:border-purple-500"
              required
            />
          </div>

          {error && (
            <div className="bg-red-900 text-red-100 p-4 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <button
              type="submit"
              disabled={loading}
              className="w-full px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
            >
              {loading ? 'Signing In...' : 'Sign In'}
            </button>

            <button
              type="button"
              onClick={handleSignup}
              disabled={loading}
              className="w-full px-6 py-3 border border-gray-600 hover:bg-gray-700 disabled:bg-gray-800 disabled:cursor-not-allowed rounded-lg font-medium transition-colors"
            >
              {loading ? 'Creating Account...' : 'Create Account (5 Free Credits)'}
            </button>
          </div>
        </form>

        <p className="text-gray-400 text-xs mt-6 text-center">
          New accounts receive 5 free event credits
        </p>
      </div>
    </div>
  )
}