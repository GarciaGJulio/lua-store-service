type CashReconciliationInput = {
  countedBankTotal: number;
  countedCashTotal: number;
  expectedBankTotal: number;
  expectedCashTotal: number;
  nextDayOpeningAmount: number;
};

function roundCurrency(value: number) {
  return Number(value.toFixed(2));
}

export function calculateCashReconciliation(input: CashReconciliationInput) {
  const differenceAmount = roundCurrency(
    input.countedCashTotal - input.expectedCashTotal,
  );
  const bankDifferenceAmount = roundCurrency(
    input.countedBankTotal - input.expectedBankTotal,
  );

  return {
    bankDifferenceAmount,
    dailyCollectedTotal: roundCurrency(
      input.countedCashTotal +
        input.countedBankTotal -
        input.nextDayOpeningAmount,
    ),
    differenceAmount,
    totalDifferenceAmount: roundCurrency(
      differenceAmount + bankDifferenceAmount,
    ),
  };
}
