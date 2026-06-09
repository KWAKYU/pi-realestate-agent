import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * 대출 한도 및 월 상환액 계산 툴
 * LTV, DSR 기준으로 대출 가능 금액과 월 상환액을 계산합니다.
 */
export const loanCalculatorTool = defineTool({
  name: "loan_calculator",
  label: "대출 계산",
  description: "매매가, 연소득, LTV 비율을 입력하면 최대 대출 한도와 월 상환액을 계산합니다.",
  parameters: Type.Object({
    price_man: Type.Number({ description: "매매가 (만원 단위, 예: 280000 = 28억)" }),
    annual_income_man: Type.Number({ description: "연소득 (만원 단위, 예: 10000 = 1억)" }),
    ltv_ratio: Type.Number({ description: "LTV 비율 (0~1, 예: 0.6 = 60%)", minimum: 0, maximum: 1 }),
    interest_rate: Type.Optional(Type.Number({ description: "연 이자율 (예: 0.04 = 4%), 기본값 4%" })),
    loan_years: Type.Optional(Type.Number({ description: "대출 기간(년), 기본값 30년" })),
  }),
  execute: async (_id, { price_man, annual_income_man, ltv_ratio, interest_rate = 0.04, loan_years = 30 }) => {
    // LTV 한도
    const ltvLimit = price_man * ltv_ratio;

    // DSR 40% 한도: 연 원리금 상환액 ≤ 연소득 × 0.4
    const maxAnnualPayment = annual_income_man * 0.4;
    const monthlyRate = interest_rate / 12;
    const months = loan_years * 12;
    // 원리금균등상환 역산: P = PMT × [(1-(1+r)^-n)/r]
    const dsrLimit = (maxAnnualPayment / 12) * ((1 - Math.pow(1 + monthlyRate, -months)) / monthlyRate);

    const maxLoan = Math.min(ltvLimit, dsrLimit);
    const monthlyPayment = maxLoan * (monthlyRate / (1 - Math.pow(1 + monthlyRate, -months)));
    const selfFund = price_man - maxLoan;
    const acquisitionTax = Math.round(price_man * 0.013); // 1주택 취득세 1.3%

    const fmt = (n: number) => n >= 10000
      ? `${Math.round(n / 10000 * 10) / 10}억 (${Math.round(n).toLocaleString()}만원)`
      : `${Math.round(n).toLocaleString()}만원`;

    const limitedBy = ltvLimit < dsrLimit ? "LTV" : "DSR";

    const result = `
[ 대출 계산 결과 ]
매매가         : ${fmt(price_man)}
연소득         : ${fmt(annual_income_man)}
─────────────────────────────
LTV ${(ltv_ratio * 100).toFixed(0)}% 한도  : ${fmt(ltvLimit)}
DSR 40% 한도   : ${fmt(dsrLimit)}
적용 기준      : ${limitedBy} 기준 적용
─────────────────────────────
최대 대출      : ${fmt(maxLoan)}
월 상환액      : ${Math.round(monthlyPayment).toLocaleString()}만원
자기자본 필요  : ${fmt(selfFund)}
취득세 (1주택) : ${acquisitionTax.toLocaleString()}만원
총 초기 비용   : ${fmt(selfFund + acquisitionTax)}
`.trim();

    return {
      content: [{ type: "text" as const, text: result }],
      details: { maxLoan, monthlyPayment, selfFund },
    };
  },
});
