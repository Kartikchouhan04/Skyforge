import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import './training.css';
import './theme.css';
import './controls.css';
import './match.css';

export const metadata: Metadata = {
  title: 'Skyforge Stadium — Storm the Towers',
  description: 'A 5v5 objective-based aerial combat game: five jets attack three towers, five defenders hold them from the ground and the air.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
