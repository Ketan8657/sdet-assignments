export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type PlanName = 'basic' | 'pro';
export type PaymentOutcome = 'success' | 'decline' | 'timeout';
export type WebhookType = 'payment.succeeded' | 'payment.failed' | 'payment.refunded';

export interface Plan {
  name: PlanName;
  amount: number;
  currency: 'USD';
  trialDays: number;
}

export interface CreateSubscriptionRequest {
  customer_id: string;
  plan: string;
  payment_method_id: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  plan: PlanName;
  paymentMethodId: string;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  subscriptionId: string;
  amount: number;
  currency: 'USD';
  status: 'succeeded' | 'failed' | 'refunded';
  providerReference: string;
  createdAt: string;
}

export interface WebhookEvent {
  eventId: string;
  subscriptionId: string;
  type: WebhookType;
  processedAt: string;
  duplicate: boolean;
  ignoredReason?: string;
}

export interface AuditEvent {
  id: string;
  subscriptionId: string;
  from: SubscriptionStatus | null;
  to: SubscriptionStatus;
  reason: string;
  createdAt: string;
}

export interface PaymentChargeRequest {
  customerId: string;
  paymentMethodId: string;
  amount: number;
  currency: 'USD';
  idempotencyKey: string;
}

export interface PaymentChargeResult {
  outcome: PaymentOutcome;
  providerReference: string;
}

export interface PaymentProvider {
  charge(request: PaymentChargeRequest): Promise<PaymentChargeResult>;
}

export interface PaymentWebhook {
  event_id: string;
  type: WebhookType;
  subscription_id: string;
  invoice_id: string;
  amount: number;
  currency: 'USD';
}
