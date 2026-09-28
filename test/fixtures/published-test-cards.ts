// Card numbers published by payment providers for testing. These are the only
// card numbers allowed in files in this repo (CLAUDE.md rule 4). Checked
// against the sources on 2026-09-28.

export interface PublishedCard {
  readonly number: string;
  readonly brand: string;
  readonly source: 'stripe' | 'braintree' | 'razorpay';
}

// https://docs.stripe.com/testing ("Cards by brand")
const stripe: PublishedCard[] = [
  { number: '4242424242424242', brand: 'Visa' },
  { number: '4000056655665556', brand: 'Visa (debit)' },
  { number: '5555555555554444', brand: 'Mastercard' },
  { number: '2223003122003222', brand: 'Mastercard (2-series)' },
  { number: '5200828282828210', brand: 'Mastercard (debit)' },
  { number: '5105105105105100', brand: 'Mastercard (prepaid)' },
  { number: '378282246310005', brand: 'American Express' },
  { number: '371449635398431', brand: 'American Express' },
  { number: '6011111111111117', brand: 'Discover' },
  { number: '6011000990139424', brand: 'Discover' },
  { number: '6011981111111113', brand: 'Discover (debit)' },
  { number: '3056930009020004', brand: 'Diners Club' },
  { number: '36227206271667', brand: 'Diners Club (14-digit)' },
  { number: '3566002020360505', brand: 'JCB' },
  { number: '6200000000000005', brand: 'UnionPay' },
  { number: '6200000000000047', brand: 'UnionPay (debit)' },
  { number: '6205500000000000004', brand: 'UnionPay (19-digit)' },
].map((c) => ({ ...c, source: 'stripe' as const }));

// https://developer.paypal.com/braintree/docs/reference/general/testing/node
const braintree: PublishedCard[] = [
  { number: '4111111111111111', brand: 'Visa' },
  { number: '4012888888881881', brand: 'Visa' },
  { number: '3530111333300000', brand: 'JCB' },
  { number: '36259600000004', brand: 'Diners Club' },
].map((c) => ({ ...c, source: 'braintree' as const }));

// https://razorpay.com/docs/payments/payments/test-card-details/ (domestic)
const razorpay: PublishedCard[] = [
  { number: '4100280000001007', brand: 'Visa (debit)' },
  { number: '5555510000081006', brand: 'Mastercard' },
  { number: '6527658900001005', brand: 'RuPay' },
  { number: '340256000401007', brand: 'American Express' },
  { number: '36082800091007', brand: 'Diners Club' },
].map((c) => ({ ...c, source: 'razorpay' as const }));

export const PUBLISHED_TEST_CARDS: readonly PublishedCard[] = [
  ...stripe,
  ...braintree,
  ...razorpay,
];
