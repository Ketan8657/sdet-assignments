import { PaymentChargeRequest, PaymentChargeResult, PaymentOutcome, PaymentProvider } from '../domain/types';

export class FakePaymentProvider implements PaymentProvider {
  readonly calls: PaymentChargeRequest[] = [];
  private outcomeQueue: PaymentOutcome[] = [];
  private defaultOutcome: PaymentOutcome = 'success';

  /**
   * Sets the immediate next outcome for the subsequent charge call.
   */
  setNextOutcome(outcome: PaymentOutcome): void {
    this.outcomeQueue = [outcome];
  }

  /**
   * Queues a sequence of outcomes for consecutive charge calls.
   */
  setOutcomes(outcomes: PaymentOutcome[]): void {
    this.outcomeQueue = [...outcomes];
  }

  /**
   * Configures the fallback outcome used when the outcome queue is empty.
   */
  setDefaultOutcome(outcome: PaymentOutcome): void {
    this.defaultOutcome = outcome;
  }

  async charge(request: PaymentChargeRequest): Promise<PaymentChargeResult> {
    if (!request.customerId) throw new Error('FakePaymentProvider: customerId is required');
    if (!request.paymentMethodId) throw new Error('FakePaymentProvider: paymentMethodId is required');
    if (request.amount <= 0) throw new Error('FakePaymentProvider: amount must be positive');
    if (!request.idempotencyKey) throw new Error('FakePaymentProvider: idempotencyKey is required');

    this.calls.push({ ...request });

    const outcome = this.outcomeQueue.shift() ?? this.defaultOutcome;
    if (outcome === 'timeout') {
      throw new Error('Payment provider timeout');
    }
    return { outcome, providerReference: `mock_${request.idempotencyKey}` };
  }

  getCallCount(): number {
    return this.calls.length;
  }

  getLastCall(): PaymentChargeRequest | undefined {
    return this.calls[this.calls.length - 1];
  }

  getCallsForCustomer(customerId: string): PaymentChargeRequest[] {
    return this.calls.filter(call => call.customerId === customerId);
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  reset(): void {
    this.clearCalls();
    this.outcomeQueue = [];
    this.defaultOutcome = 'success';
  }
}

