import { SubscriptionStatus } from './types';

const TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  trialing: ['active', 'past_due', 'canceled'],
  active: ['past_due', 'canceled'],
  past_due: ['active', 'canceled'],
  canceled: []
};

export class InvalidTransitionError extends Error {
  constructor(from: SubscriptionStatus, to: SubscriptionStatus) {
    super(`Invalid subscription transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class SubscriptionStateMachine {
  canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
    return TRANSITIONS[from].includes(to);
  }

  transition(from: SubscriptionStatus, to: SubscriptionStatus): SubscriptionStatus {
    if (!this.canTransition(from, to)) throw new InvalidTransitionError(from, to);
    return to;
  }

  getAllowedTransitions(from: SubscriptionStatus): readonly SubscriptionStatus[] {
    return [...TRANSITIONS[from]];
  }

  isTerminal(status: SubscriptionStatus): boolean {
    return TRANSITIONS[status].length === 0;
  }
}
