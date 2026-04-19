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

/**
 * For each step, read the file and find the line that best matches
 * the step's anchor (function/variable/class name), falling back to
 * content-based matching from title + explanation.
 */
export function resolveStepLocations<T extends ResolvableStep>(steps: T[], _cwd: string): T[] {
  return steps.map(step => {
    const resolvedLine = resolveBestLine(step);
    if (resolvedLine !== step.line) {
      console.log(`[Cicerone] Resolved ${path.basename(step.file)}:${step.line} → ${resolvedLine} (anchor=${step.anchor ?? 'none'}, "${step.title}")`);
    }

    const resolvedStep = { ...step, line: resolvedLine };
    const resolvedHighlights = resolveExtraHighlights(resolvedStep);
    return resolvedHighlights ? { ...resolvedStep, extraHighlights: resolvedHighlights } : resolvedStep;
  });
}

function resolveBestLine(step: ResolvableStep): number {
  let content: string;
  try {
    content = fs.readFileSync(step.file, 'utf8');
  } catch {
    return step.line;
  }

  const lines = content.split('\n');
  const maxLine = lines.length;
  const originalLine = Math.max(1, Math.min(step.line, maxLine));

  // Strategy 1: exact anchor match (highest priority)
  if (step.anchor) {
    const anchorLine = findAnchorLine(lines, step.anchor, originalLine);
    if (anchorLine !== undefined) {
      return anchorLine;
    }
  }

  // Strategy 2: fuzzy content match from title + explanation
  const tokens = extractSearchTokens(step.title, step.explanation);
  if (tokens.length > 0) {
    const scored = scoreLines(lines, tokens);
    if (scored.length > 0 && scored[0].score > 0) {
      // If original line is close to a good match, prefer that neighborhood
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

/**
 * Find the line containing the anchor identifier. Prefers lines near
 * the original line number if there are multiple matches.
 */
function findAnchorLine(lines: string[], anchor: string, originalLine: number): number | undefined {
  const anchorLower = anchor.toLowerCase();
  const matches: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i].toLowerCase();

    // Exact anchor text appears on this line
    if (lineText.includes(anchorLower)) {
      // Prefer definition-like lines over mere references
      const trimmed = lines[i].trim();
      const isDefinition = /^\s*(export\s+)?(function|class|const|let|var|interface|type|enum|def |async |public |private |protected |static )/i.test(trimmed);
      const isDeclaration = /=\s*(async\s+)?function|=>|:\s*(string|number|boolean|void)/i.test(trimmed);

      if (isDefinition || isDeclaration) {
        matches.push(i + 1);
      } else {
        // Still consider non-definition matches but with lower priority
        matches.push(-(i + 1)); // negative = non-definition
      }
    }
  }

  if (matches.length === 0) {
    return undefined;
  }

  // Separate definition matches (positive) from reference matches (negative)
  const definitions = matches.filter(m => m > 0).map(Math.abs);
  const references = matches.filter(m => m < 0).map(Math.abs);

  // Prefer definition matches, then reference matches
  const candidates = definitions.length > 0 ? definitions : references;

  // Among candidates, prefer the one closest to the original line
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

  // Extract code-like identifiers
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

  // Extract quoted strings
  const quotedPattern = /[`'"]([a-zA-Z0-9_/.#$@-]+)[`'"]/g;
  while ((match = quotedPattern.exec(combined)) !== null) {
    const token = match[1].toLowerCase();
    if (token.length >= 2) {
      tokens.add(token);
    }
  }

  // Title words first (higher priority)
  const titleTokens: string[] = [];
  for (const word of title.split(/\s+/)) {
    const lower = word.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (lower.length >= 3 && !STOP_WORDS.has(lower)) {
      titleTokens.push(lower);
    }
  }

  return [...new Set([...titleTokens, ...tokens])];
}

function resolveExtraHighlights(step: ResolvableStep): ResolvableStep['extraHighlights'] {
  if (!step.extraHighlights?.length) {
    return undefined;
  }

  let content: string;
  try {
    content = fs.readFileSync(step.file, 'utf8');
  } catch {
    return step.extraHighlights;
  }

  const lines = content.split('\n');
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
