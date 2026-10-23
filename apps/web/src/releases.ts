// Change log for the prototype, in the shape Lumen's What's new reads from a releases API.
// The prototype has no API yet, so main.tsx seeds the query cache with these, newest first.
export const RELEASES_API = '/api/releases';

export const RELEASES = [
  {
    tag: 'v0.1.1',
    published_at: '2026-10-23T21:45:00Z',
    takeaways: [
      { text: "**Change log**: the version in the status bar opens What's new.", types: ['feature'] },
    ],
  },
  {
    tag: 'v0.1.0',
    published_at: '2026-10-23T20:21:53Z',
    takeaways: [
      { text: '**Archive views** on sample data: Overview, Messages, Senders, Domains, Labels and Time.', types: ['feature'] },
      { text: '**Backfill** page, with progress and time left in the status bar.', types: ['feature'] },
      { text: '**Cloudflare usage** against the free tier.', types: ['feature'] },
      { text: '**Settings**: Accounts and Schedules.', types: ['feature'] },
    ],
  },
];
