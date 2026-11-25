const scale = 1_000_000n;

function decimal(value) {
  const match = String(value ?? '').match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const [,sign, whole, fraction = ''] = match;
  const absolute = BigInt(whole) * scale + BigInt(fraction.slice(0,6).padEnd(6,'0'));
  return sign ? -absolute : absolute;
}

export function commissionAmount(purchase, rate) {
  if (purchase.status !== 'Cargado') return 0n;
  const weight = purchase.weightMode === 'fixed'
    ? decimal(purchase.boxes) * decimal(purchase.kgPerBox)
    : decimal(purchase.kg) * scale;
  return weight * decimal(rate);
}

export function commissionEuros(amount) {
  const cent = scale ** 3n / 100n;
  const rounded = amount < 0n ? (amount - cent / 2n) / cent : (amount + cent / 2n) / cent;
  return Number(rounded) / 100;
}

export function commissionPeriod(day, kind) {
  const start = new Date(day + 'T12:00:00Z');
  if (kind === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (kind === 'month' || kind === 'year') start.setUTCDate(1);
  if (kind === 'year') start.setUTCMonth(0);
  return start.toISOString().slice(0,10);
}
