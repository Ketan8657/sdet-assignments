import { CreateSubscriptionRequest } from '../domain/types';

export class SubscriptionRequestBuilder {
  private request: Record<string, unknown> = {
    customer_id: 'cust_001',
    plan: 'pro',
    payment_method_id: 'pm_test_visa_4242'
  };

  forCustomer(customerId: string): this {
    this.request.customer_id = customerId;
    return this;
  }

  withPlan(plan: string): this {
    this.request.plan = plan;
    return this;
  }

  withPaymentMethod(paymentMethodId: string): this {
    this.request.payment_method_id = paymentMethodId;
    return this;
  }

  withoutCustomerId(): this {
    delete this.request.customer_id;
    return this;
  }

  withoutPaymentMethod(): this {
    delete this.request.payment_method_id;
    return this;
  }

  withoutPlan(): this {
    delete this.request.plan;
    return this;
  }

  withWhitespaceCustomerId(): this {
    this.request.customer_id = '   ';
    return this;
  }

  withWhitespacePaymentMethod(): this {
    this.request.payment_method_id = '   ';
    return this;
  }

  withInvalidPlan(plan = 'enterprise_super'): this {
    this.request.plan = plan;
    return this;
  }

  build(): CreateSubscriptionRequest {
    return { ...(this.request as unknown as CreateSubscriptionRequest) };
  }

  buildRaw(): Record<string, unknown> {
    return { ...this.request };
  }
}
