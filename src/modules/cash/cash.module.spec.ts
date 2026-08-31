import { getEcuadorBusinessDayKey } from './business-time';

describe('Ecuador business day', () => {
  it('keeps the Ecuador business day open after midnight UTC', () => {
    expect(getEcuadorBusinessDayKey(new Date('2026-08-31T00:00:00.000Z'))).toBe(
      '2026-08-30',
    );
  });

  it('changes the business day at midnight in Ecuador', () => {
    expect(getEcuadorBusinessDayKey(new Date('2026-08-31T05:00:00.000Z'))).toBe(
      '2026-08-31',
    );
  });
});
