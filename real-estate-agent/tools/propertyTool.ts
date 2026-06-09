import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 매물 데이터 (실제 서비스에서는 API 또는 DB로 교체)
const PROPERTY_DB: Record<string, {
  name: string;
  address: string;
  price: number; // 만원
  area: number;  // ㎡
  year: number;
  subway: string;
  mortgage: string;
  floor: number;
  direction: string;
}> = {
  "아크로리버파크": {
    name: "아크로리버파크",
    address: "서울 서초구 반포동 1-1",
    price: 350000,
    area: 59,
    year: 2016,
    subway: "2분",
    mortgage: "없음",
    floor: 18,
    direction: "남향",
  },
  "래미안원베일리": {
    name: "래미안원베일리",
    address: "서울 서초구 반포동 465-1",
    price: 280000,
    area: 84,
    year: 2023,
    subway: "5분",
    mortgage: "없음",
    floor: 12,
    direction: "남동향",
  },
  "반포자이": {
    name: "반포자이",
    address: "서울 서초구 반포동 72",
    price: 220000,
    area: 84,
    year: 2009,
    subway: "7분",
    mortgage: "없음",
    floor: 8,
    direction: "남향",
  },
  "헬리오시티": {
    name: "헬리오시티",
    address: "서울 송파구 가락동 99",
    price: 140000,
    area: 84,
    year: 2019,
    subway: "10분",
    mortgage: "없음",
    floor: 15,
    direction: "남향",
  },
};

/**
 * 매물 정보 조회 툴
 * 이름 또는 주소로 매물 상세 정보와 평당 가격을 반환합니다.
 */
export const propertyLookupTool = defineTool({
  name: "property_lookup",
  label: "매물 조회",
  description: "매물 이름으로 상세 정보(가격, 면적, 준공년도, 교통, 권리관계)를 조회합니다.",
  parameters: Type.Object({
    name: Type.String({ description: "조회할 매물 이름 (예: 아크로리버파크)" }),
  }),
  execute: async (_id, { name }) => {
    const prop = PROPERTY_DB[name];
    if (!prop) {
      const available = Object.keys(PROPERTY_DB).join(", ");
      return {
        content: [{ type: "text" as const, text: `매물을 찾을 수 없습니다. 등록된 매물: ${available}` }],
        details: {},
      };
    }

    const pyeong = Math.round(prop.area / 3.305);
    const perPyeong = Math.round(prop.price / pyeong / 10000);
    const age = new Date().getFullYear() - prop.year;

    const result = `
[ 매물 정보: ${prop.name} ]
주소       : ${prop.address}
매매가     : ${Math.round(prop.price / 10000)}억 원
전용면적   : ${prop.area}㎡ (약 ${pyeong}평)
평당 가격  : ${perPyeong}만 원
층수       : ${prop.floor}층
향         : ${prop.direction}
준공       : ${prop.year}년 (${age}년차)
지하철     : 도보 ${prop.subway}
근저당     : ${prop.mortgage}
`.trim();

    return {
      content: [{ type: "text" as const, text: result }],
      details: { property: prop },
    };
  },
});

/**
 * 전체 매물 목록 조회 툴
 */
export const propertyListTool = defineTool({
  name: "property_list",
  label: "매물 목록",
  description: "등록된 모든 매물의 요약 목록을 반환합니다.",
  parameters: Type.Object({}),
  execute: async () => {
    const lines = Object.values(PROPERTY_DB).map((p, i) => {
      const pyeong = Math.round(p.area / 3.305);
      const price = Math.round(p.price / 10000);
      return `${i + 1}. ${p.name.padEnd(12)} | ${price}억 | ${pyeong}평 | ${p.year}년 | 지하철 ${p.subway}`;
    });

    const text = `등록 매물 목록 (총 ${lines.length}건)\n${"─".repeat(55)}\n${lines.join("\n")}`;
    return {
      content: [{ type: "text" as const, text }],
      details: {},
    };
  },
});
