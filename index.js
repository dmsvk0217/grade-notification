// grade-notifier/index.js
// ------------------------------------------------------------
// School grade watcher & SMS notifier (Node.js + Puppeteer + Twilio)
// ------------------------------------------------------------
// How to use
// 1. Copy this file into your project root as index.js (or keep path).
// 2. Create a `.env` file alongside it with the keys listed below.
// 3. Run `npm i` to install dependencies (see package.json template at
//    bottom of this file).
// 4. Execute once with `node index.js`, or deploy to Render and add a
//    Scheduled Job that runs `node index.js` at your desired cadence.
// ------------------------------------------------------------

require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs/promises");
const path = require("path");
const twilio = require("twilio");

const { SCHOOL_ID, SCHOOL_PW, TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO } = process.env;

if (!SCHOOL_ID || !SCHOOL_PW) {
  console.error("❌  SCHOOL_ID / SCHOOL_PW is missing. Check your .env");
  process.exit(1);
}
if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_FROM || !TWILIO_TO) {
  console.error("❌  Twilio credentials or phone numbers are missing. Check your .env");
  process.exit(1);
}

//-----------------------------------------------------------------------
// URLs & selectors (change if the school changes HTML structure)
//-----------------------------------------------------------------------
const urls = {
  login: "https://hisnet.handong.edu/login/login.php",
  loginFail: "https://hisnet.handong.edu/login/_login.php",
  home: "https://hisnet.handong.edu/haksa/record/HREC130M.php",
};

const xpaths = {
  id: "#loginBoxBg > table:nth-child(2) > tbody > tr > td:nth-child(5) > form > table > tbody > tr:nth-child(3) > td > table > tbody > tr > td:nth-child(1) > table > tbody > tr:nth-child(1) > td:nth-child(2) > span > input[type=text]",
  password:
    "#loginBoxBg > table:nth-child(2) > tbody > tr > td:nth-child(5) > form > table > tbody > tr:nth-child(3) > td > table > tbody > tr > td:nth-child(1) > table > tbody > tr:nth-child(3) > td:nth-child(2) > input[type=password]",
  login:
    "#loginBoxBg > table:nth-child(2) > tbody > tr > td:nth-child(5) > form > table > tbody > tr:nth-child(3) > td > table > tbody > tr > td:nth-child(2) > input[type=image]",
  gradeRows: "#att_list tr",
};

//-----------------------------------------------------------------------
// 1️⃣ 로그인 기능
//-----------------------------------------------------------------------
async function login(page, id, pw) {
  await page.goto(urls.login, { waitUntil: "networkidle2" });
  await page.type(xpaths.id, id, { delay: 25 });
  await page.type(xpaths.password, pw, { delay: 25 });

  await Promise.all([
    page.click(xpaths.login),
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }),
  ]);

  if ([urls.login, urls.loginFail].includes(page.url())) {
    throw new Error("LOGIN_FAILED");
  }
}

//-----------------------------------------------------------------------
// 2️⃣  성적 테이블 스크래핑
//-----------------------------------------------------------------------
async function scrapeTable(page) {
  await page.goto(urls.home, { waitUntil: "networkidle2" });

  let grades = await page.evaluate(() => {
    const table = document.getElementById("att_list");
    const rows = table.querySelectorAll("tr");
    return Array.from(rows, (row) => {
      const cells = row.querySelectorAll("td");
      return Array.from(cells, (cell) => cell.innerText.trim());
    });
  });

  grades = grades.slice(1);
  console.table(grades);
  return grades;
}

//-----------------------------------------------------------------------
// 3️⃣  성적 테이블 저장 (JSON 파일 사용)
//-----------------------------------------------------------------------
const DATA_FILE = path.join(process.cwd(), "grades.json");

async function loadStoredTable() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

async function saveTable(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

//-----------------------------------------------------------------------
// 4️⃣  저장된 테이블과 스크래핑한 테이블 비교하기
//-----------------------------------------------------------------------
function diffTables(oldTable, newTable) {
  return newTable.filter((newItem) => {
    const oldItem = oldTable.find((old) => old[2] === newItem[2]);
    return oldItem && oldItem[7] !== newItem[7];
  });
}

//-----------------------------------------------------------------------
// 5️⃣  업데이트된 과목명을 문자로 전송하기 (Twilio)
//-----------------------------------------------------------------------
async function sendUpdatedSubjectsSMS(subjects) {
  if (!subjects.length) return;

  const client = twilio(TWILIO_SID, TWILIO_AUTH);
  const messageBody = `[성적 업데이트] ${subjects.map((subject) => subject[2]).join(", ")}`;

  const msg = await client.messages.create({
    body: messageBody,
    from: TWILIO_FROM,
    to: TWILIO_TO,
  });
  console.log("✅  SMS sent:", msg.sid);
}

//-----------------------------------------------------------------------
// 🎬  전체 오케스트레이션
//-----------------------------------------------------------------------
async function runOnce() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  try {
    page.on("console", (msg) => {
      console.log("[브라우저 콘솔]", msg.text());
    });

    await login(page, SCHOOL_ID, SCHOOL_PW);

    const scraped = await scrapeTable(page);
    const stored = await loadStoredTable();

    const diff = diffTables(stored, scraped);
    if (diff.length) {
      await saveTable(scraped);
      await sendUpdatedSubjectsSMS(diff);
    } else {
      console.log("ℹ️  No new grades detected.");
    }
  } catch (err) {
    if (err.message === "LOGIN_FAILED") {
      console.error("❌  학번/비밀번호 오류 – 로그인 실패");
    } else {
      console.error("❌  Unexpected error:", err);
    }
  } finally {
    await page.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------
// 🚀  entrypoint: Run immediately (Render job) OR via cron locally
// ---------------------------------------------------------------------
if (require.main === module) {
  runOnce();
}

// ---------------------------------------------------------------------
// 📝  Render 배포 메모
// ---------------------------------------------------------------------
// 1. GitHub repo에 이 코드와 package.json, .env.example 업로드
// 2. Render → New Web Service → 연결 (환경변수 탭에 .env 값 입력)
// 3. Web Service 대신 "Background Worker" 선택
//    - Start command: `node index.js`
//    - 자동 재시작 Enabled
// 4. 주기 실행: DashBoard > Jobs > Add Job > Cron 표현식, Command `node index.js`
//    예: 매일 08:00 AM (Asia/Seoul) → Cron `0 23 * * *`  (Render는 UTC 기준)
// ---------------------------------------------------------------------
