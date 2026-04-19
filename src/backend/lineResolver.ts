import * as fs from 'fs';
import * as path from 'path';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
  'this', 'that', 'these', 'those', 'it', 'its', 'and', 'or', 'but',
  'not', 'no', 'do', 'does', 'did', 'has', 'have', 'had', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'if', 'then', 'else', 'when', 'where', 'which', 'who', 'how',
  'what', 'why', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'than', 'too', 'very',
  'about', 'above', 'after', 'before', 'between', 'into', 'through',
  'during', 'here', 'there', 'up', 'down', 'out', 'off', 'over',
  'under', 'again', 'further', 'once', 'also', 'just', 'so'
]);

export interface ResolvableStep {
  file: string;
  line: number;
  anchor?: string;
  title: string;
  explanation: string;
  extraHighlights?: Array<{
    line: number;
    anchor?: string;
    note: string;
  }>;
}

interface ScoredLine {
  line: number;
  score: number;
}

export function resolveStepLocations<T extends ResolvableStep>(steps: T[], log?: (message: string) => void): T[] {
  return steps.map(step => resolveStepLocation(step, log));
}

function resolveStepLocation<T extends ResolvableStep>(step: T, log?: (message: string) => void): T {
  const lines = readLines(step.file);
  if (!lines) {
    return step;
  }

  const resolvedLine = resolveBestLine(step, lines);
  if (resolvedLine !== step.line) {
    emitLog(log, `[Cicerone] Resolved ${path.basename(step.file)}:${step.line} → ${resolvedLine} (anchor=${step.anchor ?? 'none'}, "${step.title}")`);
  }

  const resolvedStep = { ...step, line: resolvedLine };
  const resolvedHighlights = resolveExtraHighlights(resolvedStep, lines);
  return resolvedHighlights ? { ...resolvedStep, extraHighlights: resolvedHighlights } : resolvedStep;
}

function readLines(file: string): string[] | undefined {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return undefined;
  }
}

function resolveBestLine(step: ResolvableStep, lines: string[]): number {
  const maxLine = lines.length;
  const originalLine = Math.max(1, Math.min(step.line, maxLine));

  if (step.anchor) {
    const anchorLine = findAnchorLine(lines, step.anchor, originalLine);
    if (anchorLine !== undefined) {
      return anchorLine;
    }
  }

  const tokens = extractSearchTokens(step.title, step.explanation);
  if (tokens.length > 0) {
    const scored = scoreLines(lines, tokens);
    if (scored.length > 0 && scored[0].score > 0) {
      const best = scored[0];
      if (Math.abs(originalLine - best.line) <= 10) {
        const nearOriginal = scored.find(s => Math.abs(s.line - originalLine) <= 10 && s.score > 0);
        if (nearOriginal) {
          return nearOriginal.line;
        }
      }
      return best.line;
    }
  }

  return originalLine;
}

function findAnchorLine(lines: string[], anchor: string, originalLine: number): number | undefined {
  const anchorLower = anchor.toLowerCase();
  const matches: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].toLowerCase();
    if (!lineText.includes(anchorLower)) {
      continue;
    }

    const trimmed = lines[i].trim();
    const isDefinition = /^\s*(export\s+)?(function|class|const|let|var|interface|type|enum|def |async |public |private |protected |static )/i.test(trimmed);
    const isDeclaration = /=\s*(async\s+)?function|=>|:\s*(string|number|boolean|void)/i.test(trimmed);

    matches.push((isDefinition || isDeclaration ? 1 : -1) * (i + 1));
  }

  if (matches.length === 0) {
    return undefined;
  }

  const definitions = matches.filter(m => m > 0).map(Math.abs);
  const references = matches.filter(m => m < 0).map(Math.abs);
  const candidates = definitions.length > 0 ? definitions : references;

  let best = candidates[0];
  let bestDist = Math.abs(best - originalLine);
  for (let i = 1; i < candidates.length; i++) {
    const dist = Math.abs(candidates[i] - originalLine);
    if (dist < bestDist) {
      best = candidates[i];
      bestDist = dist;
    }
  }

  return best;
}

function extractSearchTokens(title: string, explanation: string): string[] {
  const combined = `${title} ${explanation}`;
  const tokens = new Set<string>();

  const identifierPattern = /\b[a-zA-Z_][a-zA-Z0-9_.]*\b/g;
  let match: RegExpExecArray | null;
  while ((match = identifierPattern.exec(combined)) !== null) {
    const token = match[0].toLowerCase();
    if (token.length >= 3 && !STOP_WORDS.has(token)) {
      tokens.add(token);
      const parts = token.split(/(?=[A-Z])|[_\-.]/);
      for (const part of parts) {
        if (part.length >= 3 && !STOP_WORDS.has(part)) {
          tokens.add(part.toLowerCase());
        }
      }
    }
  }

  const quotedPattern = /[`'"]([a-zA-Z0-9_/.#$@-]+)[`'"]/g;
  while ((match = quotedPattern.exec(combined)) !== null) {
    const token = match[1].toLowerCase();
    if (token.length >= 2) {
      tokens.add(token);
    }
  }

  const titleTokens: string[] = [];
  for (const word of title.split(/\s+/)) {
    const lower = word.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (lower.length >= 3 && !STOP_WORDS.has(lower)) {
      titleTokens.push(lower);
    }
  }

  return [...new Set([...titleTokens, ...tokens])];
}

function resolveExtraHighlights(step: ResolvableStep, lines: string[]): ResolvableStep['extraHighlights'] {
  if (!step.extraHighlights?.length) {
    return undefined;
  }

  const maxLine = lines.length;
  const windowStart = Math.max(1, step.line);
  const windowEnd = Math.min(maxLine, step.line + 25);

  const resolved = step.extraHighlights
    .map(highlight => {
      let line = Math.max(1, Math.min(highlight.line, maxLine));

      if (highlight.anchor) {
        const preferred = findAnchorLineInWindow(lines, highlight.anchor, line, windowStart, windowEnd);
        if (preferred !== undefined) {
          line = preferred;
        } else {
          const fallback = findAnchorLine(lines, highlight.anchor, line);
          if (fallback !== undefined) {
            line = fallback;
          }
        }
      }

      return { ...highlight, line };
    })
    .filter(highlight => highlight.line >= windowStart && highlight.line <= windowEnd);

  return resolved.length ? resolved : undefined;
}

function findAnchorLineInWindow(lines: string[], anchor: string, originalLine: number, startLine: number, endLine: number): number | undefined {
  const anchorLower = anchor.toLowerCase();
  const matches: number[] = [];

  for (let i = startLine - 1; i < Math.min(lines.length, endLine); i++) {
    if (lines[i].toLowerCase().includes(anchorLower)) {
      matches.push(i + 1);
    }
  }

  if (!matches.length) {
    return undefined;
  }

  let best = matches[0];
  let bestDist = Math.abs(best - originalLine);
  for (let i = 1; i < matches.length; i++) {
    const dist = Math.abs(matches[i] - originalLine);
    if (dist < bestDist) {
      best = matches[i];
      bestDist = dist;
    }
  }

  return best;
}

function scoreLines(lines: string[], tokens: string[]): ScoredLine[] {
  const scored: ScoredLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    const trimmed = lines[i].trim();

    if (!trimmed || /^[{}()\[\],;]+$/.test(trimmed)) {
      continue;
    }

    let score = 0;
    for (let t = 0; t < tokens.length; t++) {
      if (lower.includes(tokens[t])) {
        score += tokens.length - t;
      }
    }

    if (/^\s*(export\s+)?(function|class|const|let|var|interface|type|enum|def |async |public |private |protected |static )/i.test(trimmed)) {
      score += 2;
    }

    if (score > 0) {
      scored.push({ line: i + 1, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function emitLog(log: ((message: string) => void) | undefined, message: string): void {
  if (log) {
    log(message);
  }
}
