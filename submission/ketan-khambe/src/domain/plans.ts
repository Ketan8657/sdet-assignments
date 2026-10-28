import { Plan, PlanName } from './types';

export const PLANS: Record<PlanName, Plan> = {
  basic: { name: 'basic', amount: 1900, currency: 'USD', trialDays: 0 },
  pro: { name: 'pro', amount: 4900, currency: 'USD', trialDays: 14 }
};
