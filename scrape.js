const { chromium } = require("playwright");
const fs = require("fs");

const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwpaT9ttink4eLweVhZLLlfu3a9CdhrGXhZsQk7eFDkHiHa1kSNZXsW-_qzmXOXiY6lyA/exec";

// GitHub Actions (Linux) に必要な最小限のフラグ
// --single-process は使わない（Linuxでプロセス分離が崩れてクラッシュ増加）
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage", // GitHub Actions の /dev/shm は 64MB 固定なので必須
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
  "--disable-extensions",
];

// Chrome 131 (2024年末) に合わせた UA
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const KEYWORDS = [
  "シリコンラップ",
  "バスボム",
  "バランスボード",
  "ベビーバスローブ",
  "メッシュキャップ",
  "ベビー食器",
  "ベビーカトラリー",
  "赤ちゃん食器",
  "ベビーヘルメット",
  "シリコン食器",
  "ベビーサークル",
  "ベッドガード",
  "ベビーモニター",
  "搾乳機",
];

// =========================================
// ユーティリティ
// =========================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// min〜max のランダム整数ミリ秒
function randMs(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function createBrowser() {
  return chromium.launch({ headless: true, args: BROWSER_ARGS });
}

// =========================================
// ナビゲーション（最大3回リトライ）
// 失敗時は例外を投げず false を返す
// =========================================
async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log(`  [RETRY ${attempt}/3] ${e.message.slice(0, 100)}`);
      if (attempt < 3) await sleep(attempt * 6000); // 6s → 12s
    }
  }
  return false;
}

// =========================================
// DOM解析を1回の evaluate に集約
// ブラウザ←→Node間の IPC 往復を N×5 → 1 に削減
// =========================================
function extractProducts(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-component-type="s-search-result"]')
    ).map(el => ({
      asin:  el.getAttribute("data-asin") || "",
      text:  el.innerText || "",
      title: el.querySelector("h2 span")?.innerText?.trim() || "",
      href:  el.querySelector("h2 a")?.getAttribute("href") || "",
      price: el.querySelector(".a-price .a-offscreen")?.innerText?.trim() || "",
    }))
  );
}

// =========================================
// 1キーワード分のスクレイピング
// browser.newContext() で Cookie・Storage を完全分離
// （キーワード間でAmazonのセッション情報が汚染されない）
// =========================================
async function scrapeKeyword(browser, keyword, asinMap) {
  // キーワードごとに新しいコンテキスト（= 新しいブラウザセッション）
  const context = await browser.newContext({
    viewport:  { width: 1366, height: 768 },
    userAgent: USER_AGENT,
    extraHTTPHeaders: {
      "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  try {
    const page = await context.newPage();

    let pageCrashed = false;
    page.on("crash", () => {
      pageCrashed = true;
      console.log(`  [PAGE CRASH] ${keyword}`);
    });

    // ナビゲーション
    const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}`;
    const navOk = await gotoWithRetry(page, url);

    if (!navOk || pageCrashed) {
      return { status: "nav_failed" };
    }

    // 商品カードが出現するまで待つ（盲目的 sleep より確実）
    // CAPTCHA や 0件の場合はタイムアウトして catch → そのまま続行
    await page
      .waitForSelector('[data-component-type="s-search-result"]', { timeout: 15000 })
      .catch(() => {});

    // 人間らしいランダム待機（1〜3秒）
    await sleep(randMs(1000, 3000));

    const rawProducts = await extractProducts(page);

    if (rawProducts.length === 0) {
      const html = await page.content().catch(() => "");
      const isBlocked =
        html.includes("captcha") ||
        html.includes("CAPTCHA") ||
        html.includes("Robot Check") ||
        html.includes("ap_captcha");
      return { status: isBlocked ? "blocked" : "empty" };
    }

    // ========== 商品データ集計 ==========
    let adRank = 0;
    let organicRank = 0;
    let overallRank = 0;

    for (const p of rawProducts) {
      if (!p.asin) continue;

      overallRank++;

      const sponsored =
        p.text.includes("スポンサー") ||
        p.text.includes("Sponsored") ||
        p.text.includes("広告");

      if (sponsored) adRank++;
      else organicRank++;

      const ratingMatch = p.text.match(/([0-5]\.?[0-9]?)\s*5つ星/);
      const reviewMatch = p.text.match(/([\d,]+)\s*件の評価/);
      const key = `${keyword}_${p.asin}`;

      if (!asinMap[key]) {
        asinMap[key] = {
          date: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
          keyword,
          asin:        p.asin,
          title:       p.title,
          productUrl:  p.href ? "https://www.amazon.co.jp" + p.href : "",
          price:       p.price,
          reviewCount: reviewMatch ? reviewMatch[1].replace(/,/g, "") : "",
          rating:      ratingMatch ? ratingMatch[1] : "",
          overallRank: "",
          adRank:      "",
          organicRank: "",
        };
      }

      asinMap[key].overallRank = overallRank;
      if (sponsored) {
        if (!asinMap[key].adRank) asinMap[key].adRank = adRank;
      } else {
        if (!asinMap[key].organicRank) asinMap[key].organicRank = organicRank;
      }
    }

    return { status: "ok", count: rawProducts.length };

  } finally {
    // コンテキストを閉じると配下のページも全て閉じられる
    await context.close().catch(() => {});
  }
}

// =========================================
// メイン処理
// =========================================
async function runScraper() {
  let browser = await createBrowser();
  const asinMap = {};
  const statusMap = {};

  for (const keyword of KEYWORDS) {
    console.log(`\n[${keyword}] 開始`);

    try {
      // ブラウザがクラッシュ済みなら作り直す
      if (!browser.isConnected()) {
        console.log("  [BROWSER] 切断検知 → 再生成");
        browser = await createBrowser();
      }

      const result = await scrapeKeyword(browser, keyword, asinMap);
      statusMap[keyword] = result.status;

      // ステータス別ログとブラウザリセット判定
      if (result.status === "ok") {
        console.log(`  → ${result.count}件取得`);

      } else if (result.status === "blocked") {
        console.log("  [WARN] CAPTCHA / ブロック検知 → ブラウザ再生成");
        try { await browser.close(); } catch {}
        browser = await createBrowser();

      } else if (result.status === "empty") {
        console.log("  [WARN] 商品0件（検索結果なし）");

      } else if (result.status === "nav_failed") {
        console.log("  [SKIP] ナビゲーション失敗 → ブラウザ再生成");
        try { await browser.close(); } catch {}
        browser = await createBrowser();
      }

    } catch (e) {
      // 予期しないエラー（browser.newContext 失敗など）
      console.log(`  [ERROR] ${e.message}`);
      statusMap[keyword] = "error";
      try { await browser.close(); } catch {}
      browser = await createBrowser();
    }

    // =============================
    // Amazon への連続リクエスト対策
    // 全パス（成功・失敗問わず）で必ず待機する
    // =============================
    await sleep(randMs(3000, 6000));
  }

  try { await browser.close(); } catch {}

  // ========== サマリーログ ==========
  const rows = Object.values(asinMap);
  const succeeded = Object.values(statusMap).filter(s => s === "ok").length;
  const failedKeys = Object.entries(statusMap)
    .filter(([, s]) => s !== "ok")
    .map(([k, s]) => `${k}(${s})`);

  console.log("\n========== 実行結果 ==========");
  console.log(`成功: ${succeeded} / ${KEYWORDS.length} キーワード`);
  if (failedKeys.length > 0) {
    console.log(`失敗: ${failedKeys.join(", ")}`);
  }

  if (rows.length === 0) {
    console.error("[FATAL] 全キーワードで取得失敗。Amazonブロックの可能性があります。");
    process.exit(1);
  }

  // ========== CSV出力 ==========
  let csv =
    "date,keyword,asin,title,url,price,reviewCount,rating,overallRank,adRank,organicRank\n";

  for (const r of rows) {
    csv +=
      `"${r.date}",` +
      `"${r.keyword}",` +
      `"${r.asin}",` +
      `"${(r.title || "").replace(/"/g, '""')}",` +
      `"${r.productUrl}",` +
      `"${r.price}",` +
      `"${r.reviewCount}",` +
      `"${r.rating}",` +
      `"${r.overallRank}",` +
      `"${r.adRank}",` +
      `"${r.organicRank}"\n`;
  }

  fs.writeFileSync("result.csv", csv, "utf8");
  console.log(`CSV出力: ${rows.length}件`);

  await sendToGAS(rows);
  console.log("全処理完了");
}

// =========================================
// GAS送信（最大3回リトライ）
// =========================================
async function sendToGAS(rows) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rows),
      });
      console.log("GAS送信完了:", (await res.text()).slice(0, 200));
      return;
    } catch (e) {
      console.log(`GAS送信失敗 (${attempt}/3): ${e.message}`);
      if (attempt < 3) await sleep(attempt * 8000); // 8s → 16s
    }
  }
  console.log("[WARN] GAS送信が全て失敗しました（データはCSVに保存済み）");
}

// =========================================
// エントリーポイント
// =========================================
runScraper().catch(e => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
