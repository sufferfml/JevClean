import { createHash } from 'node:crypto';
import type { EmailMessage } from '../shared/contracts';

export const TEXT_LIMIT = 24000;
export const DATE_EVIDENCE_LIMIT = 32;
export function fingerprint(messageId: string, date: string, subject: string, sender: string): string {
  return createHash('sha256').update(JSON.stringify([messageId, date, subject, sender])).digest('hex');
}
export function redact(text: string): string {
  return text
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[embedded content omitted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => { try { return new URL(value).origin + '/[link]'; } catch { return '[link]'; } })
    .replace(/((?:api[_ -]?key|password|密码|口令)\s*[:：=]\s*)[^\s,;，；]+/gi, '$1[redacted]')
    .replace(/((?:authentication code|verification code|one.time code|验证码|校验码|动态码)\s*(?:is|为|是)?\s*[:：]?\s*)[\d -]{4,12}/gi, '$1[code]')
    .replace(/(\b(?:following|authentication|verification|one[ -]time) code\b[^\d]{0,120}\n\s*)\d{4,10}(?=\s*(?:\n|$))/gi, '$1[code]');
}
export function outboundState(message: EmailMessage, now: Date) {
  const age = now.getTime() - Date.parse(message.date);
  return {
    currentTime: now.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ageMinutes: Number.isFinite(age) ? age / 60000 : null,
    ageHours: Number.isFinite(age) ? age / 3600000 : null,
    ageDays: Number.isFinite(age) ? age / 86400000 : null,
    email: {
      subject: redact(message.subject), sender: redact(message.sender), senderAddress: message.senderAddress,
      receivedAt: message.date, text: redact(message.text).slice(0, TEXT_LIMIT),
      starred: message.flags.includes('\\Flagged'), replied: message.isReply || message.flags.includes('\\Answered'),
      read: message.flags.includes('\\Seen'),
      hasAttachment: message.hasAttachment,
    },
  };
}
export interface DateEvidence { id: string; value: string; endAt: string; context: string }
/** Enumerate literal calendar/duration evidence; Jev chooses its meaning. No email categories here. */
export function extractDates(text: string, receivedAt: string): DateEvidence[] {
  const candidates: DateEvidence[] = [];
  const calendarSpans: Array<[number, number]> = [];
  const received = new Date(receivedAt);
  const add = (value: string, end: Date, index: number) => {
    if (!Number.isFinite(end.getTime()) || candidates.some(c => c.value === value && c.endAt === end.toISOString())) return;
    if (candidates.length >= DATE_EVIDENCE_LIMIT) return;
    candidates.push({ id: 'date_' + candidates.length, value, endAt: end.toISOString(), context: text.slice(Math.max(0, index - 80), index + value.length + 80) });
  };
  const calendar = (year: number, month: number, day: number) => {
    const date = new Date(year, month - 1, day, 23, 59, 59, 999);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : new Date(NaN);
  };
  for (const match of text.matchAll(/\b(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:\s*日)?/g)) {
    calendarSpans.push([match.index!, match.index! + match[0].length]);
    add(match[0], calendar(+match[1], +match[2], +match[3]), match.index!);
  }
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  for (const match of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/gi)) {
    calendarSpans.push([match.index!, match.index! + match[0].length]);
    add(match[0], calendar(+match[3], months.indexOf(match[1].toLowerCase()) + 1, +match[2]), match.index!);
  }
  for (const match of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)[,]?\s+(20\d{2})\b/gi)) {
    calendarSpans.push([match.index!, match.index! + match[0].length]);
    add(match[0], calendar(+match[3], months.indexOf(match[2].toLowerCase()) + 1, +match[1]), match.index!);
  }
  // A yearless calendar date is unsupported evidence, not a duration of N months.
  for (const match of text.matchAll(/\d{1,2}月\d{1,2}(?:日|号)/g)) calendarSpans.push([match.index!, match.index! + match[0].length]);
  if (Number.isFinite(received.getTime())) {
    for (const match of text.matchAll(/(\d{1,4}(?:\.\d{1,3})?|[零一二两三四五六七八九十]{1,3}|半)\s*个?\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|秒钟?|分钟|小时|天|周|星期|月|年)(?![a-z])/gi)) {
      if (calendarSpans.some(([start, end]) => match.index! >= start && match.index! < end) || /\d/.test(text[match.index! - 1] ?? '')) continue;
      const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
      const word = match[1];
      const amount = /^\d/.test(word) ? Number(word) : word === '半' ? 0.5 : word.includes('十') ? (word.startsWith('十') ? 1 : digits[word[0]]) * 10 + (digits[word.split('十')[1]] ?? 0) : digits[word];
      if (!Number.isFinite(amount) || amount <= 0) continue;
      let end: Date;
      if (/month|year|月|年/i.test(match[2])) {
        const months = amount * (/year|年/i.test(match[2]) ? 12 : 1);
        if (!Number.isInteger(months)) continue;
        end = new Date(received); end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + months);
        const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
        end.setUTCDate(Math.min(received.getUTCDate(), lastDay));
      } else {
        const unit = /second|秒/i.test(match[2]) ? 1000 : /minute|分钟/i.test(match[2]) ? 60000 : /hour|小时/i.test(match[2]) ? 3600000 : /week|周|星期/i.test(match[2]) ? 604800000 : 86400000;
        end = new Date(received.getTime() + amount * unit);
      }
      add(match[0], end, match.index!);
    }
    for (const match of text.matchAll(/后天|明天|\bday after tomorrow\b|\btomorrow\b/gi)) {
      const date = new Date(received); date.setDate(date.getDate() + (/后天|day after/i.test(match[0]) ? 2 : 1));
      date.setHours(23, 59, 59, 999); add(match[0], date, match.index!);
    }
  }
  return candidates;
}
