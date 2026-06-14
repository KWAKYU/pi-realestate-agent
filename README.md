<img width="476" height="268" alt="image" src="https://github.com/user-attachments/assets/094f719f-04f7-411b-ae77-f9e2db5b033c" /># 🏠 부동산 지도 AI 에이전트 (Pi Agent)

> 서울 아파트 **국토교통부 실거래가**를 지도에서 탐색하고, **Pi 에이전트**에게 자연어로 물어보면
> MCP로 실데이터를 가져와 분석·요약해 주는 AI 부동산 서비스.

지도를 움직이면 해당 지역 실거래가가 핀으로 뜨고, 가격/면적 필터·관심매물·지하철·학군 레이어를 제공하며,
우측 채팅에서 "강남구 제일 비싼 단지 알려줘", "연소득 8천이면 25억 대출 얼마나?" 같은 질문에
**Pi 에이전트 + Skill + MCP + Extension**이 협력해 답합니다.

---

## 📌 선택 시나리오 / 문제 정의

- **시나리오:** 부동산 실거래가 조회·분석 AI 에이전트
- **문제:** 실거래가 데이터(국토부 API)는 XML·코드 기반이라 일반 사용자가 직접 해석하기 어렵고, 지도·시세·대출을 한 화면에서 묻고 답하기 힘들다.
- **대상 사용자:** 서울 아파트 매수/이사를 고민하며 시세·대출 한도를 빠르게 파악하고 싶은 일반 사용자.
- **해결:** 지도 UI + 실거래가 + 자연어 AI 에이전트(Pi)를 결합. 사용자는 채팅으로 묻기만 하면 에이전트가 MCP 툴로 실데이터를 조회·계산해 답한다.

---

## 🧩 시스템 구조

```
[브라우저 Web UI]  부동산_지도_에이전트.html (Leaflet 지도 + 채팅)
       │  POST /api/agent {message, hint}
       ▼
[Express 서버]  real-estate-agent/server.js
       │  spawn (헤드리스)
       ▼
[Pi 에이전트]  @earendil-works/pi-coding-agent  (모델: OpenRouter)
   ├─ Skill      skills/real-estate-analysis.md         ← 분석 절차·응답 가이드
   └─ Extension  extensions/realestate.ts               ← registerTool / registerCommand / on(event)
            │  registerTool("search_transactions")  =  MCP 클라이언트
            ▼
[MCP 서버]  mcp-server/realestate-mcp.mjs  (@modelcontextprotocol/sdk, stdio)
            │  fetch (브라우저 UA)
            ▼
[국토교통부 실거래가 API]  apis.data.go.kr  (data.go.kr)
```

지도 핀/카드/분석 패널은 별도로 `/api/apt-trade`(data.go.kr 프록시)로 실데이터를 받아 렌더링한다.

---

## ⚙️ 설치 방법

```bash
# 1) 백엔드 폴더로 이동
cd real-estate-agent

# 2) 의존성 설치
npm install

# 3) 환경변수 설정 (.env)
cp .env.example .env
#   .env 에 두 키를 채웁니다:
#   - DATA_GO_KR_KEY   : data.go.kr "아파트 매매 실거래가" 일반 인증키(Decoding)
#   - OPENROUTER_API_KEY: https://openrouter.ai/keys 의 sk-or-v1-... 키
```

## ▶️ 실행 방법

```bash
cd real-estate-agent
node server.js
# → http://localhost:3000  접속 (지도 + 채팅)
```

> 서버 없이 `부동산_지도_에이전트.html` 만 더블클릭해도 내장 목업 데이터로 UI는 동작합니다.
> 실거래가·AI 에이전트 기능은 서버(`node server.js`) 실행이 필요합니다.

---

## ✨ 주요 기능

- **지도 기반 실거래가 탐색** — 지도를 드래그/줌하면 화면에 들어온 서울 구(區)의 실거래가가 가격 핀으로 누적 표시
- **필터** — 가격·면적 드롭다운으로 카드·마커 동시 필터링
- **레이어** — 지하철·학군·편의시설(OSM Overpass 실데이터), 개발계획, 실거래가 토글
- **관심매물 / 검색 / 위성지도 / AI 분석 리포트**
- **AI 에이전트 채팅(Pi)** — 자연어 질문 → Pi 에이전트가 실거래가 조회·대출 계산 후 답변

---

## 🤖 Pi / Skill / MCP / Pi Extension 활용 설명

### 1) Pi 활용
`@earendil-works/pi-coding-agent`(Pi 코딩 에이전트 SDK)를 **헤드리스(`pi -p`)로 구동**한다.
웹 서버(`server.js`)의 `/api/agent` 엔드포인트가 사용자의 질문을 Pi 에이전트에 전달하고,
에이전트가 OpenRouter 모델로 추론하며 툴을 호출해 답을 만든다.
- 관련 파일: `real-estate-agent/server.js` (`/api/agent`), `real-estate-agent/index.ts` (TUI용 SDK 구성)

### 2) Skill 활용
`real-estate-agent/skills/real-estate-analysis.md` — 부동산 분석 **절차/응답 가이드** 스킬.
표준 frontmatter(`name`, `description`)를 갖추며, "가격 질문 시 `search_transactions`로 실데이터 조회 →
평균/최고/최저 정리 → 필요 시 대출 계산" 절차를 정의한다. Pi가 `package.json`의 `pi.skills` 경로에서 자동 로드.

### 3) MCP 활용
`real-estate-agent/mcp-server/realestate-mcp.mjs` — **MCP 서버**(`@modelcontextprotocol/sdk`, stdio).
국토교통부 실거래가 API를 MCP 툴로 노출한다.
- `search_transactions(region, ym?, rows?)` — 지역·월 실거래가(평균/최고/최저 + 단지 목록)
- `market_trend(region, months?)` — 최근 N개월 평균가 추이

이 MCP 서버를 **Pi 확장이 MCP 클라이언트로 연결**해 호출한다 (아래 4 참고). 즉 MCP가 에이전트 흐름에 통합되어 있다.

### 4) Pi Extension 활용
`real-estate-agent/extensions/realestate.ts` — Pi가 `package.json`의 `pi.extensions` 경로에서 자동 로드하는 확장.
`export default (pi) => { ... }` 형태로:
- `pi.registerTool("search_transactions", ...)` — **MCP 클라이언트**로 MCP 서버에 연결해 실거래가 조회
- `pi.registerTool("loan_calculator", ...)` — LTV/DSR 대출 한도 계산
- `pi.registerCommand("시세", ...)` — `/시세` 슬래시 커맨드
- `pi.on("tool_execution_end", ...)` — 툴 실행 이벤트 훅

> `package.json`의 매니페스트:
> ```json
> "keywords": ["pi-package"],
> "pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
> ```

### 5) Web UI
`부동산_지도_에이전트.html` — Leaflet 지도 + 채팅 단일 페이지 웹앱. CLI가 아닌 브라우저 화면에서 입력/결과 확인.

---

## 🛠 기술 스택

| 구분 | 사용 기술 |
|---|---|
| 프론트엔드 | HTML/CSS/JS (단일 파일), Leaflet, OpenStreetMap, Overpass API |
| 백엔드 | Node.js, Express |
| AI 에이전트 | Pi (`@earendil-works/pi-coding-agent`), OpenRouter |
| MCP | `@modelcontextprotocol/sdk` (stdio), TypeBox / Zod |
| 외부 데이터 | 국토교통부 실거래가(data.go.kr), OSM Overpass |

---

## 📂 디렉토리 구조

```
기말과제/
├─ 부동산_지도_에이전트.html        # Web UI (지도 + 채팅)
├─ README.md
└─ real-estate-agent/
   ├─ server.js                     # Express: /api/agent, /api/chat, /api/apt-trade, /api/status
   ├─ index.ts                      # Pi 에이전트 TUI 구성 (SDK)
   ├─ package.json                  # "pi" 매니페스트 (extensions, skills)
   ├─ skills/
   │  └─ real-estate-analysis.md    # Skill
   ├─ extensions/
   │  └─ realestate.ts              # Pi Extension (tool/command/hook + MCP 클라이언트)
   ├─ mcp-server/
   │  └─ realestate-mcp.mjs         # MCP 서버 (data.go.kr 실거래가)
   └─ .env.example
```

---

## 🖼 실행 화면

<img width="1457" height="825" alt="Picture1" src="https://github.com/user-attachments/assets/360adf8b-1566-4e5b-80a7-47df2e494dd2" />

---

## ⚠️ 한계점 및 개선 방향

- **응답 지연:** `/api/agent`는 요청마다 Pi 프로세스를 새로 띄워(콜드 스타트) 응답에 수십 초가 걸린다.
  → Pi **RPC 모드 상주 프로세스**로 전환하면 대폭 단축 가능.
- **대화 맥락:** 현재 에이전트 호출은 무상태(질문 단위). → 세션 유지로 멀티턴 메모리 추가 가능.
- **좌표 부재:** 실거래가 API에 위경도가 없어 지도 핀은 동(洞) 중심 근사 배치.
- **거래유형:** data.go.kr는 매매 데이터만 제공 (전세/월세/오피스텔 미지원).
- **대출 계산:** LTV/DSR 근사치이며 실제 한도는 은행 심사로 달라짐(참고용).
