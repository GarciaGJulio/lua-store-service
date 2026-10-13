/** Amounts are allocated in cents so successive partial returns close exactly. */
export function returnLineAmount(
  total: number,
  sold: number,
  alreadyReturned: number,
  previousAmount: number,
  quantity: number,
) {
  const cents = Math.round(total * 100);
  const cumulative = Math.round((cents * (alreadyReturned + quantity)) / sold);
  return Math.max(0, cumulative - Math.round(previousAmount * 100)) / 100;
}

export function settleReturn(amount: number, balance: number) {
  const amountCents = Math.round(amount * 100);
  const debtCents = Math.min(
    amountCents,
    Math.max(0, Math.round(balance * 100)),
  );
  return {
    debtReduction: debtCents / 100,
    refundAmount: (amountCents - debtCents) / 100,
    balance: (Math.round(balance * 100) - debtCents) / 100,
  };
}

/** Legacy returns have a variant but no line. Allocate them in stable line order. */
export function allocateReturnedLines(
  lines: Array<{
    id: string;
    variantId: string;
    quantity: number;
    lineTotal: unknown;
  }>,
  returns: Array<{
    invoiceLineId: string | null;
    variantId: string;
    quantity: number;
    refundedTotal: unknown;
  }>,
) {
  const result = new Map(
    lines.map((line) => [line.id, { quantity: 0, amount: 0 }]),
  );
  for (const row of returns.filter((row) => row.invoiceLineId)) {
    const value = result.get(row.invoiceLineId!);
    if (value) {
      value.quantity += row.quantity;
      value.amount += Number(row.refundedTotal);
    }
  }
  for (const row of returns.filter((row) => !row.invoiceLineId)) {
    let quantity = row.quantity;
    let cents = Math.round(Number(row.refundedTotal) * 100);
    for (const line of [...lines].sort((a, b) => a.id.localeCompare(b.id))) {
      if (line.variantId !== row.variantId || quantity <= 0) continue;
      const value = result.get(line.id)!;
      const allocated = Math.min(
        quantity,
        Math.max(0, line.quantity - value.quantity),
      );
      const allocatedCents = Math.round((cents * allocated) / quantity);
      value.quantity += allocated;
      value.amount += allocatedCents / 100;
      quantity -= allocated;
      cents -= allocatedCents;
    }
  }
  return result;
}
