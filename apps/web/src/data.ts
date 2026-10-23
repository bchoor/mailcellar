// Sample mailbox for the prototype: made-up messages from reserved example domains. Nothing is real.
export interface Msg {
  id: string;
  account: string;
  date: string;
  year: string;
  from: string;
  domain: string;
  subject: string;
  label: string;
  size_mb: number;
  attachments: number;
  n: number;
}

const SENDERS: [string, string, string][] = [
  ['news@example.com', 'Newsletters', 'Weekly digest'],
  ['billing@example.org', 'Receipts', 'Your invoice'],
  ['team@example.net', 'Work', 'Project update'],
  ['alerts@bank.example', 'Finance', 'Account alert'],
  ['friend@example.com', 'Personal', 'Photos from the weekend'],
  ['mom@family.example', 'Family', 'Dinner on Sunday?'],
  ['trips@travel.example', 'Travel', 'Your booking is confirmed'],
  ['orders@shop.example', 'Receipts', 'Your order has shipped'],
  ['hr@work.example', 'Work', 'Benefits enrollment'],
  ['noreply@social.example', 'Notifications', 'You have new followers'],
  ['support@cloud.example', 'Notifications', 'Usage report'],
  ['editor@press.example', 'Newsletters', 'Morning briefing'],
  ['school@edu.example', 'Family', 'Term calendar'],
  ['landlord@home.example', 'Personal', 'Lease renewal'],
  ['tax@gov.example', 'Finance', 'Statement available'],
  ['recruiter@jobs.example', 'Work', 'An opportunity'],
];

const seeded = (n: number) => {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
};

export const MESSAGES: Msg[] = Array.from({ length: 2400 }, (_, i) => {
  const s = SENDERS[Math.floor(seeded(i) ** 1.6 * SENDERS.length)] ?? SENDERS[0];
  // Mail grows over the years: more recent years carry more messages.
  const year = 2006 + Math.floor(Math.sqrt(seeded(i + 7)) * 21);
  const month = 1 + Math.floor(seeded(i + 13) * 12);
  const day = 1 + Math.floor(seeded(i + 17) * 28);
  const att = seeded(i + 23) < 0.18 ? 1 + Math.floor(seeded(i + 29) * 3) : 0;
  const [from, label, subject] = s;
  return {
    id: `m_${i + 1}`,
    account: seeded(i + 31) < 0.7 ? 'you@example.com' : 'work@example.org',
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year: String(year),
    from,
    domain: from.split('@')[1] ?? '',
    subject: `${subject} #${(i % 97) + 1}`,
    label,
    size_mb: Math.round((8 + seeded(i + 37) * 60 + att * (200 + seeded(i + 41) * 1800)) / 102.4) / 10,
    attachments: att,
    n: 1,
  };
}).sort((a, b) => b.date.localeCompare(a.date));
