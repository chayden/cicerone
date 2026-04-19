import { CiceroneAnnotationMode, CiceroneStep, CiceroneTour } from './types';

interface TourMetadata {
  question?: string;
  answerSummary?: string;
}

export class TourStackManager {
  private readonly stack: CiceroneTour[] = [];
  private activeIndex = -1;
  private interactionVersion = 0;

  createPendingRoot(question: string): CiceroneTour {
    const topic = abbreviateQuestion(question);
    const tour = this.createTour(topic, [], { question });
    tour.status = 'loading';
    tour.rootTourId = tour.id;
    this.stack.push(tour);
    return tour;
  }

  createPendingTangent(question: string): CiceroneTour | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    const tangent = this.createTour(abbreviateQuestion(question), [], { question });
    tangent.status = 'loading';
    tangent.parentTourId = activeTour.id;
    tangent.rootTourId = activeTour.rootTourId;
    this.stack.push(tangent);
    return tangent;
  }

  completePendingTour(id: string, topic: string, steps: CiceroneStep[], metadata?: TourMetadata): CiceroneTour | undefined {
    const tour = this.stack.find(item => item.id === id);
    if (!tour) {
      return undefined;
    }

    tour.topic = topic;
    tour.steps = steps;
    tour.currentStepIndex = 0;
    tour.status = 'ready';
    tour.answerSummary = metadata?.answerSummary;
    tour.question = metadata?.question ?? tour.question;
    tour.errorMessage = undefined;
    return tour;
  }

  failPendingTour(id: string, message: string): CiceroneTour | undefined {
    const tour = this.stack.find(item => item.id === id);
    if (!tour) {
      return undefined;
    }

    tour.status = 'error';
    tour.errorMessage = message;
    tour.topic = `${tour.topic} (failed)`;
    return tour;
  }

  concludeJourney(): CiceroneTour | undefined {
    if (this.activeIndex < 0 || this.activeIndex >= this.stack.length) {
      return undefined;
    }

    const activeTour = this.stack[this.activeIndex];
    if (!activeTour.parentTourId) {
      this.removeRootFamilyAt(this.activeIndex);
    } else {
      this.stack.splice(this.activeIndex, 1);
    }

    this.interactionVersion += 1;
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
    if (!activeTour || activeTour.status !== 'ready') {
      return undefined;
    }

    return activeTour.steps[activeTour.currentStepIndex];
  }

  moveToStep(index: number): CiceroneStep | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour || activeTour.status !== 'ready') {
      return undefined;
    }

    if (index < 0 || index >= activeTour.steps.length) {
      return undefined;
    }

    activeTour.currentStepIndex = index;
    this.interactionVersion += 1;
    return activeTour.steps[index];
  }

  nextStep(): CiceroneStep | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour || activeTour.status !== 'ready') {
      return undefined;
    }

    const nextIndex = activeTour.currentStepIndex + 1;
    if (nextIndex >= activeTour.steps.length) {
      return undefined;
    }

    activeTour.currentStepIndex = nextIndex;
    this.interactionVersion += 1;
    return activeTour.steps[nextIndex];
  }

  previousStep(): CiceroneStep | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour || activeTour.status !== 'ready') {
      return undefined;
    }

    const previousIndex = activeTour.currentStepIndex - 1;
    if (previousIndex < 0) {
      return undefined;
    }

    activeTour.currentStepIndex = previousIndex;
    this.interactionVersion += 1;
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

  getInteractionVersion(): number {
    return this.interactionVersion;
  }

  setAnnotationMode(mode: CiceroneAnnotationMode): CiceroneTour | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    activeTour.annotationMode = mode;
    this.interactionVersion += 1;
    return activeTour;
  }

  toggleAnnotationMode(): CiceroneTour | undefined {
    const activeTour = this.getActiveTour();
    if (!activeTour) {
      return undefined;
    }

    activeTour.annotationMode = activeTour.annotationMode === 'terse' ? 'detailed' : 'terse';
    this.interactionVersion += 1;
    return activeTour;
  }

  activateTourAt(index: number): CiceroneTour | undefined {
    if (index < 0 || index >= this.stack.length) {
      return undefined;
    }

    if (this.stack[index].status !== 'ready') {
      return undefined;
    }

    this.activeIndex = index;
    this.interactionVersion += 1;
    return this.stack[index];
  }

  activateTourById(id: string): CiceroneTour | undefined {
    const index = this.stack.findIndex(tour => tour.id === id);
    if (index === -1) {
      return undefined;
    }
    return this.activateTourAt(index);
  }

  nextTour(): CiceroneTour | undefined {
    for (let index = this.activeIndex + 1; index < this.stack.length; index++) {
      if (this.stack[index].status === 'ready') {
        this.activeIndex = index;
        this.interactionVersion += 1;
        return this.stack[index];
      }
    }
    return undefined;
  }

  previousTour(): CiceroneTour | undefined {
    for (let index = this.activeIndex - 1; index >= 0; index--) {
      if (this.stack[index].status === 'ready') {
        this.activeIndex = index;
        this.interactionVersion += 1;
        return this.stack[index];
      }
    }
    return undefined;
  }

  discardTourAt(index: number): { discarded: CiceroneTour; activeTour?: CiceroneTour; discardedIds: string[] } | undefined {
    if (index < 0 || index >= this.stack.length) {
      return undefined;
    }

    const discarded = this.stack[index];
    const discardedIds = !discarded.parentTourId
      ? this.removeRootFamilyAt(index)
      : [this.stack.splice(index, 1)[0].id];

    if (this.stack.length === 0) {
      this.activeIndex = -1;
      this.interactionVersion += 1;
      return { discarded, activeTour: undefined, discardedIds };
    }

    if (index < this.activeIndex) {
      this.activeIndex = Math.max(0, this.activeIndex - discardedIds.length);
    } else if (index === this.activeIndex) {
      this.activeIndex = Math.max(0, Math.min(index - 1, this.stack.length - 1));
    }

    this.interactionVersion += 1;
    return { discarded, activeTour: this.getActiveTour(), discardedIds };
  }

  private removeRootFamilyAt(index: number): string[] {
    const root = this.stack[index];
    const rootId = root.id;
    const removedIds: string[] = [];

    for (let i = this.stack.length - 1; i >= 0; i--) {
      const tour = this.stack[i];
      if (tour.id === rootId || tour.rootTourId === rootId) {
        removedIds.push(tour.id);
        this.stack.splice(i, 1);
      }
    }

    return removedIds;
  }

  private createTour(topic: string, steps: CiceroneStep[], metadata?: TourMetadata): CiceroneTour {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      topic,
      steps,
      currentStepIndex: 0,
      annotationMode: 'terse',
      status: 'ready',
      rootTourId: id,
      question: metadata?.question,
      answerSummary: metadata?.answerSummary
    };
  }
}

function abbreviateQuestion(question: string): string {
  const trimmed = question.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
}
