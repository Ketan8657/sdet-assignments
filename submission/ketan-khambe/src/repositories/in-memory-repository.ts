import { AuditEvent, Invoice, Subscription, WebhookEvent } from '../domain/types';

export class InMemoryRepository {
  readonly subscriptions = new Map<string, Subscription>();
  readonly invoices = new Map<string, Invoice>();
  readonly webhookEvents: WebhookEvent[] = [];
  readonly auditEvents: AuditEvent[] = [];
  readonly processedEventIds = new Set<string>();
  readonly succeededInvoiceIds = new Set<string>();

  reset(): void {
    this.subscriptions.clear(); this.invoices.clear(); this.webhookEvents.length = 0;
    this.auditEvents.length = 0; this.processedEventIds.clear(); this.succeededInvoiceIds.clear();
  }

  getSubscription(id: string): Subscription | undefined { return this.subscriptions.get(id); }
  getInvoicesForSubscription(id: string): Invoice[] {
    return [...this.invoices.values()].filter(invoice => invoice.subscriptionId === id);
  }
  getEventsForSubscription(id: string): WebhookEvent[] {
    return this.webhookEvents.filter(event => event.subscriptionId === id);
  }
  getAuditForSubscription(id: string): AuditEvent[] {
    return this.auditEvents.filter(event => event.subscriptionId === id);
  }

  findInvoice(id: string): Invoice | undefined {
    return this.invoices.get(id);
  }

  findLatestInvoiceForSubscription(id: string): Invoice | undefined {
    const list = this.getInvoicesForSubscription(id);
    return list[list.length - 1];
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  getInvoiceCount(): number {
    return this.invoices.size;
  }

  hasProcessedEvent(eventId: string): boolean {
    return this.processedEventIds.has(eventId);
  }
}
