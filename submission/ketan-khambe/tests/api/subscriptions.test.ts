import { createTestFixture } from '../fixture';
import { SubscriptionRequestBuilder } from '../../src/builders/subscription-builder';
import { SubscriptionFixtureFactory } from '../../src/factories/subscription-factory';

describe('Subscription API', () => {
  describe('POST /subscriptions', () => {
    test('creates a pro subscription in trialing state and persists it', async () => {
      const { api, repository, provider } = createTestFixture();
      const payload = new SubscriptionRequestBuilder().withPlan('pro').build();
      const response = await api.post('/subscriptions').send(payload).expect(201);

      expect(response.body).toMatchObject({
        id: expect.stringMatching(/^sub_\d+$/),
        customerId: 'cust_001',
        plan: 'pro',
        paymentMethodId: 'pm_test_visa_4242',
        status: 'trialing',
        createdAt: expect.any(String),
        updatedAt: expect.any(String)
      });

      const persisted = repository.getSubscription(response.body.id);
      expect(persisted).toBeDefined();
      expect(persisted?.status).toBe('trialing');
      expect(persisted?.customerId).toBe('cust_001');

      // Pro trial does not charge provider immediately
      expect(provider.getCallCount()).toBe(0);

      // Audit trail should record creation
      const audit = repository.getAuditForSubscription(response.body.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        from: null,
        to: 'trialing',
        reason: 'subscription.created'
      });
    });

    test('creates a basic subscription with upfront charge becoming active', async () => {
      const { api, repository, provider } = createTestFixture();
      const payload = new SubscriptionRequestBuilder()
        .forCustomer('cust_basic_api')
        .withPlan('basic')
        .withPaymentMethod('pm_visa_basic')
        .build();

      const response = await api.post('/subscriptions').send(payload).expect(201);
      expect(response.body.status).toBe('active');
      expect(response.body.plan).toBe('basic');

      expect(provider.getCallCount()).toBe(1);
      expect(provider.getLastCall()).toMatchObject({
        customerId: 'cust_basic_api',
        paymentMethodId: 'pm_visa_basic',
        amount: 1900,
        currency: 'USD',
        idempotencyKey: `initial-${response.body.id}`
      });

      const invoices = repository.getInvoicesForSubscription(response.body.id);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        amount: 1900,
        currency: 'USD',
        status: 'succeeded'
      });
    });

    test('rejects unknown plan without persisting or charging', async () => {
      const { api, repository, provider } = createTestFixture();
      const payload = new SubscriptionRequestBuilder().withInvalidPlan('enterprise_gold').buildRaw();
      const response = await api.post('/subscriptions').send(payload).expect(400);

      expect(response.body).toEqual({ error: 'Unknown plan' });
      expect(repository.getSubscriptionCount()).toBe(0);
      expect(provider.getCallCount()).toBe(0);
    });

    test('rejects missing customer_id', async () => {
      const { api, repository, provider } = createTestFixture();
      const payload = new SubscriptionRequestBuilder().withoutCustomerId().buildRaw();
      const response = await api.post('/subscriptions').send(payload).expect(400);

      expect(response.body).toEqual({ error: 'customer_id is required' });
      expect(repository.getSubscriptionCount()).toBe(0);
      expect(provider.getCallCount()).toBe(0);
    });

    test('rejects whitespace-only customer_id', async () => {
      const { api, repository, provider } = createTestFixture();
      const payload = new SubscriptionRequestBuilder().withWhitespaceCustomerId().buildRaw();
      const response = await api.post('/subscriptions').send(payload).expect(400);

      expect(response.body).toEqual({ error: 'customer_id is required' });
      expect(repository.getSubscriptionCount()).toBe(0);
      expect(provider.getCallCount()).toBe(0);
    });

    test('rejects missing payment_method_id', async () => {
      const { api, repository, provider } = createTestFixture();
      const payload = new SubscriptionRequestBuilder().withoutPaymentMethod().buildRaw();
      const response = await api.post('/subscriptions').send(payload).expect(400);

      expect(response.body).toEqual({ error: 'payment_method_id is required' });
      expect(repository.getSubscriptionCount()).toBe(0);
      expect(provider.getCallCount()).toBe(0);
    });

    test('rejects whitespace-only payment_method_id', async () => {
      const { api, repository, provider } = createTestFixture();
      const payload = new SubscriptionRequestBuilder().withWhitespacePaymentMethod().buildRaw();
      const response = await api.post('/subscriptions').send(payload).expect(400);

      expect(response.body).toEqual({ error: 'payment_method_id is required' });
      expect(repository.getSubscriptionCount()).toBe(0);
      expect(provider.getCallCount()).toBe(0);
    });

    test('rejects missing request body or invalid json structure', async () => {
      const { api, repository } = createTestFixture();
      await api.post('/subscriptions').set('Content-Type', 'application/json').send('').expect(400);
      expect(repository.getSubscriptionCount()).toBe(0);
    });
  });

  describe('GET /subscriptions/:id', () => {
    test('retrieves an existing subscription with correct attributes', async () => {
      const { api, repository } = createTestFixture();
      const sub = SubscriptionFixtureFactory.seedActive(repository, { id: 'sub_get_1', customerId: 'cust_get_1' });

      const response = await api.get(`/subscriptions/${sub.id}`).expect(200);
      expect(response.body).toEqual({
        id: 'sub_get_1',
        customerId: 'cust_get_1',
        plan: 'pro',
        paymentMethodId: sub.paymentMethodId,
        status: 'active',
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt
      });
    });

    test('returns 404 for unknown subscription', async () => {
      const { api } = createTestFixture();
      const response = await api.get('/subscriptions/sub_does_not_exist').expect(404);
      expect(response.body).toEqual({ error: 'Subscription not found' });
    });
  });

  describe('POST /subscriptions/:id/cancel', () => {
    test('cancels a trialing subscription and updates audit trail', async () => {
      const { api, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().withPlan('pro').build()).expect(201);

      const cancelRes = await api.post(`/subscriptions/${created.body.id}/cancel`).expect(200);
      expect(cancelRes.body.status).toBe('canceled');

      const persisted = repository.getSubscription(created.body.id);
      expect(persisted?.status).toBe('canceled');

      const audit = repository.getAuditForSubscription(created.body.id);
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({
        from: 'trialing',
        to: 'canceled',
        reason: 'customer.cancelled'
      });
    });

    test('cancels an active subscription', async () => {
      const { api, repository } = createTestFixture();
      const sub = SubscriptionFixtureFactory.seedActive(repository);

      const response = await api.post(`/subscriptions/${sub.id}/cancel`).expect(200);
      expect(response.body.status).toBe('canceled');
      expect(repository.getSubscription(sub.id)?.status).toBe('canceled');

      const audit = repository.getAuditForSubscription(sub.id);
      const cancelAudit = audit.find(a => a.to === 'canceled');
      expect(cancelAudit).toMatchObject({
        from: 'active',
        to: 'canceled',
        reason: 'customer.cancelled'
      });
    });

    test('cancels a past_due subscription', async () => {
      const { api, repository } = createTestFixture();
      const sub = SubscriptionFixtureFactory.seedPastDue(repository);

      const response = await api.post(`/subscriptions/${sub.id}/cancel`).expect(200);
      expect(response.body.status).toBe('canceled');
      expect(repository.getSubscription(sub.id)?.status).toBe('canceled');

      const audit = repository.getAuditForSubscription(sub.id);
      const cancelAudit = audit.find(a => a.to === 'canceled');
      expect(cancelAudit).toMatchObject({
        from: 'past_due',
        to: 'canceled',
        reason: 'customer.cancelled'
      });
    });

    test('rejects repeated cancellation with 409 Conflict', async () => {
      const { api, repository } = createTestFixture();
      const sub = SubscriptionFixtureFactory.seedCanceled(repository);

      const response = await api.post(`/subscriptions/${sub.id}/cancel`).expect(409);
      expect(response.body).toEqual({ error: 'Subscription is already canceled' });
    });

    test('returns 404 when canceling non-existent subscription', async () => {
      const { api } = createTestFixture();
      const response = await api.post('/subscriptions/sub_non_existent/cancel').expect(404);
      expect(response.body).toEqual({ error: 'Subscription not found' });
    });
  });
});
