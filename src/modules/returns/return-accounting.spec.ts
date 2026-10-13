import {
  allocateReturnedLines,
  returnLineAmount,
  settleReturn,
} from './return-accounting';

describe('Return accounting', () => {
  it.each([
    [100, 100, 100, 0, 0],
    [30, 100, 30, 0, 70],
    [30, 60, 30, 0, 30],
    [30, 20, 20, 10, 0],
    [100, 60, 60, 40, 0],
    [30, 0, 0, 30, 0],
  ])(
    'settles return %s against debt %s',
    (amount, balance, debtReduction, refundAmount, nextBalance) => {
      expect(settleReturn(amount, balance)).toEqual({
        debtReduction,
        refundAmount,
        balance: nextBalance,
      });
    },
  );
  it('allocates cents across successive partial returns without exceeding the original', () => {
    const first = returnLineAmount(10, 3, 0, 0, 1);
    const second = returnLineAmount(10, 3, 1, first, 1);
    const third = returnLineAmount(10, 3, 2, first + second, 1);
    expect([first, second, third]).toEqual([3.33, 3.34, 3.33]);
    expect(first + second + third).toBe(10);
  });
  it('closes the remaining amount even if a legacy return rounded differently', () => {
    expect(returnLineAmount(10, 3, 2, 6.66, 1)).toBe(3.34);
  });
  it('distinguishes two invoice lines with the same variant', () => {
    const result = allocateReturnedLines(
      [
        { id: 'a', variantId: 'v', quantity: 1, lineTotal: 10 },
        { id: 'b', variantId: 'v', quantity: 2, lineTotal: 15 },
      ],
      [{ invoiceLineId: 'b', variantId: 'v', quantity: 1, refundedTotal: 7.5 }],
    );
    expect(result.get('a')).toEqual({ quantity: 0, amount: 0 });
    expect(result.get('b')).toEqual({ quantity: 1, amount: 7.5 });
  });
  it('allocates legacy variant quantities only once across repeated lines', () => {
    const result = allocateReturnedLines(
      [
        { id: 'a', variantId: 'v', quantity: 1, lineTotal: 10 },
        { id: 'b', variantId: 'v', quantity: 2, lineTotal: 20 },
      ],
      [{ invoiceLineId: null, variantId: 'v', quantity: 2, refundedTotal: 20 }],
    );
    expect(result.get('a')).toEqual({ quantity: 1, amount: 10 });
    expect(result.get('b')).toEqual({ quantity: 1, amount: 10 });
  });
});
