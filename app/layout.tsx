import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'BTC 24h ONLINE — Bitcoin Market Monitor',
  description: 'BTC实时行情、交易信号、ETF资金、巨鲸活动与仓位风控监控台。',
  openGraph: {
    title: 'BTC 24h ONLINE',
    description: 'BITCOIN MARKET MONITOR',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'BTC 24h ONLINE' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'BTC 24h ONLINE',
    description: 'BITCOIN MARKET MONITOR',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
