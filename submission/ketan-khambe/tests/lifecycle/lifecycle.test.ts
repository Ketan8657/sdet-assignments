import { SubscriptionStateMachine, InvalidTransitionError } from '../../src/domain/state-machine';
import { createTestFixture } from '../fixture';
import { WebhookBuilder } from '../../src/builders/webhook-builder';
import { SubscriptionRequestBuilder } from '../../src/builders/subscription-builder';
import { SubscriptionFixtureFactory } from '../../src/factories/subscription-factory';

describe('Subscription lifecycle and state machine', () => {
  const stateMachine = new SubscriptionStateMachine();

  describe('Unit state machine transition rules', () => {
    test.each([
      ['trialing', 'active'],
      ['trialing', 'past_due'],
      ['trialing', 'canceled'],
      ['active', 'past_due'],
      ['active', 'canceled'],
      ['past_due', 'active'],
      ['past_due', 'canceled']
    ] as const)('allows valid transition: %s -> %s', (from, to) => {
      expect(stateMachine.canTransition(from, to)).toBe(true);
      expect(stateMachine.transition(from, to)).toBe(to);
    });

    test.each([
      ['canceled', 'active'],
      ['canceled', 'past_due'],
      ['canceled', 'trialing'],
      ['active', 'trialing'],
      ['past_due', 'trialing']
    ] as const)('rejects illegal transition: %s -> %s with InvalidTransitionError', (from, to) => {
      expect(stateMachine.canTransition(from, to)).toBe(false);
      expect(() => stateMachine.transition(from, to)).toThrow(InvalidTransitionError);
    });

    test('verifies allowed transitions query helper', () => {
      expect(stateMachine.getAllowedTransitions('trialing')).toEqual(['active', 'past_due', 'canceled']);
      expect(stateMachine.getAllowedTransitions('active')).toEqual(['past_due', 'canceled']);
      expect(stateMachine.getAllowedTransitions('past_due')).toEqual(['active', 'canceled']);
      expect(stateMachine.getAllowedTransitions('canceled')).toEqual([]);
    });

    test('verifies terminal state behavior', () => {
      expect(stateMachine.isTerminal('trialing')).toBe(false);
      expect(stateMachine.isTerminal('active')).toBe(false);
      expect(stateMachine.isTerminal('past_due')).toBe(false);
      expect(stateMachine.isTerminal('canceled')).toBe(true);
    });
  });

  describe('End-to-end lifecycle transitions (valid)', () => {
    test('1. trialing -> active: payment success webhook activates trialing subscription', async () => {
      const { api, postWebhook, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().withPlan('pro').build()).expect(201);
      const subId = created.body.id;

      const payload = new WebhookBuilder()
        .forSubscription(subId)
        .forInvoice('inv_trial_active_1')
        .withEventId('evt_trial_active_1')
        .withType('payment.succeeded')
        .build();

      await postWebhook(payload).expect(200, { accepted: true, duplicate: false });

      const updated = repository.getSubscription(subId);
      expect(updated?.status).toBe('active');
      expect(repository.findInvoice('inv_trial_active_1')?.status).toBe('succeeded');

      const audit = repository.getAuditForSubscription(subId);
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({ from: 'trialing', to: 'active', reason: 'payment.succeeded' });
    });

    test('2. trialing -> past_due: payment failure webhook transitions trialing subscription to past_due', async () => {
      const { api, postWebhook, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().withPlan('pro').build()).expect(201);
      const subId = created.body.id;

      const payload = new WebhookBuilder()
        .forSubscription(subId)
        .forInvoice('inv_trial_fail_1')
        .withEventId('evt_trial_fail_1')
        .withType('payment.failed')
        .build();

      await postWebhook(payload).expect(200, { accepted: true, duplicate: false });

      expect(repository.getSubscription(subId)?.status).toBe('past_due');
      expect(repository.findInvoice('inv_trial_fail_1')?.status).toBe('failed');

      const audit = repository.getAuditForSubscription(subId);
      expect(audit[1]).toMatchObject({ from: 'trialing', to: 'past_due', reason: 'payment.failed' });
    });

    test('3. trialing -> canceled: cancellation during trial moves subscription to canceled', async () => {
      const { api, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().withPlan('pro').build()).expect(201);
      const subId = created.body.id;

      const res = await api.post(`/subscriptions/${subId}/cancel`).expect(200);
      expect(res.body.status).toBe('canceled');
      expect(repository.getSubscription(subId)?.status).toBe('canceled');

      const audit = repository.getAuditForSubscription(subId);
      expect(audit[1]).toMatchObject({ from: 'trialing', to: 'canceled', reason: 'customer.cancelled' });
    });

    test('4. active -> past_due: recurring payment failure webhook moves active subscription to past_due', async () => {
      const { postWebhook, repository } = createTestFixture();
      const activeSub = SubscriptionFixtureFactory.seedActive(repository, { id: 'sub_act_pd_1' });

      const payload = new WebhookBuilder()
        .forSubscription(activeSub.id)
        .forInvoice('inv_renewal_failed')
        .withEventId('evt_renewal_failed')
        .withType('payment.failed')
        .build();

      await postWebhook(payload).expect(200, { accepted: true, duplicate: false });

      expect(repository.getSubscription(activeSub.id)?.status).toBe('past_due');
      expect(repository.findInvoice('inv_renewal_failed')?.status).toBe('failed');

      const audit = repository.getAuditForSubscription(activeSub.id);
      const transitionAudit = audit.find(a => a.from === 'active' && a.to === 'past_due');
      expect(transitionAudit).toBeDefined();
      expect(transitionAudit?.reason).toBe('payment.failed');
    });

    test('5. active -> canceled: customer cancels active subscription via API', async () => {
      const { api, repository } = createTestFixture();
      const activeSub = SubscriptionFixtureFactory.seedActive(repository, { id: 'sub_act_can_1' });

      const res = await api.post(`/subscriptions/${activeSub.id}/cancel`).expect(200);
      expect(res.body.status).toBe('canceled');
      expect(repository.getSubscription(activeSub.id)?.status).toBe('canceled');

      const audit = repository.getAuditForSubscription(activeSub.id);
      const cancelAudit = audit.find(a => a.from === 'active' && a.to === 'canceled');
      expect(cancelAudit).toBeDefined();
      expect(cancelAudit?.reason).toBe('customer.cancelled');
    });

    test('6. past_due -> active: successful retry payment webhook restores past_due subscription to active', async () => {
      const { postWebhook, repository } = createTestFixture();
      const pastDueSub = SubscriptionFixtureFactory.seedPastDue(repository, { id: 'sub_pd_act_1' });

      const payload = new WebhookBuilder()
        .forSubscription(pastDueSub.id)
        .forInvoice('inv_retry_success')
        .withEventId('evt_retry_success')
        .withType('payment.succeeded')
        .build();

      await postWebhook(payload).expect(200, { accepted: true, duplicate: false });

      expect(repository.getSubscription(pastDueSub.id)?.status).toBe('active');
      expect(repository.findInvoice('inv_retry_success')?.status).toBe('succeeded');

      const audit = repository.getAuditForSubscription(pastDueSub.id);
      const restoreAudit = audit.find(a => a.from === 'past_due' && a.to === 'active');
      expect(restoreAudit).toBeDefined();
      expect(restoreAudit?.reason).toBe('payment.succeeded');
    });

    test('7. past_due -> canceled: retries exhausted / customer cancel moves past_due subscription to canceled', async () => {
      const { api, repository } = createTestFixture();
      const pastDueSub = SubscriptionFixtureFactory.seedPastDue(repository, { id: 'sub_pd_can_1' });

      const res = await api.post(`/subscriptions/${pastDueSub.id}/cancel`).expect(200);
      expect(res.body.status).toBe('canceled');
      expect(repository.getSubscription(pastDueSub.id)?.status).toBe('canceled');

      const audit = repository.getAuditForSubscription(pastDueSub.id);
      const cancelAudit = audit.find(a => a.from === 'past_due' && a.to === 'canceled');
      expect(cancelAudit).toBeDefined();
      expect(cancelAudit?.reason).toBe('customer.cancelled');
    });
  });

  describe('Invalid lifecycle transition prevention via API and webhooks', () => {
    test('canceled -> active: payment success webhook cannot reactivate a canceled subscription', async () => {
      const { postWebhook, repository } = createTestFixture();
      const canceledSub = SubscriptionFixtureFactory.seedCanceled(repository, { id: 'sub_can_act_1' });

      const payload = new WebhookBuilder()
        .forSubscription(canceledSub.id)
        .forInvoice('inv_attempt_reactivate')
        .withEventId('evt_attempt_reactivate')
        .withType('payment.succeeded')
        .build();

      await postWebhook(payload).expect(200, { accepted: true, duplicate: false });

      expect(repository.getSubscription(canceledSub.id)?.status).toBe('canceled');
      expect(repository.findInvoice('inv_attempt_reactivate')).toBeUndefined();

      const events = repository.getEventsForSubscription(canceledSub.id);
      expect(events[0]?.ignoredReason).toBe('subscription_canceled');
    });

    test('canceled -> past_due: payment failure webhook cannot transition a canceled subscription', async () => {
      const { postWebhook, repository } = createTestFixture();
      const canceledSub = SubscriptionFixtureFactory.seedCanceled(repository, { id: 'sub_can_pd_1' });

      const payload = new WebhookBuilder()
        .forSubscription(canceledSub.id)
        .forInvoice('inv_attempt_fail')
        .withEventId('evt_attempt_fail')
        .withType('payment.failed')
        .build();

      await postWebhook(payload).expect(200, { accepted: true, duplicate: false });

      expect(repository.getSubscription(canceledSub.id)?.status).toBe('canceled');
      const events = repository.getEventsForSubscription(canceledSub.id);
      expect(events[0]?.ignoredReason).toBe('subscription_canceled');
    });

    test('canceled -> canceled: cancel endpoint rejects redundant cancellation with 409', async () => {
      const { api, repository } = createTestFixture();
      const canceledSub = SubscriptionFixtureFactory.seedCanceled(repository);

      await api.post(`/subscriptions/${canceledSub.id}/cancel`).expect(409, { error: 'Subscription is already canceled' });
      expect(repository.getSubscription(canceledSub.id)?.status).toBe('canceled');
    });
  });
});
