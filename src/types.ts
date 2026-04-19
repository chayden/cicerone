export type CiceroneAnnotationMode = 'terse' | 'detailed';

export interface CiceroneStep {
  file: string;
  line: number;
  anchor?: string;
  title: string;
  explanation: string;
  detailedExplanation?: string;
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
