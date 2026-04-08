'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function AuthCallbackPage() {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()

    // Supabase client automatically detects the auth callback
    // parameters in the URL hash and exchanges them for a session
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        // Get the "next" param if present, default to dashboard
        const params = new URLSearchParams(window.location.search)
        const next = params.get('next') || '/'
        window.location.href = next
      }
    })
  }, [router])

  return (
    <div className="min-h-screen bg-[var(--mc-bg)] flex items-center justify-center">
      <p className="text-[var(--mc-text-3)]">Completing sign in...</p>
    </div>
  )
}