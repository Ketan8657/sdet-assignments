import { PaymentWebhook, WebhookType } from '../domain/types';

export class WebhookBuilder {
  private payload: Record<string, unknown> = {
    event_id: 'evt-default',
    type: 'payment.succeeded',
    subscription_id: 'sub-default',
    invoice_id: 'inv-default',
    amount: 4900,
    currency: 'USD'
  };

  withEventId(eventId: string): this {
    this.payload.event_id = eventId;
    return this;
  }

  withType(type: WebhookType): this {
    this.payload.type = type;
    return this;
  }

  withInvalidType(type = 'payment.disputed'): this {
    this.payload.type = type;
    return this;
  }

  forSubscription(subscriptionId: string): this {
    this.payload.subscription_id = subscriptionId;
    return this;
  }

  forInvoice(invoiceId: string): this {
    this.payload.invoice_id = invoiceId;
    return this;
  }

  withAmount(amount: number): this {
    this.payload.amount = amount;
    return this;
  }

  withCurrency(currency: string): this {
    this.payload.currency = currency;
    return this;
  }

  withoutField(field: string): this {
    delete this.payload[field];
    return this;
  }

  withCustomProperty(key: string, value: unknown): this {
    this.payload[key] = value;
    return this;
  }

  build(): PaymentWebhook {
    return { ...(this.payload as unknown as PaymentWebhook) };
  }

  buildRaw(): Record<string, unknown> {
    return { ...this.payload };
  }

  buildJson(): string {
    return JSON.stringify(this.payload);
  }
}
