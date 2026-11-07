// All money is stored as integer cents, so totals never pick up float errors.

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** True when the number has no more than two decimal places. */
export function hasAtMostTwoDecimals(amount: number): boolean {
  return Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
}

/** PayPal wants amounts as strings with two decimals, e.g. "2400.00". */
export function centsToPayPal(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function payPalToCents(value: string): number {
  return Math.round(Number.parseFloat(value) * 100);
}

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${SYMBOLS[currency] ?? `${currency} `}${amount}`;
}

export function lineTotalCents(quantity: number, unitCents: number): number {
  return Math.round(quantity * unitCents);
}
