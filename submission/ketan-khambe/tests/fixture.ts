import request from 'supertest';
import { createApp } from '../src/http/app';
import { SubscriptionService } from '../src/domain/subscription-service';
import { InMemoryRepository } from '../src/repositories/in-memory-repository';
import { FakePaymentProvider } from '../src/providers/fake-payment-provider';

export function createTestFixture() {
  const repository = new InMemoryRepository();
  const provider = new FakePaymentProvider();
  const service = new SubscriptionService(repository, provider, 'test-webhook-secret');
  const app = createApp(service);
  const api = request(app);

  const postWebhook = (
    payload: object | string,
    options?: { signature?: string; omitSignature?: boolean }
  ) => {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = api.post('/webhooks/payment-provider').set('Content-Type', 'application/json');
    if (!options?.omitSignature) {
      req.set('X-Provider-Signature', options?.signature ?? service.signWebhook(raw));
    }
    return req.send(raw);
  };

  return { repository, provider, service, app, api, postWebhook };
}
