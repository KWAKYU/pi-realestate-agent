import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * 권리관계 분석 툴
 * 등기부등본 텍스트를 입력하면 위험 요소를 파싱하고 안전 여부를 판단합니다.
 */
export const rightsAnalysisTool = defineTool({
  name: "rights_analysis",
  label: "권리관계 분석",
  description: "등기부등본 내용(텍스트)을 분석하여 근저당, 가압류, 전세권 등 위험 요소를 파악하고 안전 등급을 반환합니다.",
  parameters: Type.Object({
    registry_text: Type.String({
      description: "등기부등본 원문 텍스트. 없으면 '없음'으로 입력하면 기본 체크리스트를 반환합니다.",
    }),
    property_name: Type.Optional(Type.String({ description: "매물명 (보고서 제목용)" })),
  }),
  execute: async (_id, { registry_text, property_name = "매물" }) => {
    const risks: string[] = [];
    const warnings: string[] = [];
    const safe: string[] = [];

    if (registry_text === "없음" || registry_text.trim().length < 10) {
      const checklist = `
[ 권리관계 체크리스트: ${property_name} ]
등기부등본을 직접 붙여넣으면 자동 분석이 가능합니다.

수동 확인 항목:
  □ 근저당 설정 여부 (채권최고액 확인)
  □ 가압류 / 압류 여부
  □ 전세권 / 임차권 등기 여부
  □ 신탁 등기 여부
  □ 가처분 / 예고등기 여부
  □ 소유권 이전 이력 (잦은 매매 주의)
  □ 공유 지분 여부

발급 방법: 대법원 인터넷등기소 (iros.go.kr) → 열람/발급
`.trim();
      return { content: [{ type: "text" as const, text: checklist }], details: {} };
    }

    const text = registry_text.toLowerCase();

    // 위험 패턴 감지
    if (/근저당|저당권/.test(text)) risks.push("근저당 설정 발견 — 채권최고액 확인 필요");
    if (/가압류|압류/.test(text)) risks.push("가압류/압류 발견 — 매수 전 해소 확인 필요");
    if (/신탁/.test(text)) risks.push("신탁 등기 발견 — 수익자 확인 필요");
    if (/가처분/.test(text)) risks.push("가처분 발견 — 소유권 분쟁 가능성");
    if (/예고등기/.test(text)) risks.push("예고등기 발견 — 소송 진행 중일 수 있음");

    // 경고 패턴
    if (/전세권|임차권/.test(text)) warnings.push("전세권/임차권 등기 존재 — 인수 여부 확인");
    if (/공유/.test(text)) warnings.push("공유 지분 — 공유자 동의 필요");

    // 안전 확인
    if (!/근저당|저당권/.test(text)) safe.push("근저당 없음");
    if (!/가압류|압류/.test(text)) safe.push("압류 없음");
    if (!/가처분/.test(text)) safe.push("가처분 없음");

    const grade = risks.length === 0 && warnings.length === 0
      ? "A (안전)"
      : risks.length > 0
      ? `C (위험 — ${risks.length}건 발견)`
      : "B (주의)";

    const riskLines = risks.length > 0 ? `\n위험 요소:\n${risks.map(r => `  ⚠ ${r}`).join("\n")}` : "";
    const warnLines = warnings.length > 0 ? `\n주의 사항:\n${warnings.map(w => `  △ ${w}`).join("\n")}` : "";
    const safeLines = safe.length > 0 ? `\n이상 없음:\n${safe.map(s => `  ✓ ${s}`).join("\n")}` : "";

    const result = `
[ 권리관계 분석: ${property_name} ]
안전 등급: ${grade}
${riskLines}${warnLines}${safeLines}

권고: ${risks.length > 0 ? "전문 법무사/변호사 검토 후 계약하세요." : "이상 없으나 계약 직전 최신본 재확인을 권장합니다."}
`.trim();

    return {
      content: [{ type: "text" as const, text: result }],
      details: { grade, risks, warnings, safe },
    };
  },
});
