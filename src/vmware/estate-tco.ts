export interface TcoScenario {
  readonly years: number;
  readonly purchaseNow: boolean;
  readonly refreshMonths: number;
  readonly firstRefreshMonths: number;
  readonly hardwareCost: number;
  readonly sourceMonthly: number;
  readonly sourceGrowth: number;
  readonly hardwareGrowth: number;
  readonly discountRate: number;
  readonly cloud?: {
    readonly monthly: number;
    readonly annualGrowth: number;
    readonly upfront: number;
    readonly dualRunMonths: number;
  };
}

export function estateTco(scenario: TcoScenario) {
  const { years, purchaseNow, refreshMonths, firstRefreshMonths, hardwareCost, sourceMonthly, sourceGrowth,
    hardwareGrowth, discountRate, cloud } = scenario;
  const totalMonths = years * 12;
  let sourceTotal = purchaseNow ? hardwareCost : 0;
  let cloudTotal = cloud?.upfront ?? 0;
  let sourcePresentValue = sourceTotal;
  let cloudPresentValue = cloudTotal;
  let crossover: number | null = null;
  const rows = [];
  let capital = sourceTotal;
  let operating = 0;
  let cloudSpend = cloudTotal;
  let priorDifference = cloudTotal - sourceTotal;

  for (let month = 0; month < totalMonths; month++) {
    const year = Math.floor(month / 12);
    const refresh = month >= firstRefreshMonths && (month - firstRefreshMonths) % refreshMonths === 0
      ? hardwareCost * (1 + hardwareGrowth / 100) ** year : 0;
    const sourceCost = sourceMonthly * (1 + sourceGrowth / 100) ** year;
    const destinationCost = cloud ? cloud.monthly * (1 + cloud.annualGrowth / 100) ** year
      + (month < cloud.dualRunMonths ? sourceCost : 0) : 0;
    const discount = (1 + discountRate / 100) ** ((month + 1) / 12);
    capital += refresh;
    operating += sourceCost;
    cloudSpend += destinationCost;
    sourceTotal += refresh + sourceCost;
    sourcePresentValue += refresh / ((1 + discountRate / 100) ** (month / 12)) + sourceCost / discount;
    cloudTotal += destinationCost;
    cloudPresentValue += destinationCost / discount;
    const difference = cloudTotal - sourceTotal;
    if (cloud) {
      if (difference > 0) crossover = null;
      else if (priorDifference > 0) crossover = month + 1;
      priorDifference = difference;
    }
    if ((month + 1) % 12 === 0) {
      rows.push({ year: year + 1, capital, operating, sourceTotal, cloudSpend, cloudTotal, sourcePresentValue, cloudPresentValue });
      capital = 0;
      operating = 0;
      cloudSpend = 0;
    }
  }
  return { rows, sourceTotal, cloudTotal, sourcePresentValue, cloudPresentValue, crossover };
}
