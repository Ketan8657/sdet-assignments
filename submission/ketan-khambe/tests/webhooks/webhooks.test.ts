import { createTestFixture } from '../fixture';
import { SubscriptionRequestBuilder } from '../../src/builders/subscription-builder';
import { WebhookBuilder } from '../../src/builders/webhook-builder';
import { SubscriptionFixtureFactory } from '../../src/factories/subscription-factory';

describe('Payment Provider Webhook Validation', () => {
  describe('HMAC Signature Verification', () => {
    test('accepts valid HMAC signature', async () => {
      const { api, postWebhook, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().build()).expect(201);
      const payload = new WebhookBuilder().forSubscription(created.body.id).build();

      const response = await postWebhook(payload).expect(200);
      expect(response.body).toEqual({ accepted: true, duplicate: false });
      expect(repository.hasProcessedEvent(payload.event_id)).toBe(true);
    });

    test('rejects missing X-Provider-Signature header with 401', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().build();

      const response = await postWebhook(payload, { omitSignature: true }).expect(401);
      expect(response.body).toEqual({ error: 'Invalid webhook signature' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects invalid or malformed hex signature with 401', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().build();

      const response = await postWebhook(payload, { signature: '00bad_hex_signature' }).expect(401);
      expect(response.body).toEqual({ error: 'Invalid webhook signature' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects tampered signature of correct length with 401', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().build();
      // 64-char hex string (sha256 digest length) with invalid content
      const fakeSignature = 'a'.repeat(64);

      const response = await postWebhook(payload, { signature: fakeSignature }).expect(401);
      expect(response.body).toEqual({ error: 'Invalid webhook signature' });
      expect(repository.webhookEvents).toHaveLength(0);
    });
  });

  describe('Payload & Schema Validation', () => {
    test('rejects malformed raw JSON with 400', async () => {
      const { api, service, repository } = createTestFixture();
      const malformedJson = '{ invalid_json: ';
      const signature = service.signWebhook(malformedJson);

      const response = await api.post('/webhooks/payment-provider')
        .set('Content-Type', 'application/json')
        .set('X-Provider-Signature', signature)
        .send(malformedJson)
        .expect(400);

      expect(response.body).toEqual({ error: 'Malformed JSON payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects missing event_id with 400', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().withoutField('event_id').buildRaw();

      const response = await postWebhook(payload).expect(400);
      expect(response.body).toEqual({ error: 'Invalid webhook payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects missing subscription_id with 400', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().withoutField('subscription_id').buildRaw();

      const response = await postWebhook(payload).expect(400);
      expect(response.body).toEqual({ error: 'Invalid webhook payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects missing invoice_id with 400', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().withoutField('invoice_id').buildRaw();

      const response = await postWebhook(payload).expect(400);
      expect(response.body).toEqual({ error: 'Invalid webhook payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects negative amount with 400', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().withAmount(-500).buildRaw();

      const response = await postWebhook(payload).expect(400);
      expect(response.body).toEqual({ error: 'Invalid webhook payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects non-numeric amount with 400', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().withCustomProperty('amount', 'not-a-number').buildRaw();

      const response = await postWebhook(payload).expect(400);
      expect(response.body).toEqual({ error: 'Invalid webhook payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects unsupported currency with 400', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().withCurrency('EUR').buildRaw();

      const response = await postWebhook(payload).expect(400);
      expect(response.body).toEqual({ error: 'Invalid webhook payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('rejects unsupported webhook event type with 400', async () => {
      const { postWebhook, repository } = createTestFixture();
      const payload = new WebhookBuilder().withInvalidType('payment.chargeback_opened').buildRaw();

      const response = await postWebhook(payload).expect(400);
      expect(response.body).toEqual({ error: 'Invalid webhook payload' });
      expect(repository.webhookEvents).toHaveLength(0);
    });

    test('returns 404 when webhook references a non-existent subscription', async () => {
      const { postWebhook } = createTestFixture();
      const payload = new WebhookBuilder().forSubscription('sub_does_not_exist_404').build();

      const response = await postWebhook(payload).expect(404);
      expect(response.body).toEqual({ error: 'Subscription not found' });
    });
  });

  describe('Duplicate & Idempotency Handling', () => {
    test('duplicate event ID is idempotent and produces no duplicate invoices or extra status transitions', async () => {
      const { api, postWebhook, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().build()).expect(201);
      const subId = created.body.id;

      const payload = new WebhookBuilder()
        .forSubscription(subId)
        .forInvoice('inv_duplicate_check')
        .withEventId('evt_idempotency_1')
        .build();

      // First delivery: accepted
      const res1 = await postWebhook(payload).expect(200);
      expect(res1.body).toEqual({ accepted: true, duplicate: false });

      // Second delivery: idempotent duplicate
      const res2 = await postWebhook(payload).expect(200);
      expect(res2.body).toEqual({ accepted: true, duplicate: true });

      // Verify repository integrity
      expect(repository.invoices.size).toBe(1);
      const eventDeliveries = repository.webhookEvents.filter(e => e.eventId === 'evt_idempotency_1');
      expect(eventDeliveries).toHaveLength(2);
      expect(eventDeliveries[0].duplicate).toBe(false);
      expect(eventDeliveries[1].duplicate).toBe(true);
      expect(eventDeliveries[1].ignoredReason).toBe('duplicate_event_id');

      // Verify no duplicate audit transition
      const activeAudits = repository.getAuditForSubscription(subId).filter(e => e.to === 'active');
      expect(activeAudits).toHaveLength(1);
    });
  });

  describe('Out-of-Order & Stale Event Handling', () => {
    test('stale payment.failed arriving after payment.succeeded for same invoice is ignored', async () => {
      const { api, postWebhook, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().build()).expect(201);
      const subId = created.body.id;

      const success = new WebhookBuilder()
        .forSubscription(subId)
        .forInvoice('inv_ordering_1')
        .withEventId('evt_success_first')
        .withType('payment.succeeded')
        .build();

      const staleFailure = new WebhookBuilder()
        .forSubscription(subId)
        .forInvoice('inv_ordering_1')
        .withEventId('evt_failure_stale')
        .withType('payment.failed')
        .build();

      await postWebhook(success).expect(200, { accepted: true, duplicate: false });
      await postWebhook(staleFailure).expect(200, { accepted: true, duplicate: false });

      // Subscription remains active
      expect(repository.getSubscription(subId)?.status).toBe('active');
      // Invoice remains succeeded
      expect(repository.findInvoice('inv_ordering_1')?.status).toBe('succeeded');

      const failedDelivery = repository.webhookEvents.find(e => e.eventId === 'evt_failure_stale');
      expect(failedDelivery?.ignoredReason).toBe('stale_failure_after_success');
    });

    test('duplicate success webhook for already-succeeded invoice with different event ID is ignored', async () => {
      const { api, postWebhook, repository } = createTestFixture();
      const created = await api.post('/subscriptions').send(new SubscriptionRequestBuilder().build()).expect(201);
      const subId = created.body.id;

      const success1 = new WebhookBuilder()
        .forSubscription(subId)
        .forInvoice('inv_same_inv_diff_evt')
        .withEventId('evt_success_1')
        .withType('payment.succeeded')
        .build();

      const success2 = new WebhookBuilder()
        .forSubscription(subId)
        .forInvoice('inv_same_inv_diff_evt')
        .withEventId('evt_success_2')
        .withType('payment.succeeded')
        .build();

      await postWebhook(success1).expect(200, { accepted: true, duplicate: false });
      await postWebhook(success2).expect(200, { accepted: true, duplicate: false });

      const secondDelivery = repository.webhookEvents.find(e => e.eventId === 'evt_success_2');
      expect(secondDelivery?.ignoredReason).toBe('invoice_already_succeeded');
      expect(repository.invoices.size).toBe(1);
    });

    test('webhooks arriving for canceled subscriptions are safely ignored', async () => {
      const { repository, postWebhook } = createTestFixture();
      const sub = SubscriptionFixtureFactory.seedCanceled(repository, { id: 'sub_already_canceled' });

      const webhook = new WebhookBuilder()
        .forSubscription(sub.id)
        .forInvoice('inv_on_canceled')
        .withEventId('evt_on_canceled')
        .withType('payment.succeeded')
        .build();

      await postWebhook(webhook).expect(200, { accepted: true, duplicate: false });

      expect(repository.getSubscription(sub.id)?.status).toBe('canceled');
      expect(repository.findInvoice('inv_on_canceled')).toBeUndefined();

      const delivery = repository.webhookEvents.find(e => e.eventId === 'evt_on_canceled');
      expect(delivery?.ignoredReason).toBe('subscription_canceled');
    });
  });

  describe('Refund Webhooks', () => {
    test('updates existing invoice to refunded status without changing subscription status', async () => {
      const { repository, postWebhook } = createTestFixture();
      const sub = SubscriptionFixtureFactory.seedActive(repository, { id: 'sub_refund_test' });

      const successWebhook = new WebhookBuilder()
        .forSubscription(sub.id)
        .forInvoice('inv_to_refund')
        .withEventId('evt_charge_to_refund')
        .withType('payment.succeeded')
        .build();

      await postWebhook(successWebhook).expect(200);
      expect(repository.findInvoice('inv_to_refund')?.status).toBe('succeeded');

      const refundWebhook = new WebhookBuilder()
        .forSubscription(sub.id)
        .forInvoice('inv_to_refund')
        .withEventId('evt_refund_processed')
        .withType('payment.refunded')
        .build();

      await postWebhook(refundWebhook).expect(200);

      const refundedInvoice = repository.findInvoice('inv_to_refund');
      expect(refundedInvoice?.status).toBe('refunded');
      expect(repository.getSubscription(sub.id)?.status).toBe('active');
    });

    test('ignores refund webhook if referenced invoice does not exist', async () => {
      const { repository, postWebhook } = createTestFixture();
      const sub = SubscriptionFixtureFactory.seedActive(repository, { id: 'sub_orphan_refund' });

      const orphanRefund = new WebhookBuilder()
        .forSubscription(sub.id)
        .forInvoice('inv_non_existent')
        .withEventId('evt_orphan_refund')
        .withType('payment.refunded')
        .build();

      await postWebhook(orphanRefund).expect(200);

      const delivery = repository.webhookEvents.find(e => e.eventId === 'evt_orphan_refund');
      expect(delivery?.ignoredReason).toBe('refund_without_invoice');
    });
  });
});
