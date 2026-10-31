// Remote images in mail: whose images show without asking. A rule names a sender's domain or one
// address, never an image host (hosts are shared by thousands of senders). A rule counts only for
// a sender Gmail confirmed when the mail arrived (DMARC, or DKIM signed by the From domain), so a
// copied From line can't load images.

/** Who sent an opened message, and whether Gmail confirmed it. */
export interface MessageSender {
  /** The From address, lower case. */
  address: string;
  /** Its domain, as written (`mail.example.com`). */
  domain: string;
  /** The registered domain a domain rule names (`example.com`). */
  org: string;
  /** Gmail confirmed the sender: DMARC passed, or DKIM was signed by the From domain. */
  verified: boolean;
}

export type ImageSenderKind = 'domain' | 'address';
export interface ImageSender { kind: ImageSenderKind; value: string; addedAt: string }

/** Most rules one person keeps. */
export const IMAGE_SENDERS_MAX = 2000;

/** Domains anyone can get an address at: a rule there names the address only. */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com', 'tutanota.com', 'qq.com', '163.com',
]);

// Two-part public suffixes in common use; a domain under one keeps three labels (`shop.co.uk`).
const SECOND_LEVEL = /\.(?:co|com|net|org|gov|edu|ac|ne|or|go)\.[a-z]{2}$/;

/** The registered domain: `news.mail.example.com` → `example.com`, `a.shop.co.uk` → `shop.co.uk`. */
export function orgDomain(domain: string): string {
  const d = domain.toLowerCase().replace(/\.$/, '');
  const parts = d.split('.');
  const keep = SECOND_LEVEL.test(d) ? 3 : 2;
  return parts.length <= keep ? d : parts.slice(-keep).join('.');
}

/** A rule's value cleaned, or null when it isn't one: a lower-case domain or address. */
export function imageSenderValue(kind: ImageSenderKind, value: string): string | null {
  const v = value.trim().toLowerCase();
  const domain = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (kind === 'domain') return domain.test(v) && !SHARED_MAIL_DOMAINS.has(v) ? v : null;
  const at = v.lastIndexOf('@');
  return at > 0 && v.length <= 254 && !/[\s<>"]/.test(v) && domain.test(v.slice(at + 1)) ? v : null;
}

/** The rule that lets this sender's images show, or null. An unconfirmed sender never matches. */
export function imageRule(rules: readonly ImageSender[], s: MessageSender | null | undefined): string | null {
  if (!s?.verified) return null;
  for (const r of rules) {
    if (r.kind === 'address' && r.value === s.address) return r.value;
    if (r.kind === 'domain' && (s.domain === r.value || s.domain.endsWith(`.${r.value}`))) return r.value;
  }
  return null;
}
