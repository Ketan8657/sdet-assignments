import { InMemoryRepository } from '../repositories/in-memory-repository';
import { Invoice, PlanName, Subscription, SubscriptionStatus } from '../domain/types';

export interface SeedSubscriptionOptions {
  id?: string;
  customerId?: string;
  plan?: PlanName;
  paymentMethodId?: string;
  status?: SubscriptionStatus;
  createInvoice?: boolean;
  invoiceStatus?: Invoice['status'];
}

export class SubscriptionFixtureFactory {
  private static sequence = 100;

  static createSubscriptionData(overrides: Partial<Subscription> = {}): Subscription {
    const id = overrides.id ?? `sub_factory_${++this.sequence}`;
    const now = new Date().toISOString();
    return {
      id,
      customerId: overrides.customerId ?? `cust_${this.sequence}`,
      plan: overrides.plan ?? 'pro',
      paymentMethodId: overrides.paymentMethodId ?? `pm_factory_${this.sequence}`,
      status: overrides.status ?? 'trialing',
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now
    };
  }

  static seed(repository: InMemoryRepository, options: SeedSubscriptionOptions = {}): Subscription {
    const status = options.status ?? 'trialing';
    const sub = this.createSubscriptionData({
      id: options.id,
      customerId: options.customerId,
      plan: options.plan ?? 'pro',
      paymentMethodId: options.paymentMethodId,
      status
    });

    repository.subscriptions.set(sub.id, sub);

    // Initial audit log
    repository.auditEvents.push({
      id: `audit_fac_${++this.sequence}`,
      subscriptionId: sub.id,
      from: null,
      to: 'trialing',
      reason: 'factory.created',
      createdAt: sub.createdAt
    });

    if (status !== 'trialing') {
      repository.auditEvents.push({
        id: `audit_fac_${++this.sequence}`,
        subscriptionId: sub.id,
        from: 'trialing',
        to: status,
        reason: `factory.transitioned_to_${status}`,
        createdAt: sub.updatedAt
      });
    }

    if (options.createInvoice || status === 'active' || status === 'past_due') {
      const invStatus = options.invoiceStatus ?? (status === 'active' ? 'succeeded' : 'failed');
      const invoice: Invoice = {
        id: `inv_fac_${++this.sequence}`,
        subscriptionId: sub.id,
        amount: sub.plan === 'pro' ? 4900 : 1900,
        currency: 'USD',
        status: invStatus,
        providerReference: `fac_ref_${this.sequence}`,
        createdAt: sub.createdAt
      };
      repository.invoices.set(invoice.id, invoice);
      if (invStatus === 'succeeded') {
        repository.succeededInvoiceIds.add(invoice.id);
      }
    }

    return { ...sub };
  }

  static seedTrialing(repository: InMemoryRepository, overrides: Partial<Subscription> = {}): Subscription {
    return this.seed(repository, { ...overrides, status: 'trialing' });
  }

  static seedActive(repository: InMemoryRepository, overrides: Partial<Subscription> = {}): Subscription {
    return this.seed(repository, { ...overrides, status: 'active', createInvoice: true, invoiceStatus: 'succeeded' });
  }

  static seedPastDue(repository: InMemoryRepository, overrides: Partial<Subscription> = {}): Subscription {
    return this.seed(repository, { ...overrides, status: 'past_due', createInvoice: true, invoiceStatus: 'failed' });
  }

  static seedCanceled(repository: InMemoryRepository, overrides: Partial<Subscription> = {}): Subscription {
    return this.seed(repository, { ...overrides, status: 'canceled' });
  }
}
