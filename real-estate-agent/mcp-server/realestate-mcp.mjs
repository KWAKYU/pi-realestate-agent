#!/usr/bin/env node
/**
 * MCP 서버 — 국토교통부 부동산 실거래가 (data.go.kr)
 *
 * stdio 트랜스포트로 다음 MCP 툴을 노출한다:
 *   - search_transactions : 매매 실거래가 (아파트/오피스텔/연립다세대)
 *   - search_rent         : 전월세 실거래가 (아파트/오피스텔/연립다세대)
 *   - market_trend        : 최근 N개월 평균 매매가 추이
 *
 * Pi 확장(extensions/realestate.ts)이 MCP 클라이언트로 이 서버에 연결해 사용한다.
 * ※ 각 데이터셋은 data.go.kr에서 [활용신청] 후에만 응답한다(미신청 시 403).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

// .env(상위 폴더)에서 data.go.kr 키 로드
let KEY = process.env.DATA_GO_KR_KEY || "";
try {
  for (const line of readFileSync(join(__dir, "..", ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*DATA_GO_KR_KEY\s*=\s*(.*)\s*$/);
    if (m) KEY = m[1].replace(/^['"]|['"]$/g, "").trim();
  }
} catch { /* env 없으면 무시 */ }

const REGION_CODES = {
  "강남구": "11680", "서초구": "11650", "송파구": "11710", "강동구": "11740",
  "용산구": "11170", "마포구": "11440", "성동구": "11200", "광진구": "11215",
  "종로구": "11110", "중구": "11140", "영등포구": "11560", "동작구": "11590",
  "양천구": "11470", "강서구": "11500", "노원구": "11350", "성북구": "11290",
};

// 부동산 유형 × 거래종류 → data.go.kr 엔드포인트
const ENDPOINTS = {
  apt:       { trade: "RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade",   rent: "RTMSDataSvcAptRent/getRTMSDataSvcAptRent" },
  officetel: { trade: "RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade", rent: "RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent" },
  villa:     { trade: "RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade",     rent: "RTMSDataSvcRHRent/getRTMSDataSvcRHRent" },
};
const TYPE_LABEL = { apt: "아파트", officetel: "오피스텔", villa: "연립다세대" };

// ⚠️ data.go.kr WAF는 User-Agent 없는 요청을 차단 → 브라우저 UA 필수
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const eok = (manwon) => (manwon / 10000).toFixed(1).replace(/\.0$/, "");
const ymLast = (back = 1) => { const d = new Date(); d.setMonth(d.getMonth() - back); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`; };

// XML item 파싱 (유형별 필드명이 달라 폴백을 넓게 잡음)
function parseItems(xml, deal) {
  const items = [];
  for (const block of xml.match(/<item>([\s\S]*?)<\/item>/g) || []) {
    const get = (t) => (block.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [, ""])[1].trim();
    const num = (s) => parseInt(String(s).replace(/[,\s]/g, "")) || 0;
    const it = {
      name: get("aptNm") || get("offiNm") || get("mhouseNm") || get("단지명") || get("아파트") || get("연립다세대") || "",
      dong: get("umdNm") || get("법정동"),
      area: parseFloat(get("excluUseAr") || get("전용면적")) || 0,
      floor: parseInt(get("floor") || get("층")) || 0,
      year: parseInt(get("buildYear") || get("건축년도")) || 0,
      ymd: `${get("dealYear")}.${get("dealMonth")}.${get("dealDay")}`,
    };
    if (deal === "rent") {
      it.deposit = num(get("deposit") || get("보증금액"));
      it.monthly = num(get("monthlyRent") || get("월세금액"));
    } else {
      it.amount = num(get("dealAmount") || get("거래금액"));
    }
    items.push(it);
  }
  return items;
}

async function fetchRtms(propertyType, deal, region, ym, rows) {
  const ep = (ENDPOINTS[propertyType] || ENDPOINTS.apt)[deal];
  const lawd = REGION_CODES[region] || region;
  const url =
    `https://apis.data.go.kr/1613000/${ep}` +
    `?serviceKey=${encodeURIComponent(KEY)}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=${rows}&pageNo=1`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
    const xml = await r.text();
    if (r.status === 401) return { error: "인증키 미인식 (401)" };
    if (r.status === 403 || /Forbidden|SERVICE_KEY_IS_NOT_REGISTERED|NOT_REGISTERED/i.test(xml))
      return { error: `'${TYPE_LABEL[propertyType] || propertyType} ${deal === "rent" ? "전월세" : "매매"}' 데이터셋 미승인 — data.go.kr에서 활용신청이 필요합니다.` };
    return { items: parseItems(xml, deal) };
  } catch (e) {
    return { error: "네트워크 오류: " + e.message };
  }
}

const server = new McpServer({ name: "realestate-mcp", version: "1.1.0" });

// ── 매매 실거래가 ─────────────────────────────────────────────────────────────
server.registerTool(
  "search_transactions",
  {
    title: "매매 실거래가 조회",
    description:
      "국토교통부 부동산 매매 실거래가를 조회한다. " +
      "propertyType: apt(아파트·기본) | officetel(오피스텔) | villa(연립다세대). " +
      "region은 구 이름(예: 강남구) 또는 5자리 법정동코드(예: 11680). ym은 거래년월 YYYYMM(미지정 시 지난달).",
    inputSchema: {
      region: z.string().describe("구 이름 또는 5자리 법정동코드"),
      ym: z.string().optional().describe("거래년월 YYYYMM (미지정 시 지난달)"),
      rows: z.number().optional().describe("최대 건수 (기본 20)"),
      propertyType: z.enum(["apt", "officetel", "villa"]).optional().describe("부동산 유형 (기본 apt)"),
    },
  },
  async ({ region, ym, rows, propertyType }) => {
    if (!KEY || KEY === "YOUR_DATA_GO_KR_KEY_HERE")
      return { content: [{ type: "text", text: "DATA_GO_KR_KEY가 설정되지 않았습니다." }] };
    const pt = propertyType || "apt", month = ym || ymLast(1);
    const res = await fetchRtms(pt, "trade", region, month, rows || 20);
    if (res.error) return { content: [{ type: "text", text: `조회 실패: ${res.error}` }] };
    const items = res.items.filter((i) => i.amount > 0).sort((a, b) => b.amount - a.amount);
    if (!items.length)
      return { content: [{ type: "text", text: `${region} ${month} ${TYPE_LABEL[pt]} 매매: 거래 내역 없음 (직전 달 조회 권장).` }] };
    const amts = items.map((i) => i.amount);
    const avg = Math.round(amts.reduce((a, b) => a + b, 0) / amts.length);
    const lines = items.slice(0, rows || 20).map(
      (i) => `- ${i.dong} ${i.name}: ${eok(i.amount)}억 (전용 ${i.area}㎡, ${i.year}년, ${i.floor}층, ${i.ymd})`
    );
    const text =
      `[${region} ${month.slice(0, 4)}.${month.slice(4)} ${TYPE_LABEL[pt]} 매매 ${items.length}건]\n` +
      `평균 ${eok(avg)}억 · 최고 ${eok(Math.max(...amts))}억 · 최저 ${eok(Math.min(...amts))}억\n` +
      lines.join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── 전월세 실거래가 ───────────────────────────────────────────────────────────
server.registerTool(
  "search_rent",
  {
    title: "전월세 실거래가 조회",
    description:
      "국토교통부 부동산 전월세 실거래가를 조회한다(월세 0이면 전세). " +
      "propertyType: apt(아파트·기본) | officetel(오피스텔) | villa(연립다세대). region/ym 규칙은 매매와 동일.",
    inputSchema: {
      region: z.string().describe("구 이름 또는 5자리 법정동코드"),
      ym: z.string().optional().describe("계약년월 YYYYMM (미지정 시 지난달)"),
      rows: z.number().optional().describe("최대 건수 (기본 20)"),
      propertyType: z.enum(["apt", "officetel", "villa"]).optional().describe("부동산 유형 (기본 apt)"),
    },
  },
  async ({ region, ym, rows, propertyType }) => {
    if (!KEY || KEY === "YOUR_DATA_GO_KR_KEY_HERE")
      return { content: [{ type: "text", text: "DATA_GO_KR_KEY가 설정되지 않았습니다." }] };
    const pt = propertyType || "apt", month = ym || ymLast(1);
    const res = await fetchRtms(pt, "rent", region, month, rows || 20);
    if (res.error) return { content: [{ type: "text", text: `조회 실패: ${res.error}` }] };
    const items = res.items.filter((i) => i.deposit > 0 || i.monthly > 0);
    if (!items.length)
      return { content: [{ type: "text", text: `${region} ${month} ${TYPE_LABEL[pt]} 전월세: 내역 없음 (직전 달 조회 권장).` }] };
    const jeonse = items.filter((i) => i.monthly === 0);
    const wolse = items.filter((i) => i.monthly > 0);
    const jAvg = jeonse.length ? Math.round(jeonse.reduce((a, b) => a + b.deposit, 0) / jeonse.length) : 0;
    const fmt = (i) => i.monthly === 0
      ? `- ${i.dong} ${i.name}: 전세 ${eok(i.deposit)}억 (전용 ${i.area}㎡, ${i.floor}층, ${i.ymd})`
      : `- ${i.dong} ${i.name}: 월세 보증 ${eok(i.deposit)}억/월 ${i.monthly}만 (전용 ${i.area}㎡, ${i.floor}층, ${i.ymd})`;
    const text =
      `[${region} ${month.slice(0, 4)}.${month.slice(4)} ${TYPE_LABEL[pt]} 전월세 ${items.length}건]\n` +
      `전세 ${jeonse.length}건${jAvg ? ` (평균 보증금 ${eok(jAvg)}억)` : ""} · 월세 ${wolse.length}건\n` +
      items.slice(0, rows || 20).map(fmt).join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ── 매매가 추이 ───────────────────────────────────────────────────────────────
server.registerTool(
  "market_trend",
  {
    title: "시세 추이",
    description: "특정 지역의 최근 N개월 평균 매매 실거래가 추이를 조회한다. propertyType 기본 apt.",
    inputSchema: {
      region: z.string().describe("구 이름 또는 5자리 법정동코드"),
      months: z.number().optional().describe("조회 개월 수 (기본 3)"),
      propertyType: z.enum(["apt", "officetel", "villa"]).optional().describe("부동산 유형 (기본 apt)"),
    },
  },
  async ({ region, months, propertyType }) => {
    if (!KEY || KEY === "YOUR_DATA_GO_KR_KEY_HERE")
      return { content: [{ type: "text", text: "DATA_GO_KR_KEY가 설정되지 않았습니다." }] };
    const pt = propertyType || "apt", n = months || 3, out = [];
    for (let b = n; b >= 1; b--) {
      const ym = ymLast(b);
      const res = await fetchRtms(pt, "trade", region, ym, 100);
      const amts = (res.items || []).filter((i) => i.amount > 0).map((i) => i.amount);
      const avg = amts.length ? Math.round(amts.reduce((a, b) => a + b, 0) / amts.length) : 0;
      out.push(`${ym.slice(0, 4)}.${ym.slice(4)}: ${avg ? eok(avg) + "억" : "거래없음"} (${amts.length}건)`);
    }
    return { content: [{ type: "text", text: `[${region} ${TYPE_LABEL[pt]} 최근 ${n}개월 평균 매매가 추이]\n${out.join("\n")}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr로만 로그 (stdout은 MCP 프로토콜 전용)
console.error("[realestate-mcp] MCP 서버 시작됨 (stdio) — 매매/전월세 × 아파트/오피스텔/빌라");
