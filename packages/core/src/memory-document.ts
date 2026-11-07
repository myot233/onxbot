import { z } from 'zod';
import { chatTimestamp } from './time.js';

const zonedTime = z.union([
  z.iso.datetime({ offset: true }),
  z.iso.datetime({ offset: true, precision: -1 }),
]);
const metadataLine =
  /^ {0,3}(?:Recorded at|Updated):[\t ]*(?:\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?|unknown)[\t ]*$/i;
const explicitTimestamp =
  /(?<![\dT])(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})(?![\d:])/g;

function normalizeTime(
  match: string,
  date: string,
  clock: string,
  zone: string,
) {
  const input = `${date}T${clock}${zone}`;
  if (!zonedTime.safeParse(input).success) return match;
  const rendered = chatTimestamp(input);
  if (rendered === 'unknown') return match;
  const offset = rendered.slice(23);
  if (clock.split(':').length === 2) return `${rendered.slice(0, 16)}${offset}`;
  const fraction = clock.includes('.') ? `.${clock.split('.')[1]}` : '';
  return `${rendered.slice(0, 19)}${fraction}${offset}`;
}

/** Normalize known instants and storage metadata without guessing missing times. */
export function memoryBody(content: string): string {
  const lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.replaceAll('\r\n', '\n').split('\n')) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      lines.push(line);
      if (
        delimiter?.[1]?.[0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        !delimiter[2]?.trim()
      )
        fence = undefined;
      continue;
    }
    if (delimiter?.[1]) {
      fence = { marker: delimiter[1][0] ?? '`', length: delimiter[1].length };
      lines.push(line);
      continue;
    }
    // Quoted text and code examples are evidence, not note-level metadata.
    if (/^\s*>/.test(line) || line.includes('`') || /^(?: {4}|\t)/.test(line)) {
      lines.push(line);
      continue;
    }
    if (metadataLine.test(line)) continue;
    if (!line.trim() && !lines.at(-1)?.trim()) continue;
    lines.push(line.replace(explicitTimestamp, normalizeTime));
  }
  return lines.join('\n').trim();
}
