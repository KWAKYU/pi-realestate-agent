import {
  AuthStorage,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  InteractiveMode,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { propertyLookupTool, propertyListTool } from "./tools/propertyTool";
import { loanCalculatorTool } from "./tools/loanTool";
import { rightsAnalysisTool } from "./tools/rightsTool";
import { comparePropertiesTool } from "./tools/compareTool";

// ─── 배너 출력 ────────────────────────────────────────────────────────────────
function printBanner() {
  console.log("\x1b[36m");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║          🏠  부동산 매물 분석 AI 에이전트             ║");
  console.log("║   가격 · 입지 · 권리관계 · 대출 조건 비교 분석        ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("\x1b[0m");
  console.log("사용 예시:");
  console.log("  · 매물 목록 보여줘");
  console.log("  · 래미안원베일리 분석해줘");
  console.log("  · 연소득 8000만원이면 28억 아파트 대출 얼마나 나와?");
  console.log("  · 4개 매물 비교해서 추천해줘");
  console.log("");
}

// ─── 이벤트 버스 (Extension 통신용) ──────────────────────────────────────────
const eventBus = createEventBus();

// 툴 실행 이벤트를 외부에서 수신하는 예시
eventBus.on("tool:executed", (data: { tool: string; durationMs: number }) => {
  // 로그 파일 등으로 확장 가능
  void data;
});

// ─── ResourceLoader 설정 ──────────────────────────────────────────────────────
async function buildResourceLoader() {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    eventBus,

    // 시스템 프롬프트 오버라이드
    systemPromptOverride: () => `
당신은 대한민국 부동산 매물 분석 전문 AI입니다.

역할:
- 매물의 가격, 입지, 권리관계, 대출 조건을 객관적으로 분석합니다.
- 사용자가 현명한 매수 결정을 내릴 수 있도록 핵심 정보를 제공합니다.
- 위험 요소는 명확히 경고하고, 전문가 상담이 필요한 경우 안내합니다.

사용 가능한 툴: property_list, property_lookup, loan_calculator, rights_analysis, compare_properties

응답 원칙:
- 수치(가격, 평당가, 대출한도)는 항상 포함
- 법적 판단과 대출 계산은 "참고용"임을 명시
- 한국어로 답변
`.trim(),

    // Extension: 툴 실행 추적
    extensionFactories: [
      (pi) => {
        pi.on("tool_execution_end", (event) => {
          // 툴 실행 완료 시 이벤트 버스로 알림
          eventBus.emit("tool:executed", {
            tool: (event as { toolName?: string }).toolName ?? "unknown",
            durationMs: 0,
          });
        });

        // 슬래시 커맨드: /매물목록
        pi.registerCommand({
          name: "매물목록",
          description: "등록된 매물 전체 목록을 표시합니다",
          execute: async (piCtx) => {
            await piCtx.sendMessage("등록된 매물 목록을 보여줘");
          },
        });

        // 슬래시 커맨드: /비교
        pi.registerCommand({
          name: "비교",
          description: "등록된 모든 매물을 비교 분석합니다",
          execute: async (piCtx) => {
            await piCtx.sendMessage("등록된 4개 매물 전체를 비교해서 순위와 추천 이유를 알려줘");
          },
        });
      },
    ],
  });

  await loader.reload();
  return loader;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  // Auth & Model
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // Settings: 자동 컴팩션 ON, 재시도 2회
  const settingsManager = SettingsManager.create();
  settingsManager.applyOverrides({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

  const resourceLoader = await buildResourceLoader();

  // Runtime factory (세션 교체 지원: /new, /fork 등)
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({ cwd });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      resourceLoader,
      customTools: [
        propertyListTool,
        propertyLookupTool,
        loanCalculatorTool,
        rightsAnalysisTool,
        comparePropertiesTool,
      ],
      tools: [
        "read",
        "bash",
        "property_list",
        "property_lookup",
        "loan_calculator",
        "rights_analysis",
        "compare_properties",
      ],
      settingsManager,
      authStorage,
      modelRegistry,
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  // AgentSessionRuntime 생성 (세션 지속성 지원)
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(process.cwd()),
  });

  // 진단 경고 출력
  if (runtime.diagnostics?.warnings?.length) {
    for (const w of runtime.diagnostics.warnings) {
      console.warn("\x1b[33m[경고]\x1b[0m", w);
    }
  }

  // InteractiveMode TUI 실행
  const mode = new InteractiveMode(runtime, {
    migratedProviders: [],
    modelFallbackMessage: undefined,
    initialMessage: "안녕하세요! 부동산 매물 분석을 시작합니다. '매물 목록 보여줘'로 시작하거나 궁금한 것을 바로 물어보세요.",
    initialImages: [],
    initialMessages: [],
  });

  await mode.run();
}

main().catch((err) => {
  console.error("\x1b[31m[오류]\x1b[0m", err.message);
  process.exit(1);
});
