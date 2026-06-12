/**
 * Pi Extension — 부동산 실거래가 분석
 *
 * 이 확장은 Pi 에이전트에:
 *   1) search_transactions 툴 — MCP 클라이언트로 realestate-mcp 서버(data.go.kr)에 연결 (★MCP 통합)
 *   2) loan_calculator 툴 — LTV/DSR 대출 한도 계산 (순수 로직)
 *   3) /시세 슬래시 커맨드
 *   4) tool_execution_end 이벤트 훅 (툴 사용 로깅)
 * 을 등록한다.
 *
 * Pi CLI가 package.json의 "pi.extensions" 경로에서 자동 로드한다.
 */
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(__dir, "..", "mcp-server", "realestate-mcp.mjs");

// MCP 클라이언트 (지연 연결 후 재사용)
let mcpClient: any = null;
async function getMcpClient() {
  if (mcpClient) return mcpClient;
  const transport = new StdioClientTransport({ command: "node", args: [MCP_SERVER] });
  const client = new Client({ name: "pi-realestate-ext", version: "1.0.0" });
  await client.connect(transport);
  mcpClient = client;
  return client;
}

export default (pi: any) => {
  // ── 툴 1: 실거래가 조회 (MCP 클라이언트) ──────────────────────────────────────
  pi.registerTool({
    name: "search_transactions",
    label: "실거래가 조회 (MCP)",
    description:
      "국토교통부 아파트 매매 실거래가를 MCP 서버를 통해 조회한다. " +
      "region은 구 이름(예: 강남구) 또는 5자리 법정동코드(예: 11680). ym은 YYYYMM(미지정 시 지난달).",
    promptSnippet: "search_transactions: 지역 실거래가를 MCP로 조회",
    parameters: Type.Object({
      region: Type.String({ description: "구 이름(강남구) 또는 5자리 코드(11680)" }),
      ym: Type.Optional(Type.String({ description: "거래년월 YYYYMM (미지정 시 지난달)" })),
      rows: Type.Optional(Type.Number({ description: "최대 건수 (기본 15)" })),
    }),
    execute: async (_id: string, args: { region: string; ym?: string; rows?: number }) => {
      try {
        const client = await getMcpClient();
        const res = await client.callTool({
          name: "search_transactions",
          arguments: { region: args.region, ym: args.ym, rows: args.rows ?? 15 },
        });
        const text = (res.content || []).map((c: any) => c.text).filter(Boolean).join("\n") || "(빈 결과)";
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `MCP 조회 오류: ${e.message}` }], details: {} };
      }
    },
  });

  // ── 툴 2: 시세 추이 조회 (MCP) ───────────────────────────────────────────────
  pi.registerTool({
    name: "market_trend",
    label: "시세 추이 (MCP)",
    description:
      "특정 지역의 최근 N개월 평균 실거래가 추이를 MCP 서버를 통해 조회한다. " +
      "region은 구 이름(예: 강남구) 또는 5자리 코드. months 미지정 시 3개월.",
    promptSnippet: "market_trend: 지역 시세 추이를 MCP로 조회",
    parameters: Type.Object({
      region: Type.String({ description: "구 이름(강남구) 또는 5자리 코드(11680)" }),
      months: Type.Optional(Type.Number({ description: "조회 개월 수 (기본 3)" })),
    }),
    execute: async (_id: string, args: { region: string; months?: number }) => {
      try {
        const client = await getMcpClient();
        const res = await client.callTool({
          name: "market_trend",
          arguments: { region: args.region, months: args.months ?? 3 },
        });
        const text = (res.content || []).map((c: any) => c.text).filter(Boolean).join("\n") || "(빈 결과)";
        return { content: [{ type: "text" as const, text }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `MCP 조회 오류: ${e.message}` }], details: {} };
      }
    },
  });

  // ── 툴 3: 대출 한도 계산 (LTV / DSR) ─────────────────────────────────────────
  pi.registerTool({
    name: "loan_calculator",
    label: "대출 한도 계산",
    description: "주택담보대출 LTV/DSR 기준 예상 한도를 계산한다(참고용).",
    promptSnippet: "loan_calculator: LTV/DSR 대출 한도 계산",
    parameters: Type.Object({
      price: Type.Number({ description: "매매가 (억원)" }),
      income: Type.Number({ description: "연소득 (만원)" }),
      rate: Type.Optional(Type.Number({ description: "연 금리 % (기본 3.5)" })),
    }),
    execute: async (_id: string, args: { price: number; income: number; rate?: number }) => {
      const priceManwon = args.price * 10000;
      const ltvLimit = Math.round(priceManwon * 0.5); // 규제지역 LTV 50% 가정
      const r = (args.rate ?? 3.5) / 100;
      const n = 30;
      const factor = r > 0 ? (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : 1 / n;
      const dsrLimit = Math.round((args.income * 0.4) / factor); // DSR 40%, 30년 원리금 근사
      const limit = Math.min(ltvLimit, dsrLimit);
      const eok = (m: number) => (m / 10000).toFixed(1);
      const text =
        `[대출 한도 — 참고용]\n` +
        `매매가 ${args.price}억 · 연소득 ${eok(args.income)}억 · 금리 ${args.rate ?? 3.5}%\n` +
        `- LTV 50% 한도: ${eok(ltvLimit)}억\n` +
        `- DSR 40% 한도(30년): ${eok(dsrLimit)}억\n` +
        `→ 예상 가능액: 약 ${eok(limit)}억\n` +
        `※ 실제 한도는 규제지역·신용·은행 심사로 달라집니다.`;
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  // ── 슬래시 커맨드: /시세 ──────────────────────────────────────────────────────
  pi.registerCommand("시세", {
    description: "특정 구의 실거래가를 조회합니다 (예: /시세 강남구)",
    execute: async (ctx: any) => {
      await ctx.sendMessage("강남구의 최근 실거래가를 search_transactions 툴로 조회해서 평균·최고·최저와 대표 단지를 요약해줘.");
    },
  });

  // ── 이벤트 훅: 툴 실행 로깅 (확장 이벤트 데모) ───────────────────────────────
  pi.on("tool_execution_end", (event: any) => {
    console.error(`[realestate-ext] 툴 실행: ${event?.toolName ?? "unknown"}`);
  });
};
