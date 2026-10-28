import { createHmac, timingSafeEqual } from 'node:crypto';
import { SubscriptionStateMachine } from './state-machine';
import { PLANS } from './plans';
import {
  CreateSubscriptionRequest, Invoice, PaymentProvider, PaymentWebhook, PlanName,
  Subscription, SubscriptionStatus, WebhookEvent
} from './types';
import { InMemoryRepository } from '../repositories/in-memory-repository';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = 'HttpError'; }
}

export class SubscriptionService {
  private readonly stateMachine = new SubscriptionStateMachine();
  private subscriptionSequence = 0;
  private invoiceSequence = 0;
  private auditSequence = 0;

  constructor(
    private readonly repository: InMemoryRepository,
    private readonly paymentProvider: PaymentProvider,
    private readonly webhookSecret = 'test-webhook-secret'
  ) {}

  async createSubscription(input: CreateSubscriptionRequest): Promise<Subscription> {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Request body is required');
    if (!input.customer_id?.trim()) throw new HttpError(400, 'customer_id is required');
    if (!input.payment_method_id?.trim()) throw new HttpError(400, 'payment_method_id is required');
    if (!(input.plan in PLANS)) throw new HttpError(400, 'Unknown plan');

    const plan = PLANS[input.plan as PlanName];
    const now = new Date().toISOString();
    const id = `sub_${++this.subscriptionSequence}`;
    const subscription: Subscription = {
      id, customerId: input.customer_id, plan: plan.name,
      paymentMethodId: input.payment_method_id,
      status: plan.trialDays > 0 ? 'trialing' : 'trialing',
      createdAt: now, updatedAt: now
    };
    this.repository.subscriptions.set(id, subscription);
    this.audit(id, null, 'trialing', 'subscription.created');

    if (plan.trialDays === 0) {
      try {
        const result = await this.paymentProvider.charge({
          customerId: input.customer_id,
          paymentMethodId: input.payment_method_id,
          amount: plan.amount,
          currency: plan.currency,
          idempotencyKey: `initial-${id}`
        });
        const invoice = this.makeInvoice(id, plan.amount, result.providerReference, result.outcome === 'success' ? 'succeeded' : 'failed');
        this.repository.invoices.set(invoice.id, invoice);
        if (result.outcome === 'success') this.changeStatus(subscription, 'active', 'initial_payment.succeeded');
        else this.changeStatus(subscription, 'past_due', 'initial_payment.failed');
      } catch (error) {
        this.changeStatus(subscription, 'past_due', 'initial_payment.timeout');
        const invoice = this.makeInvoice(id, plan.amount, `timeout-${id}`, 'failed');
        this.repository.invoices.set(invoice.id, invoice);
      }
    }
    return { ...subscription };
  }

  getSubscription(id: string): Subscription {
    const subscription = this.repository.getSubscription(id);
    if (!subscription) throw new HttpError(404, 'Subscription not found');
    return { ...subscription };
  }

  cancelSubscription(id: string): Subscription {
    const subscription = this.requireSubscription(id);
    if (subscription.status === 'canceled') throw new HttpError(409, 'Subscription is already canceled');
    this.changeStatus(subscription, 'canceled', 'customer.cancelled');
    return { ...subscription };
  }

  signWebhook(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  async processWebhook(rawBody: string, signature: string | undefined): Promise<{ accepted: boolean; duplicate: boolean }> {
    if (!signature || !this.isValidSignature(rawBody, signature)) throw new HttpError(401, 'Invalid webhook signature');
    let payload: PaymentWebhook;
    try { payload = JSON.parse(rawBody) as PaymentWebhook; }
    catch { throw new HttpError(400, 'Malformed JSON payload'); }
    if (!payload.event_id || !payload.type || !payload.subscription_id || !payload.invoice_id ||
        !Number.isFinite(payload.amount) || payload.amount < 0 || payload.currency !== 'USD' ||
        !['payment.succeeded', 'payment.failed', 'payment.refunded'].includes(payload.type)) {
      throw new HttpError(400, 'Invalid webhook payload');
    }

    const existing = this.repository.webhookEvents.find(event => event.eventId === payload.event_id && !event.duplicate);
    if (existing) {
      this.repository.webhookEvents.push({
        eventId: payload.event_id, subscriptionId: payload.subscription_id, type: payload.type,
        processedAt: new Date().toISOString(), duplicate: true, ignoredReason: 'duplicate_event_id'
      });
      return { accepted: true, duplicate: true };
    }

    const subscription = this.repository.getSubscription(payload.subscription_id);
    if (!subscription) throw new HttpError(404, 'Subscription not found');
    this.repository.processedEventIds.add(payload.event_id);
    const event: WebhookEvent = {
      eventId: payload.event_id, subscriptionId: payload.subscription_id, type: payload.type,
      processedAt: new Date().toISOString(), duplicate: false
    };
    this.repository.webhookEvents.push(event);

    if (subscription.status === 'canceled') {
      event.ignoredReason = 'subscription_canceled';
      return { accepted: true, duplicate: false };
    }

    const existingInvoice = this.repository.invoices.get(payload.invoice_id);
    if (payload.type === 'payment.succeeded') {
      if (existingInvoice?.status === 'succeeded') {
        event.ignoredReason = 'invoice_already_succeeded';
        return { accepted: true, duplicate: false };
      }
      const invoice = this.invoiceFromWebhook(payload, 'succeeded');
      this.repository.invoices.set(invoice.id, invoice);
      this.repository.succeededInvoiceIds.add(invoice.id);
      if (subscription.status === 'trialing' || subscription.status === 'past_due') this.changeStatus(subscription, 'active', payload.type);
    } else if (payload.type === 'payment.failed') {
      // A stale failure must never overwrite an already-successful payment for the same invoice.
      if (existingInvoice?.status === 'succeeded') {
        event.ignoredReason = 'stale_failure_after_success';
        return { accepted: true, duplicate: false };
      }
      const invoice = this.invoiceFromWebhook(payload, 'failed');
      this.repository.invoices.set(invoice.id, invoice);
      if (subscription.status === 'trialing' || subscription.status === 'active') this.changeStatus(subscription, 'past_due', payload.type);
    } else {
      if (!existingInvoice) {
        event.ignoredReason = 'refund_without_invoice';
        return { accepted: true, duplicate: false };
      }
      this.repository.invoices.set(existingInvoice.id, { ...existingInvoice, status: 'refunded' });
      // Refund is recorded; the assignment does not prescribe a refund-specific subscription transition.
    }
    return { accepted: true, duplicate: false };
  }

  private isValidSignature(rawBody: string, signature: string): boolean {
    const expected = Buffer.from(this.signWebhook(rawBody), 'hex');
    let received: Buffer;
    try { received = Buffer.from(signature, 'hex'); } catch { return false; }
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private requireSubscription(id: string): Subscription {
    const subscription = this.repository.getSubscription(id);
    if (!subscription) throw new HttpError(404, 'Subscription not found');
    return subscription;
  }

  private changeStatus(subscription: Subscription, next: SubscriptionStatus, reason: string): void {
    const previous = subscription.status;
    if (previous === next) return;
    subscription.status = this.stateMachine.transition(previous, next);
    subscription.updatedAt = new Date().toISOString();
    this.audit(subscription.id, previous, next, reason);
  }

  private makeInvoice(subscriptionId: string, amount: number, reference: string, status: Invoice['status']): Invoice {
    return { id: `inv_${++this.invoiceSequence}`, subscriptionId, amount, currency: 'USD', status, providerReference: reference, createdAt: new Date().toISOString() };
  }

  private invoiceFromWebhook(payload: PaymentWebhook, status: Invoice['status']): Invoice {
    return { id: payload.invoice_id, subscriptionId: payload.subscription_id, amount: payload.amount, currency: payload.currency, status, providerReference: `webhook-${payload.event_id}`, createdAt: new Date().toISOString() };
  }

  private audit(subscriptionId: string, from: SubscriptionStatus | null, to: SubscriptionStatus, reason: string): void {
    this.repository.auditEvents.push({ id: `audit_${++this.auditSequence}`, subscriptionId, from, to, reason, createdAt: new Date().toISOString() });
  }
}
