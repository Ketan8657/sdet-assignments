import express, { NextFunction, Request, Response } from 'express';
import { HttpError, SubscriptionService } from '../domain/subscription-service';

export function createApp(service: SubscriptionService): express.Express {
  const app = express();

  // Keep raw bytes/text for HMAC verification before JSON parsing.
  app.post('/webhooks/payment-provider', express.text({ type: 'application/json' }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (typeof req.body !== 'string') throw new HttpError(400, 'Malformed JSON payload');
      const result = await service.processWebhook(req.body, req.header('X-Provider-Signature'));
      res.status(200).json(result);
    } catch (error) { next(error); }
  });

  app.use(express.json());
  app.post('/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
    try { res.status(201).json(await service.createSubscription(req.body)); }
    catch (error) { next(error); }
  });
  app.get('/subscriptions/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      res.status(200).json(service.getSubscription(id));
    } catch (error) { next(error); }
  });
  app.post('/subscriptions/:id/cancel', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      res.status(200).json(service.cancelSubscription(id));
    } catch (error) { next(error); }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) return res.status(error.statusCode).json({ error: error.message });
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
