import { createTestFixture } from '../fixture';
import { SubscriptionRequestBuilder } from '../../src/builders/subscription-builder';

describe('Payment provider and persistence integration', () => {
  test('basic plan charges provider once with exact amount, currency, and idempotency key', async () => {
    const { api, provider, repository } = createTestFixture();
    const payload = new SubscriptionRequestBuilder()
      .forCustomer('cust_persist_1')
      .withPlan('basic')
      .withPaymentMethod('pm_card_persist_1')
      .build();

    const response = await api.post('/subscriptions').send(payload).expect(201);
    const subId = response.body.id;

    // Verify Provider Call count and exact arguments
    expect(provider.getCallCount()).toBe(1);
    const lastCall = provider.getLastCall();
    expect(lastCall).toEqual({
      customerId: 'cust_persist_1',
      paymentMethodId: 'pm_card_persist_1',
      amount: 1900,
      currency: 'USD',
      idempotencyKey: `initial-${subId}`
    });

    // Verify Subscription persistence
    const subscription = repository.getSubscription(subId);
    expect(subscription).toBeDefined();
    expect(subscription?.status).toBe('active');
    expect(subscription?.plan).toBe('basic');
    expect(subscription?.customerId).toBe('cust_persist_1');
    expect(subscription?.paymentMethodId).toBe('pm_card_persist_1');

    // Verify Invoice persistence
    const invoices = repository.getInvoicesForSubscription(subId);
    expect(invoices).toHaveLength(1);
    const [invoice] = invoices;
    expect(invoice).toMatchObject({
      subscriptionId: subId,
      amount: 1900,
      currency: 'USD',
      status: 'succeeded',
      providerReference: `mock_initial-${subId}`
    });
    expect(invoice.id).toMatch(/^inv_\d+$/);
    expect(Date.parse(invoice.createdAt)).not.toBeNaN();

    // Verify Audit log trail
    const auditEvents = repository.getAuditForSubscription(subId);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]).toMatchObject({
      subscriptionId: subId,
      from: null,
      to: 'trialing',
      reason: 'subscription.created'
    });
    expect(auditEvents[1]).toMatchObject({
      subscriptionId: subId,
      from: 'trialing',
      to: 'active',
      reason: 'initial_payment.succeeded'
    });
  });

  test('declined initial payment transitions to past_due and records failed invoice with audit trail', async () => {
    const { api, provider, repository } = createTestFixture();
    provider.setNextOutcome('decline');

    const payload = new SubscriptionRequestBuilder()
      .forCustomer('cust_decline_1')
      .withPlan('basic')
      .withPaymentMethod('pm_card_decline')
      .build();

    const response = await api.post('/subscriptions').send(payload).expect(201);
    const subId = response.body.id;

    expect(response.body.status).toBe('past_due');
    expect(provider.getCallCount()).toBe(1);
    expect(provider.getLastCall()?.customerId).toBe('cust_decline_1');

    // Database verification
    const subscription = repository.getSubscription(subId);
    expect(subscription?.status).toBe('past_due');

    const invoices = repository.getInvoicesForSubscription(subId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      subscriptionId: subId,
      amount: 1900,
      currency: 'USD',
      status: 'failed',
      providerReference: `mock_initial-${subId}`
    });

    const audit = repository.getAuditForSubscription(subId);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      from: 'trialing',
      to: 'past_due',
      reason: 'initial_payment.failed'
    });
  });

  test('provider timeout is caught, records past_due status, failed invoice, and audit log', async () => {
    const { api, provider, repository } = createTestFixture();
    provider.setNextOutcome('timeout');

    const payload = new SubscriptionRequestBuilder()
      .forCustomer('cust_timeout_1')
      .withPlan('basic')
      .withPaymentMethod('pm_card_timeout')
      .build();

    const response = await api.post('/subscriptions').send(payload).expect(201);
    const subId = response.body.id;

    expect(response.body.status).toBe('past_due');
    expect(provider.getCallCount()).toBe(1);

    const subscription = repository.getSubscription(subId);
    expect(subscription?.status).toBe('past_due');

    const invoices = repository.getInvoicesForSubscription(subId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      subscriptionId: subId,
      amount: 1900,
      currency: 'USD',
      status: 'failed',
      providerReference: `timeout-${subId}`
    });

    const audit = repository.getAuditForSubscription(subId);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      from: 'trialing',
      to: 'past_due',
      reason: 'initial_payment.timeout'
    });
  });

  test('sequential requests respect provider outcome queue for multiple customers', async () => {
    const { api, provider, repository } = createTestFixture();
    provider.setOutcomes(['decline', 'success']);

    // First customer: decline
    const res1 = await api.post('/subscriptions').send(
      new SubscriptionRequestBuilder().forCustomer('cust_seq_1').withPlan('basic').build()
    ).expect(201);
    expect(res1.body.status).toBe('past_due');

    // Second customer: success
    const res2 = await api.post('/subscriptions').send(
      new SubscriptionRequestBuilder().forCustomer('cust_seq_2').withPlan('basic').build()
    ).expect(201);
    expect(res2.body.status).toBe('active');

    expect(provider.getCallCount()).toBe(2);
    expect(repository.getInvoicesForSubscription(res1.body.id)[0].status).toBe('failed');
    expect(repository.getInvoicesForSubscription(res2.body.id)[0].status).toBe('succeeded');
  });

  test('pro plan creation does not charge payment provider or persist immediate invoice', async () => {
    const { api, provider, repository } = createTestFixture();
    const payload = new SubscriptionRequestBuilder().withPlan('pro').build();

    const response = await api.post('/subscriptions').send(payload).expect(201);
    const subId = response.body.id;

    expect(response.body.status).toBe('trialing');
    expect(provider.getCallCount()).toBe(0);
    expect(repository.getInvoicesForSubscription(subId)).toHaveLength(0);

    const audit = repository.getAuditForSubscription(subId);
    expect(audit).toHaveLength(1);
    expect(audit[0].reason).toBe('subscription.created');
  });

  test('persisted database state exactly matches GET API response', async () => {
    const { api, repository } = createTestFixture();
    const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().build()).expect(201);
    const fetched = await api.get(`/subscriptions/${created.body.id}`).expect(200);

    const stored = repository.getSubscription(created.body.id);
    expect(stored).toEqual(fetched.body);
  });

  test('FakePaymentProvider validates input arguments and supports call querying/reset', async () => {
    const { provider } = createTestFixture();

    // Positive amount validation
    await expect(provider.charge({
      customerId: 'cust_1',
      paymentMethodId: 'pm_1',
      amount: 0,
      currency: 'USD',
      idempotencyKey: 'idem_1'
    })).rejects.toThrow('FakePaymentProvider: amount must be positive');

    // Required customerId
    await expect(provider.charge({
      customerId: '',
      paymentMethodId: 'pm_1',
      amount: 1000,
      currency: 'USD',
      idempotencyKey: 'idem_1'
    })).rejects.toThrow('FakePaymentProvider: customerId is required');

    // Query calls by customer and verify reset
    await provider.charge({
      customerId: 'cust_spec',
      paymentMethodId: 'pm_spec',
      amount: 1900,
      currency: 'USD',
      idempotencyKey: 'idem_spec_1'
    });
    expect(provider.getCallsForCustomer('cust_spec')).toHaveLength(1);
    expect(provider.getCallsForCustomer('other_cust')).toHaveLength(0);

    provider.reset();
    expect(provider.getCallCount()).toBe(0);
    expect(provider.getLastCall()).toBeUndefined();
  });
});
