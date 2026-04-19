import { CiceroneStep } from '../types';

export interface TourBackendRequest {
  cwd: string;
  question: string;
  activeFile?: string;
  selectedText?: string;
  activeStep?: {
    file: string;
    line: number;
    title: string;
    explanation: string;
  };
}

export interface TourBackendResponse {
  topic: string;
  answerSummary: string;
  steps: CiceroneStep[];
}

export interface TourBackendSession {
  generateTour(request: TourBackendRequest): Promise<TourBackendResponse>;
  dispose(): Promise<void> | void;
}

export interface TourBackend {
  createSession(cwd: string): Promise<TourBackendSession> | TourBackendSession;
}

