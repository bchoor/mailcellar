// Sample mailbox for phase 1: made-up messages from reserved example domains, so the
// pages run end to end before any real mail arrives. Nothing here is real.
import type { IndexedMessage, MailLabel } from './mail';

export const SAMPLE_LABELS: MailLabel[] = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'SENT', name: 'SENT', type: 'system' },
  { id: 'Label_1', name: 'Newsletters', type: 'user' },
  { id: 'Label_2', name: 'Receipts', type: 'user' },
  { id: 'Label_3', name: 'Work', type: 'user' },
  { id: 'Label_4', name: 'Finance', type: 'user' },
  { id: 'Label_5', name: 'Personal', type: 'user' },
  { id: 'Label_6', name: 'Family', type: 'user' },
  { id: 'Label_7', name: 'Travel', type: 'user' },
  { id: 'Label_8', name: 'Notifications', type: 'user' },
];

// [address, name, label, subject]: the same cast as the prototype's sample data.
const SENDERS: [string, string, string, string][] = [
  ['news@example.com', 'Example News', 'Label_1', 'Weekly digest'],
  ['billing@example.org', 'Example Billing', 'Label_2', 'Your invoice'],
  ['team@example.net', 'Project Team', 'Label_3', 'Project update'],
  ['alerts@bank.example', 'Bank Alerts', 'Label_4', 'Account alert'],
  ['friend@example.com', 'A Friend', 'Label_5', 'Photos from the weekend'],
  ['mom@family.example', 'Mom', 'Label_6', 'Dinner on Sunday?'],
  ['trips@travel.example', 'Travel Desk', 'Label_7', 'Your booking is confirmed'],
  ['orders@shop.example', 'Example Shop', 'Label_2', 'Your order has shipped'],
  ['hr@work.example', 'People Team', 'Label_3', 'Benefits enrollment'],
  ['noreply@social.example', 'Social', 'Label_8', 'You have new followers'],
  ['support@cloud.example', 'Cloud Support', 'Label_8', 'Usage report'],
  ['editor@press.example', 'Morning Press', 'Label_1', 'Morning briefing'],
  ['school@edu.example', 'School Office', 'Label_6', 'Term calendar'],
  ['landlord@home.example', 'Landlord', 'Label_5', 'Lease renewal'],
  ['tax@gov.example', 'Tax Office', 'Label_4', 'Statement available'],
  ['recruiter@jobs.example', 'Recruiter', 'Label_3', 'An opportunity'],
];

function rng(seed: number) { // mulberry32: deterministic across runs
  return () => {
    let t = (seed = (seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` sample messages, newest years busiest, with Gmail-shaped hex IDs. */
export function sampleMessages(count: number, seed = 1): IndexedMessage[] {
  const r = rng(seed);
  const start = Date.UTC(2006, 0, 1);
  const span = Date.UTC(2026, 9, 1) - start;
  return Array.from({ length: count }, (_, i) => {
    const [fromAddr, fromName, label, subject] = SENDERS[Math.floor(r() ** 1.6 * SENDERS.length)];
    const ts = start + Math.floor(Math.sqrt(r()) * span);
    const attachments = r() < 0.18 ? 1 + Math.floor(r() * 3) : 0;
    const id = (ts * 1000 + i).toString(16).padStart(16, '0').slice(-16);
    return {
      id,
      threadId: id,
      ts,
      fromAddr,
      fromName,
      subject: `${subject} #${(i % 97) + 1}`,
      snippet: `${subject}. This is sample mail for the MailCellar preview; nothing in it is real.`,
      size: Math.round(8_000 + r() * 60_000 + attachments * (200_000 + r() * 1_800_000)),
      attachments,
      labels: r() < 0.15 ? ['SENT', label] : ['INBOX', label],
    };
  });
}
