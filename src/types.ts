export type CiceroneAnnotationMode = 'terse' | 'detailed';

export interface CiceroneStepHighlight {
  line: number;
  anchor?: string;
  authorName?: string;
  note: string;
}

export interface CiceroneStep {
  file: string;
  line: number;
  anchor?: string;
  authorName?: string;
  title: string;
  explanation: string;
  detailedExplanation?: string;
  extraHighlights?: CiceroneStepHighlight[];
  type: 'concept' | 'execution' | 'tangent';
}

export type CiceroneTourStatus = 'loading' | 'ready' | 'error';

export interface CiceroneTour {
  id: string;
  topic: string;
  steps: CiceroneStep[];
  currentStepIndex: number;
  annotationMode: CiceroneAnnotationMode;
  status: CiceroneTourStatus;
  rootTourId: string;
  parentTourId?: string;
  question?: string;
  answerSummary?: string;
  errorMessage?: string;
}

export interface CiceroneSavedNoteContext {
  topic: string;
  file: string;
  line: number;
  anchor?: string;
  title: string;
  explanation: string;
  userNote: string;
}
