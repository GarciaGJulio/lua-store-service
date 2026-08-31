import { calculateCashReconciliation } from './cash-reconciliation';

describe('cash reconciliation', () => {
  it('uses actual cash and bank values for the collected total', () => {
    expect(
      calculateCashReconciliation({
        countedBankTotal: 29.5,
        countedCashTotal: 148.25,
        expectedBankTotal: 30,
        expectedCashTotal: 150,
        nextDayOpeningAmount: 50,
      }),
    ).toEqual({
      bankDifferenceAmount: -0.5,
      dailyCollectedTotal: 127.75,
      differenceAmount: -1.75,
      totalDifferenceAmount: -2.25,
    });
  });
});
