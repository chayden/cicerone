import * as path from 'path';
import { TourBackendRequest, TourBackendResponse } from './types';
import { CiceroneStep, CiceroneStepHighlight } from '../types';

export function buildTourPrompt(question: string, cwd: string, activeFile?: string, selectedText?: string, activeStep?: TourBackendRequest['activeStep']): string {
  const selectionBlock = selectedText?.trim()
    ? `\nActive selection for extra context:\n<<<SELECTION\n${selectedText.trim()}\nSELECTION>>>\n`
    : '';

  const stepContext = activeStep
    ? `\nThe user is currently viewing this tour step:\nFile: ${activeStep.file}\nLine: ${activeStep.line}\nTitle: ${activeStep.title}\nContext: ${activeStep.explanation}\n`
    : '';

  return `You are generating a guided code tour for a VS Code extension named Cicerone.

Repository root: ${cwd}
${activeFile ? `Active file: ${activeFile}\n` : ''}${selectionBlock}${stepContext}
User question: ${question}

Investigate the codebase and answer the question as a tour.
Return ONLY valid JSON. Do not wrap it in markdown fences. Do not include any prose before or after the JSON.

Schema:
{
  "topic": string,
  "answerSummary": string,
  "steps": [
    {
      "file": string,
      "line": number,
      "anchor": string,
      "title": string,
      "explanation": string,
      "detailedExplanation": string,
      "extraHighlights": [
        {
          "line": number,
          "anchor": string,
          "note": string
        }
      ],
      "type": "concept" | "execution" | "tangent"
    }
  ]
}

Rules:
- Include 3 to 8 steps.
- Each step must reference a real file in the repository.
- Prefer the most relevant files for answering the question.
- Use 1-based line numbers.
- Use repository-relative paths if convenient.
- **anchor** must be the exact function name, variable name, class name, or symbol at the code location the step describes. This is used to locate the precise line in the file.
- answerSummary should directly answer the user's question in markdown, briefly.
- explanation must be terse but complete: 1 to 3 sentences, focused on what this location contributes.
- detailedExplanation must be a fuller markdown explanation for the same step, with more specifics.
- You may optionally include "extraHighlights" for a step when there are 1 to 3 nearby lines worth calling out with very short notes.
- Each extraHighlights note should be brief: usually 1 to 2 lines, focused on a local detail that supports the main step.
- extraHighlights should usually point to lines in the same file and typically within about the next 20 lines after the main step's line.
- Use extraHighlights sparingly; only include them when they make the walkthrough clearer.
- The explanation will be shown to the user as a highlight/note directly on the code, so do not paste the code at that location back into the response unless quoting a tiny fragment is genuinely necessary.
- Do not embed large code blocks or restate the implementation line-for-line.
- If an additional example is useful (for example, a small usage example from another file), that is allowed, but keep it short and only include it when it materially helps explain the code.
- explanation and detailedExplanation should not be identical.
- Order steps like a coherent walkthrough.
- If there is uncertainty, say so in answerSummary or explanations, but still produce the best possible tour.
`;
}

export function parseTourResponse(raw: string, cwd: string): TourBackendResponse {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Agent returned an empty response.');
  }

  const jsonText = extractJsonObject(trimmed);
  const parsed = JSON.parse(jsonText) as Partial<TourBackendResponse>;

  if (!parsed.topic || !parsed.answerSummary || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`Agent returned invalid tour JSON: ${trimmed}`);
  }

  const steps = parsed.steps
    .map((step, index) => normalizeStep(step, index, cwd))
    .filter((s): s is CiceroneStep => s !== undefined);

  if (steps.length === 0) {
    throw new Error(`Agent returned a tour with no valid steps. Raw had ${parsed.steps.length} entries.`);
  }

  return {
    topic: parsed.topic,
    answerSummary: parsed.answerSummary,
    steps
  };
}

const VALID_TYPES = new Set(['concept', 'execution', 'tangent']);

function normalizeStep(step: unknown, index: number, cwd: string): CiceroneStep | undefined {
  if (!step || typeof step !== 'object') {
    console.warn(`[Cicerone] Skipping invalid step at index ${index}: not an object.`);
    return undefined;
  }

  const candidate = step as Record<string, unknown>;
  const file = typeof candidate.file === 'string' && candidate.file.trim() ? candidate.file.trim() : undefined;
  const line = typeof candidate.line === 'number' && candidate.line >= 1 ? Math.floor(candidate.line) : undefined;
  const anchor = typeof candidate.anchor === 'string' && candidate.anchor.trim() ? candidate.anchor.trim() : undefined;
  const title = typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : undefined;
  const explanation = typeof candidate.explanation === 'string' && candidate.explanation.trim() ? candidate.explanation.trim() : undefined;
  const detailedExplanation = typeof candidate.detailedExplanation === 'string' && candidate.detailedExplanation.trim() ? candidate.detailedExplanation.trim() : explanation;
  const extraHighlights = normalizeHighlights(candidate.extraHighlights);
  const rawType = typeof candidate.type === 'string' ? candidate.type.trim().toLowerCase() : '';
  const type = VALID_TYPES.has(rawType) ? rawType as CiceroneStep['type'] : undefined;

  if (!file || !title || !explanation) {
    console.warn(`[Cicerone] Skipping incomplete step at index ${index}: ${JSON.stringify(candidate).slice(0, 200)}`);
    return undefined;
  }

  return {
    file: resolveFilePath(file, cwd),
    line: line ?? 1,
    anchor,
    title,
    explanation,
    detailedExplanation: detailedExplanation || explanation,
    extraHighlights,
    type: type ?? 'concept'
  };
}

function normalizeHighlights(value: unknown): CiceroneStepHighlight[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const highlights = value
    .map((entry): CiceroneStepHighlight | undefined => {
      if (!entry || typeof entry !== 'object') {
        return undefined;
      }

      const candidate = entry as Record<string, unknown>;
      const line = typeof candidate.line === 'number' && candidate.line >= 1 ? Math.floor(candidate.line) : undefined;
      const anchor = typeof candidate.anchor === 'string' && candidate.anchor.trim() ? candidate.anchor.trim() : undefined;
      const note = typeof candidate.note === 'string' && candidate.note.trim() ? candidate.note.trim() : undefined;

      if (!line || !note) {
        return undefined;
      }

      return { line, anchor, note };
    })
    .filter((highlight): highlight is CiceroneStepHighlight => highlight !== undefined)
    .slice(0, 3);

  return highlights.length ? highlights : undefined;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();

  // Only unwrap markdown fences if the entire response is fenced.
  const wholeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (wholeFenceMatch?.[1]) {
    return wholeFenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`No JSON object found in agent response: ${text}`);
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

function resolveFilePath(file: string, cwd: string): string {
  if (path.isAbsolute(file)) {
    return file;
  }

  return path.join(cwd, file.replace(/^\.\//, ''));
}
