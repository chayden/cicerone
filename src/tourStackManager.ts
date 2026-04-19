import { CiceroneAnnotationMode, CiceroneStep, CiceroneTour } from './types';

interface TourMetadata {
  question?: string;
  answerSummary?: string;
}

export class TourStackManager {
  private readonly stack: CiceroneTour[] = [];
  private activeIndex = -1;

  initializeTour(topic: string, steps: CiceroneStep[], metadata?: TourMetadata): CiceroneTour {
    const tour = this.createTour(topic, steps, metadata);
    this.stack.length = 0;
    this.stack.push(tour);
    this.activeIndex = 0;
    return tour;
  }

  startTangent(topic: string, steps: CiceroneStep[], metadata?: TourMetadata): CiceroneTour {
    const tangent = this.createTour(topic, steps, metadata);
    this.stack.push(tangent);
    this.activeIndex = this.stack.length - 1;
    return tangent;
  }

  concludeJourney(): CiceroneTour | undefined {
    if (this.activeIndex < 0 || this.activeIndex >= this.stack.length) {
      return undefined;
    }

    this.stack.splice(this.activeIndex, 1);
    if (this.stack.length === 0) {
      this.activeIndex = -1;
      return undefined;
    }

    this.activeIndex = Math.max(0, Math.min(this.activeIndex - 1, this.stack.length - 1));
    return this.getActiveTour();
  }

  getActiveTour(): CiceroneTour | undefined {
    if (this.activeIndex < 0 || this.activeIndex >= this.stack.length) {
      return undefined;
    }

    return this.stack[this.activeIndex];
  }

  getActiveStep(): CiceroneStep | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    return activeTour.steps[activeTour.currentStepIndex];
  }

  moveToStep(index: number): CiceroneStep | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    if (index < 0 || index >= activeTour.steps.length) {
      return undefined;
    }

    activeTour.currentStepIndex = index;
    return activeTour.steps[index];
  }

  nextStep(): CiceroneStep | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    const nextIndex = activeTour.currentStepIndex + 1;
    if (nextIndex >= activeTour.steps.length) {
      return undefined;
    }

    activeTour.currentStepIndex = nextIndex;
    return activeTour.steps[nextIndex];
  }

  previousStep(): CiceroneStep | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    const previousIndex = activeTour.currentStepIndex - 1;
    if (previousIndex < 0) {
      return undefined;
    }

    activeTour.currentStepIndex = previousIndex;
    return activeTour.steps[previousIndex];
  }

  hasActiveTour(): boolean {
    return this.stack.length > 0;
  }

  getStackDepth(): number {
    return this.stack.length;
  }

  getTours(): readonly CiceroneTour[] {
    return this.stack;
  }

  setAnnotationMode(mode: CiceroneAnnotationMode): CiceroneTour | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    activeTour.annotationMode = mode;
    return activeTour;
  }

  toggleAnnotationMode(): CiceroneTour | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    activeTour.annotationMode = activeTour.annotationMode === 'terse' ? 'detailed' : 'terse';
    return activeTour;
  }

  activateTourAt(index: number): CiceroneTour | undefined {
    if (index < 0 || index >= this.stack.length) {
      return undefined;
    }

    this.activeIndex = index;
    return this.stack[index];
  }

  nextTour(): CiceroneTour | undefined {
    if (this.stack.length <= 1 || this.activeIndex >= this.stack.length - 1) {
      return undefined;
    }

    this.activeIndex += 1;
    return this.getActiveTour();
  }

  previousTour(): CiceroneTour | undefined {
    if (this.stack.length <= 1 || this.activeIndex <= 0) {
      return undefined;
    }

    this.activeIndex -= 1;
    return this.getActiveTour();
  }

  discardTourAt(index: number): { discarded: CiceroneTour; activeTour?: CiceroneTour } | undefined {
    if (index < 0 || index >= this.stack.length) {
      return undefined;
    }

    const [discarded] = this.stack.splice(index, 1);
    if (this.stack.length === 0) {
      this.activeIndex = -1;
      return { discarded, activeTour: undefined };
    }

    if (index < this.activeIndex) {
      this.activeIndex -= 1;
    } else if (index === this.activeIndex) {
      this.activeIndex = Math.max(0, Math.min(index - 1, this.stack.length - 1));
    }

    return { discarded, activeTour: this.getActiveTour() };
  }

  private createTour(topic: string, steps: CiceroneStep[], metadata?: TourMetadata): CiceroneTour {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      topic,
      steps,
      currentStepIndex: 0,
      annotationMode: 'terse',
      question: metadata?.question,
      answerSummary: metadata?.answerSummary
    };
  }
}
