import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'MomentCast Dashboard',
  description: 'Live event streaming for photographers',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
      <!-- Google tag (gtag.js) -->
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-KL4FM3L62J"></script>
      <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());

        gtag('config', 'G-KL4FM3L62J');
      </script>
    </html>
  )
}
