#!/usr/bin/env node
/**
 * MCP 서버 — 국토교통부 아파트 매매 실거래가 (data.go.kr)
 *
 * stdio 트랜스포트로 다음 MCP 툴을 노출한다:
 *   - search_transactions : 지역·월 기준 실거래가 조회 (평균/최고/최저 + 단지 목록)
 *   - market_trend        : 최근 N개월 평균가 추이
 *
 * Pi 확장(extensions/realestate.ts)이 MCP 클라이언트로 이 서버에 연결해 사용한다.
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

// ⚠️ data.go.kr WAF는 User-Agent 없는 요청을 차단 → 브라우저 UA 필수
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const eok = (manwon) => (manwon / 10000).toFixed(1).replace(/\.0$/, "");
const ymLast = (back = 1) => { const d = new Date(); d.setMonth(d.getMonth() - back); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`; };

function parseItems(xml) {
  const items = [];
  for (const block of xml.match(/<item>([\s\S]*?)<\/item>/g) || []) {
    const get = (t) => (block.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [, ""])[1].trim();
    const amount = (get("dealAmount") || get("거래금액")).replace(/[,\s]/g, "");
    items.push({
      name: get("aptNm") || get("단지명"),
      dong: get("umdNm") || get("법정동"),
      amount: parseInt(amount) || 0,
      area: parseFloat(get("excluUseAr") || get("전용면적")) || 0,
      floor: parseInt(get("floor") || get("층")) || 0,
      year: parseInt(get("buildYear") || get("건축년도")) || 0,
      ymd: `${get("dealYear")}.${get("dealMonth")}.${get("dealDay")}`,
    });
  }
  return items;
}

async function fetchTrades(region, ym, rows) {
  const lawd = REGION_CODES[region] || region;
  const url =
    `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade` +
    `?serviceKey=${encodeURIComponent(KEY)}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=${rows}&pageNo=1`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/xml" } });
  const xml = await r.text();
  if (r.status === 401) return { error: "인증키 미인식 (401)" };
  if (r.status === 403 || /Forbidden|SERVICE_KEY_IS_NOT_REGISTERED/i.test(xml)) return { error: "API 사용 권한 없음 (403)" };
  return { items: parseItems(xml).filter((i) => i.amount > 0) };
}

const server = new McpServer({ name: "realestate-mcp", version: "1.0.0" });

server.registerTool(
  "search_transactions",
  {
    title: "실거래가 조회",
    description:
      "국토교통부 아파트 매매 실거래가를 지역·월 기준으로 조회한다. " +
      "region은 구 이름(예: 강남구) 또는 5자리 법정동코드(예: 11680). " +
      "ym은 거래년월 YYYYMM(미지정 시 지난달). 당월은 신고지연으로 비어있을 수 있다.",
    inputSchema: {
      region: z.string().describe("구 이름 또는 5자리 법정동코드"),
      ym: z.string().optional().describe("거래년월 YYYYMM (미지정 시 지난달)"),
      rows: z.number().optional().describe("최대 건수 (기본 20)"),
    },
  },
  async ({ region, ym, rows }) => {
    if (!KEY || KEY === "YOUR_DATA_GO_KR_KEY_HERE")
      return { content: [{ type: "text", text: "DATA_GO_KR_KEY가 설정되지 않았습니다." }] };
    const month = ym || ymLast(1);
    const res = await fetchTrades(region, month, rows || 20);
    if (res.error) return { content: [{ type: "text", text: `조회 실패: ${res.error}` }] };
    const items = res.items.sort((a, b) => b.amount - a.amount);
    if (!items.length)
      return { content: [{ type: "text", text: `${region} ${month}: 거래 내역 없음 (신고지연 가능 — 직전 달 조회 권장).` }] };
    const amts = items.map((i) => i.amount);
    const avg = Math.round(amts.reduce((a, b) => a + b, 0) / amts.length);
    const lines = items.slice(0, rows || 20).map(
      (i) => `- ${i.dong} ${i.name}: ${eok(i.amount)}억 (전용 ${i.area}㎡, ${i.year}년, ${i.floor}층, ${i.ymd})`
    );
    const text =
      `[${region} ${month.slice(0, 4)}.${month.slice(4)} 실거래가 ${items.length}건]\n` +
      `평균 ${eok(avg)}억 · 최고 ${eok(Math.max(...amts))}억 · 최저 ${eok(Math.min(...amts))}억\n` +
      lines.join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "market_trend",
  {
    title: "시세 추이",
    description: "특정 지역의 최근 N개월 평균 실거래가 추이를 조회한다.",
    inputSchema: {
      region: z.string().describe("구 이름 또는 5자리 법정동코드"),
      months: z.number().optional().describe("조회 개월 수 (기본 3)"),
    },
  },
  async ({ region, months }) => {
    if (!KEY || KEY === "YOUR_DATA_GO_KR_KEY_HERE")
      return { content: [{ type: "text", text: "DATA_GO_KR_KEY가 설정되지 않았습니다." }] };
    const n = months || 3;
    const rows = [];
    for (let b = n; b >= 1; b--) {
      const ym = ymLast(b);
      const res = await fetchTrades(region, ym, 100);
      const amts = (res.items || []).map((i) => i.amount);
      const avg = amts.length ? Math.round(amts.reduce((a, b) => a + b, 0) / amts.length) : 0;
      rows.push(`${ym.slice(0, 4)}.${ym.slice(4)}: ${avg ? eok(avg) + "억" : "거래없음"} (${amts.length}건)`);
    }
    return { content: [{ type: "text", text: `[${region} 최근 ${n}개월 평균 실거래가 추이]\n${rows.join("\n")}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr로만 로그 (stdout은 MCP 프로토콜 전용)
console.error("[realestate-mcp] MCP 서버 시작됨 (stdio)");
