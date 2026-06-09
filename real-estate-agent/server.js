/**
 * 부동산 AI 에이전트 — Express 프록시 서버
 *
 * 역할:
 *  1. 국토교통부 실거래가 API (data.go.kr) CORS 프록시
 *  2. HTML/정적 파일 서빙
 *  3. (선택) Pi SDK 에이전트 RPC 엔드포인트
 *
 * 실행:
 *  node server.js
 *
 * API 키 발급:
 *  https://www.data.go.kr/data/15057511/openapi.do
 *  → 활용신청 → 일반 인증키 발급 (무료, 즉시 발급)
 */

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const url = require('url');
const fs = require('fs');
const { spawn } = require('child_process');

// .env 간이 로더 (외부 의존성 없음) — 같은 폴더의 .env에 DATA_GO_KR_KEY=... 한 줄
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  });
} catch { /* .env 없으면 무시 */ }

const app = express();
const PORT = 3000;

// ── 환경 설정 ─────────────────────────────────────────────────────────────────
// data.go.kr에서 발급받은 "일반 인증키(Decoding)"를 .env(DATA_GO_KR_KEY=...) 또는
// 환경변수로 전달하세요. 미설정 시 자동으로 목업 데이터로 동작합니다.
// (이전의 하드코딩 키 c353ad08...는 유효하지 않은 가짜 키여서 제거)
const SERVICE_KEY = process.env.DATA_GO_KR_KEY || 'YOUR_DATA_GO_KR_KEY_HERE';

// OpenRouter (AI 채팅) — 키는 .env(OPENROUTER_API_KEY)에서만 읽고 브라우저엔 노출하지 않음
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

// Pi 에이전트 (헤드리스 CLI) — 웹 채팅이 Pi를 구동: 스킬 + 확장(MCP 툴 포함)
const PI_CLI = path.join(__dirname, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
const PI_MODEL = process.env.PI_MODEL || 'openai/gpt-mini-latest';

// ── 지역코드 매핑 ─────────────────────────────────────────────────────────────
const REGION_CODES = {
  '강남구': '11680',
  '서초구': '11650',
  '송파구': '11710',
  '강동구': '11740',
  '용산구': '11170',
  '마포구': '11440',
  '성동구': '11200',
  '광진구': '11215',
};

// ── 미들웨어 ──────────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Cache-Control', 'no-store');   // 개발 서버 — 브라우저가 옛 HTML 캐시하지 않도록
  next();
});

// ── 정적 파일 서빙 ────────────────────────────────────────────────────────────
// HTML 파일을 같은 폴더에 두거나 상위 폴더 경로 지정
const staticOpts = { cacheControl: false, etag: false, lastModified: false };
app.use(express.static(path.join(__dirname, '..'), staticOpts));
app.use(express.static(__dirname, staticOpts));

// 루트 접속 시 메인 HTML로 (http://localhost:3000 → 앱)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', '부동산_지도_에이전트.html'), { cacheControl: false }));

// ── 헬퍼: HTTPS POST(JSON) ────────────────────────────────────────────────────
function postJson(urlStr, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = url.parse(urlStr);
    const data = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: u.hostname, path: u.path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data); req.end();
  });
}

// ── 헬퍼: data.go.kr HTTP 요청 ────────────────────────────────────────────────
function fetchDataGo(apiUrl) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(apiUrl);
    const isHttps = parsed.protocol === 'https:';
    const requester = isHttps ? https : http;

    // ⚠️ data.go.kr 앞단 WAF는 User-Agent가 없는 요청(Node/​curl 기본)을 차단한다.
    // UA를 안 보내면 키·권한이 정상이어도 400 "Request Blocked"가 돌아온다.
    // 브라우저 UA를 실어 보내야 resultCode 000(OK)으로 실데이터가 떨어진다.
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/xml',
      },
    };

    const req = requester.get(apiUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.abort(); reject(new Error('Timeout')); });
  });
}

// ── 헬퍼: XML → JSON 변환 (간이) ─────────────────────────────────────────────
function parseAptTradeXml(xml) {
  try {
    const items = [];
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    itemMatches.forEach(item => {
      const get = (tag) => {
        const m = item.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`));
        return m ? m[1].trim() : '';
      };
      // 실제 apis.data.go.kr 응답은 영문 필드명을 사용한다.
      // (aptNm/dealAmount/umdNm/excluUseAr/buildYear/dealYear...) — 한글 태그는 구버전 폴백.
      const name  = get('aptNm')     || get('단지명') || get('아파트');
      const year  = get('dealYear')  || get('계약년도') || get('년');
      const month = get('dealMonth') || get('계약월') || get('월');
      const day   = get('dealDay')   || get('계약일') || get('일');
      items.push({
        apartmentName:  name,
        dong:           get('umdNm') || get('법정동'),
        area:           parseFloat(get('excluUseAr') || get('전용면적')) || 0,
        floor:          parseInt(get('floor') || get('층')) || 0,
        year:           parseInt(get('buildYear') || get('건축년도')) || 0,
        dealYear:       year,
        dealMonth:      month,
        dealDay:        day,
        amount:         (get('dealAmount') || get('거래금액')).replace(/,/g, '').replace(/\s/g, '').trim(),
        jibun:          get('jibun') || get('지번'),
        dealType:       get('dealingGbn') || get('거래유형') || '중개거래',
      });
    });

    // 결과 코드 확인
    const codeMatch = xml.match(/<resultCode>(\d+)<\/resultCode>/);
    const msgMatch  = xml.match(/<resultMsg>([^<]+)<\/resultMsg>/);
    const resultCode = codeMatch ? codeMatch[1] : '00';
    const resultMsg  = msgMatch  ? msgMatch[1]  : 'OK';

    return { resultCode, resultMsg, items };
  } catch (e) {
    return { resultCode: '99', resultMsg: e.message, items: [] };
  }
}

// ── API: 아파트 매매 실거래가 ─────────────────────────────────────────────────
/**
 * GET /api/apt-trade
 *
 * Query params:
 *  region  — 구 이름 (예: 강남구) 또는 법정동 코드 5자리
 *  ym      — 거래년월 YYYYMM (예: 202405), 기본값: 최근 3개월
 *  rows    — 반환 건수 (기본 30, 최대 100)
 *  name    — 단지명 필터 (선택)
 */
app.get('/api/apt-trade', async (req, res) => {
  const { region = '강남구', ym, rows = 30, name } = req.query;

  // 지역코드 결정
  const lawdCd = REGION_CODES[region] || region;

  // 년월 결정 (없으면 지난달 — 당월은 신고지연으로 거의 비어있음)
  const now = new Date();
  if (!ym) now.setMonth(now.getMonth() - 1);
  const dealYmd = ym || `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

  if (SERVICE_KEY === 'YOUR_DATA_GO_KR_KEY_HERE') {
    // API 키 미설정 시 목업 데이터 반환
    return res.json(mockAptTrade(region, dealYmd, name));
  }

  // 2024년 이후 신규 API 엔드포인트 (publicDataPk=15126468)
  const apiUrl =
    `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade` +
    `?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
    `&LAWD_CD=${lawdCd}` +
    `&DEAL_YMD=${dealYmd}` +
    `&numOfRows=${rows}` +
    `&pageNo=1`;

  try {
    const { status, body: raw } = await fetchDataGo(apiUrl);
    console.log(`[apt-trade] HTTP ${status} · ${region}(${lawdCd}) ${dealYmd}`);
    if (status === 401)
      return res.json({ ok:false, authError:401, message:'인증키가 인식되지 않습니다 (401). 키 값을 확인하세요.' });
    if (status === 403 || /SERVICE_KEY_IS_NOT_REGISTERED/i.test(raw) || /Forbidden/i.test(raw))
      return res.json({ ok:false, authError:403, message:'키는 유효하지만 이 API 사용 권한이 없습니다 (403). data.go.kr에서 "아파트 매매 실거래가" 활용신청 승인이 필요합니다.' });
    const parsed = parseAptTradeXml(raw);

    // 단지명 필터
    const items = name
      ? parsed.items.filter(i => i.apartmentName.includes(name))
      : parsed.items;

    // 통계 계산
    const amounts = items
      .map(i => parseInt(i.amount.replace(/\s/g, '')) || 0)
      .filter(n => n > 0);
    const avgPrice = amounts.length
      ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length)
      : 0;
    const maxPrice = amounts.length ? Math.max(...amounts) : 0;
    const minPrice = amounts.length ? Math.min(...amounts) : 0;

    res.json({
      ok: true,
      region,
      lawdCd,
      dealYmd,
      count: items.length,
      stats: { avgPrice, maxPrice, minPrice },
      items: items.slice(0, parseInt(rows)),
    });
  } catch (err) {
    console.error('[API 오류]', err.message);
    // 오류 시에도 목업 데이터로 폴백
    res.json({ ...mockAptTrade(region, dealYmd, name), fallback: true, error: err.message });
  }
});

// ── API: 최근 3개월 가격 추이 ─────────────────────────────────────────────────
/**
 * GET /api/apt-trend
 *
 * Query params:
 *  region  — 구 이름
 *  name    — 단지명
 *  months  — 조회 개월 수 (기본 3)
 */
app.get('/api/apt-trend', async (req, res) => {
  const { region = '강남구', name, months = 3 } = req.query;
  const lawdCd = REGION_CODES[region] || region;
  const results = [];

  for (let i = parseInt(months) - 1; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;

    if (SERVICE_KEY === 'YOUR_DATA_GO_KR_KEY_HERE') {
      results.push(mockMonthData(region, ym, name));
      continue;
    }

    try {
      const apiUrl =
        `https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade` +
        `?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
        `&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&numOfRows=100&pageNo=1`;

      const { body: raw } = await fetchDataGo(apiUrl);
      const { items } = parseAptTradeXml(raw);
      const filtered = name ? items.filter(i => i.apartmentName.includes(name)) : items;
      const amounts = filtered.map(i => parseInt(i.amount.replace(/\s/g, '')) || 0).filter(n => n > 0);
      const avg = amounts.length ? Math.round(amounts.reduce((a, b) => a + b) / amounts.length) : 0;
      results.push({ ym, avg, count: filtered.length });
    } catch {
      results.push(mockMonthData(region, ym, name));
    }
  }

  res.json({ ok: true, region, name, trend: results });
});

// ── API: 지역코드 목록 ────────────────────────────────────────────────────────
app.get('/api/regions', (req, res) => {
  res.json({ ok: true, regions: Object.keys(REGION_CODES) });
});

// ── API: 서버 상태 ────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    apiKeySet: SERVICE_KEY !== 'YOUR_DATA_GO_KR_KEY_HERE',
    chatEnabled: !!OPENROUTER_KEY,
    agentEnabled: !!OPENROUTER_KEY,
    regions: Object.keys(REGION_CODES),
    time: new Date().toISOString(),
  });
});

// ── API: AI 채팅 (OpenRouter 프록시) ──────────────────────────────────────────
// POST /api/chat  { message, context?, history? } → { ok, reply }
// 키는 서버 .env에만 있고 응답엔 절대 포함하지 않음.
app.post('/api/chat', async (req, res) => {
  const { message = '', context = '', history = [] } = req.body || {};
  if (!OPENROUTER_KEY)
    return res.json({ ok: false, reply: '⚠️ AI 채팅 키(OPENROUTER_API_KEY)가 설정되지 않았습니다. real-estate-agent/.env를 확인하세요.' });
  if (!String(message).trim())
    return res.json({ ok: false, reply: '질문을 입력해 주세요.' });

  const system =
`당신은 한국 부동산(특히 서울) 실거래가 분석을 돕는 친절한 AI 에이전트 'Pi'입니다.
- 사용자가 보고 있는 지도의 실거래가 데이터를 근거로 간결하고 실용적으로 답합니다.
- 가격은 '억' 단위로 표현하고 핵심만 짚어 한국어로 답합니다.
- 데이터에 없는 내용은 모른다고 말하고, 단정적 투자 권유나 예측은 피합니다.
- 답변은 5문장 이내로 짧게, 필요하면 불릿으로 정리합니다.` +
    (context ? `\n\n[현재 지도에 로딩된 실거래가 데이터]\n${context}` : '');

  const messages = [
    { role: 'system', content: system },
    ...(Array.isArray(history) ? history.slice(-6) : []),
    { role: 'user', content: String(message) },
  ];

  try {
    const { status, body } = await postJson(
      'https://openrouter.ai/api/v1/chat/completions',
      { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Real Estate Map Agent' },
      { model: OPENROUTER_MODEL, messages, max_tokens: 700, temperature: 0.4 },
    );
    let data; try { data = JSON.parse(body); } catch { data = {}; }
    if (status >= 400)
      return res.json({ ok: false, reply: `AI 오류 (${status}): ${data.error?.message || '알 수 없는 오류'}` });
    const reply = data.choices?.[0]?.message?.content?.trim() || '(빈 응답)';
    console.log(`[chat] ${OPENROUTER_MODEL} · ${data.usage?.total_tokens || '?'} tokens`);
    res.json({ ok: true, reply, model: OPENROUTER_MODEL });
  } catch (e) {
    console.error('[chat 오류]', e.message);
    res.json({ ok: false, reply: 'AI 호출 실패: ' + e.message });
  }
});

// ── API: Pi 에이전트 (헤드리스 구동) ──────────────────────────────────────────
// POST /api/agent { message, hint? } → { ok, reply }
// 웹 채팅이 Pi 에이전트를 구동한다. 에이전트는 스킬(skills/) + 확장(extensions/) 자동 로드,
// 확장의 search_transactions 툴이 MCP 서버(data.go.kr)에 연결되어 실거래가를 가져온다.
app.post('/api/agent', (req, res) => {
  const { message = '', hint = '' } = req.body || {};
  if (!OPENROUTER_KEY)
    return res.json({ ok: false, reply: '⚠️ OPENROUTER_API_KEY가 설정되지 않았습니다 (.env 확인).' });
  if (!String(message).trim())
    return res.json({ ok: false, reply: '질문을 입력해 주세요.' });

  const prompt = hint ? `(참고: ${hint})\n\n${message}` : String(message);
  const args = [PI_CLI, '-p', '--mode', 'text', '--provider', 'openrouter', '--model', PI_MODEL, prompt];

  // ⚠️ stdin을 'ignore'로 닫아야 함: Pi CLI는 비-TTY stdin을 입력으로 읽으려 대기하므로
  // 열린 파이프(execFile 기본)면 EOF를 못 받아 타임아웃까지 멈춘다.
  const child = spawn('node', args, {
    cwd: __dirname,
    env: { ...process.env, OPENROUTER_API_KEY: OPENROUTER_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', errOut = '', done = false;
  const finish = (payload) => { if (done) return; done = true; clearTimeout(killer); res.json(payload); };
  const killer = setTimeout(() => { child.kill('SIGKILL'); }, 90000);

  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { errOut += d; });
  child.on('error', (e) => finish({ ok: false, reply: '에이전트 실행 오류: ' + e.message }));
  child.on('close', (code) => {
    const reply = out.trim();
    if (!reply) {
      console.error(`[agent 오류] code=${code}`, errOut.slice(0, 300));
      return finish({ ok: false, reply: code === null
        ? '에이전트 응답 시간이 초과됐어요. 질문을 짧게 해서 다시 시도해 주세요.'
        : '에이전트가 응답을 내지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
    console.log(`[agent] pi(${PI_MODEL}) 응답 ${reply.length}자`);
    finish({ ok: true, reply, via: 'pi-agent', model: PI_MODEL });
  });
});

// ── 목업 데이터 ───────────────────────────────────────────────────────────────
const MOCK_APTS = [
  { name: '래미안 도곡 카운티', area: 84, floor: 15, year: 2007, basePrice: 98000 },
  { name: '개포래미안포레스트',  area: 84, floor: 12, year: 2019, basePrice: 92000 },
  { name: '대치아이파크',        area: 84, floor: 8,  year: 2011, basePrice: 87000 },
  { name: '역삼센트럴아이파크',  area: 84, floor: 10, year: 2018, basePrice: 95000 },
  { name: '도곡렉슬',            area: 59, floor: 6,  year: 2006, basePrice: 74000 },
  { name: '대치삼성래미안',      area: 99, floor: 18, year: 2005, basePrice: 115000 },
];

function mockAptTrade(region, ym, nameFilter) {
  const items = [];
  const [y, m] = [parseInt(ym.slice(0, 4)), parseInt(ym.slice(4, 6))];

  MOCK_APTS.forEach(apt => {
    if (nameFilter && !apt.name.includes(nameFilter)) return;
    const count = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < count; i++) {
      const variance = (Math.random() - 0.5) * 5000;
      const amount = apt.basePrice + Math.round(variance);
      items.push({
        apartmentName: apt.name,
        dong: region.replace('구', '동'),
        area: apt.area,
        floor: apt.floor + Math.floor(Math.random() * 5),
        year: apt.year,
        dealYear: String(y),
        dealMonth: String(m),
        dealDay: String(Math.floor(Math.random() * 28) + 1),
        amount: String(amount),
        jibun: `${Math.floor(Math.random() * 500) + 1}`,
        dealType: Math.random() > 0.7 ? '직거래' : '중개거래',
      });
    }
  });

  items.sort((a, b) => parseInt(b.amount) - parseInt(a.amount));
  const amounts = items.map(i => parseInt(i.amount));
  const avgPrice = amounts.length ? Math.round(amounts.reduce((a, b) => a + b) / amounts.length) : 0;

  return {
    ok: true, mock: true, region, dealYmd: ym, count: items.length,
    stats: { avgPrice, maxPrice: Math.max(...amounts), minPrice: Math.min(...amounts) },
    items,
  };
}

function mockMonthData(region, ym, name) {
  const apt = MOCK_APTS.find(a => name && a.name.includes(name)) || MOCK_APTS[0];
  const variance = (Math.random() - 0.4) * 3000;
  return { ym, avg: apt.basePrice + Math.round(variance), count: Math.floor(Math.random() * 5) + 1 };
}

// ── 서버 시작 ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  🏠 부동산 AI 에이전트 서버 시작');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  if (SERVICE_KEY === 'YOUR_DATA_GO_KR_KEY_HERE') {
    console.log('  ⚠️  data.go.kr API 키가 설정되지 않았습니다.');
    console.log('  목업 데이터로 동작 중입니다.');
    console.log('');
    console.log('  API 키 발급:');
    console.log('  https://www.data.go.kr/data/15057511/openapi.do');
    console.log('  → 활용신청 → 일반 인증키 (무료, 즉시 발급)');
    console.log('');
    console.log('  키 설정 방법:');
    console.log('  DATA_GO_KR_KEY=발급받은키 node server.js');
  } else {
    console.log('  ✅ data.go.kr API 키 확인됨');
  }
  console.log('');
});
