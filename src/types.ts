export type CiceroneAnnotationMode = 'terse' | 'detailed';

export interface CiceroneStepHighlight {
  line: number;
  anchor?: string;
  note: string;
}

export interface CiceroneStep {
  file: string;
  line: number;
  anchor?: string;
  title: string;
  explanation: string;
  detailedExplanation?: string;
  extraHighlights?: CiceroneStepHighlight[];
  type: 'concept' | 'execution' | 'tangent';
}

export interface CiceroneTour {
  id: string;
  topic: string;
  steps: CiceroneStep[];
  currentStepIndex: number;
  annotationMode: CiceroneAnnotationMode;
  question?: string;
  answerSummary?: string;
}
