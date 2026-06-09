import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface PropertyInput {
  name: string;
  price_man: number;
  area_sqm: number;
  year: number;
  subway_min: number;
  mortgage: boolean;
}

function score(p: PropertyInput): number {
  let s = 100;
  // 연식 감점 (1년당 1점, 최대 20점)
  const age = new Date().getFullYear() - p.year;
  s -= Math.min(age, 20);
  // 지하철 거리 감점
  if (p.subway_min > 10) s -= 15;
  else if (p.subway_min > 7) s -= 8;
  else if (p.subway_min > 5) s -= 4;
  // 근저당 감점
  if (p.mortgage) s -= 15;
  // 평당가 기준 보정 (낮을수록 가성비 +점수)
  const pyeong = p.area_sqm / 3.305;
  const perPyeong = p.price_man / pyeong / 10000;
  if (perPyeong < 0.5) s += 5;
  else if (perPyeong > 1.5) s -= 5;
  return Math.max(0, Math.min(100, s));
}

/**
 * 복수 매물 비교 툴
 * 여러 매물을 나란히 비교하고 종합 점수 순으로 순위를 매깁니다.
 */
export const comparePropertiesTool = defineTool({
  name: "compare_properties",
  label: "매물 비교",
  description: "최대 5개 매물 정보를 입력하면 평당가·연식·입지·권리관계를 비교하고 종합 점수 순위를 반환합니다.",
  parameters: Type.Object({
    properties: Type.Array(
      Type.Object({
        name: Type.String({ description: "매물명" }),
        price_man: Type.Number({ description: "매매가 (만원)" }),
        area_sqm: Type.Number({ description: "전용면적 (㎡)" }),
        year: Type.Number({ description: "준공년도" }),
        subway_min: Type.Number({ description: "지하철 도보 분" }),
        mortgage: Type.Boolean({ description: "근저당 여부" }),
      }),
      { minItems: 2, maxItems: 5, description: "비교할 매물 목록 (2~5개)" }
    ),
  }),
  execute: async (_id, { properties }) => {
    const scored = properties
      .map((p) => ({ ...p, score: score(p) }))
      .sort((a, b) => b.score - a.score);

    const col = (s: string, w: number) => s.substring(0, w).padEnd(w);

    const header = `${col("순위 매물명", 16)}${col("매매가", 12)}${col("평당가", 10)}${col("연식", 8)}${col("지하철", 8)}${col("근저당", 8)}점수`;
    const divider = "─".repeat(70);

    const rows = scored.map((p, i) => {
      const pyeong = Math.round(p.area_sqm / 3.305);
      const perPyeong = Math.round(p.price_man / pyeong / 10000);
      const price = `${Math.round(p.price_man / 10000)}억`;
      const age = new Date().getFullYear() - p.year;
      const rank = ["🥇", "🥈", "🥉", "4위", "5위"][i];
      return `${rank} ${col(p.name, 12)} ${col(price, 10)} ${col(perPyeong + "만/평", 10)} ${col(age + "년차", 8)} ${col(p.subway_min + "분", 8)} ${col(p.mortgage ? "있음" : "없음", 8)} ${p.score}점`;
    });

    const winner = scored[0];
    const result = `
[ 매물 비교 분석 ]
${header}
${divider}
${rows.join("\n")}
${divider}
추천: ${winner.name} (${winner.score}점) — 종합 점수 1위
`.trim();

    return {
      content: [{ type: "text" as const, text: result }],
      details: { ranked: scored },
    };
  },
});
