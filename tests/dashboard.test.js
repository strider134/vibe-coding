const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createDashboard() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};

  function createElement(id = "") {
    return {
      id,
      value: "",
      textContent: "",
      innerHTML: "",
      className: "",
      min: "",
      max: "",
      children: [],
      listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; }
    };
  }

  const document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement() { return createElement(); }
  };
  const context = vm.createContext({ document, Intl, TextDecoder, Date, Number, Math, Set, Map });
  vm.runInContext(script, context);
  return { context, elements, evaluate: code => vm.runInContext(code, context) };
}

const validCSV = [
  "platform,date,content,likes,comments,views",
  'Instagram,2026-11-01,"新品, 正式发布",100,10,1000',
  'TikTok,2026-11-02,"一句带有""引号""的内容",200,20,2000',
  "YouTube,2026-11-03,浏览量为零,30,5,0"
].join("\r\n");

test("默认演示数据和 KPI 保持可用", () => {
  const { elements } = createDashboard();
  assert.equal(elements.postCount.textContent, "10");
  assert.equal(elements.likeCount.textContent, "167,540");
  assert.equal(elements.commentCount.textContent, "7,120");
  assert.equal(elements.averageEngagementRate.textContent, "7.52%");
  assert.match(elements.dataStatus.textContent, /10 条模拟演示数据/);
});

test("解析 UTF-8 BOM、CRLF、逗号和转义引号", () => {
  const { context } = createDashboard();
  context.csv = `\uFEFF${validCSV}`;
  const result = vm.runInContext("parseCSV(csv)", context);
  assert.equal(result.length, 3);
  assert.equal(result[0].content, "新品, 正式发布");
  assert.equal(result[1].content, '一句带有"引号"的内容');
  assert.equal(result[2].views, 0);
});

test("拒绝空文件、缺少字段、无效日期和异常数值", () => {
  const { context } = createDashboard();
  const invalidCases = [
    ["", /CSV 文件为空/],
    ["platform,date,content,likes,comments\nInstagram,2026-11-01,a,1,2", /缺少必需字段：views/],
    ["platform,date,content,likes,comments,views\nInstagram,2026-02-30,a,1,2,3", /date 无效/],
    ["platform,date,content,likes,comments,views\nInstagram,2026-11-01,a,abc,2,3", /likes 必须是有效整数/],
    ["platform,date,content,likes,comments,views\nInstagram,2026-11-01,a,-1,2,3", /likes 不能小于 0/]
  ];
  invalidCases.forEach(([csv, pattern]) => {
    context.csv = csv;
    assert.throws(() => vm.runInContext("parseCSV(csv)", context), pattern);
  });
});

test("互动率排除 views 小于等于零、缺失或无效的帖子", () => {
  const { context } = createDashboard();
  context.samples = [
    { likes: 90, comments: 10, views: 1000 },
    { likes: 10, comments: 5, views: 0 },
    { likes: 10, comments: 5, views: -10 },
    { likes: 10, comments: 5 },
    { likes: 10, comments: 5, views: Number.NaN }
  ];
  const rates = vm.runInContext("samples.map(getEngagementRate)", context);
  assert.deepEqual(Array.from(rates), [10, null, null, null, null]);
});

test("上传后替换数据并按平台和日期同步更新 KPI 与趋势图", async () => {
  const { context, elements, evaluate } = createDashboard();
  const bytes = new TextEncoder().encode(validCSV);
  const event = {
    target: {
      files: [{ name: "analytics.csv", size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }],
      value: "analytics.csv"
    }
  };
  const upload = evaluate("handleUpload");
  await upload(event);

  assert.equal(elements.postCount.textContent, "3");
  assert.equal(elements.likeCount.textContent, "330");
  assert.equal(elements.commentCount.textContent, "35");
  assert.equal(elements.averageEngagementRate.textContent, "11.00%");
  assert.match(elements.dataStatus.textContent, /1 条因浏览量不大于 0/);
  assert.match(elements.trendChart.innerHTML, /<svg/);

  elements.platformFilter.value = "Instagram";
  evaluate("render()");
  assert.equal(elements.postCount.textContent, "1");
  assert.equal(elements.averageEngagementRate.textContent, "11.00%");

  elements.platformFilter.value = "";
  elements.dateFrom.value = "2026-11-02";
  elements.dateTo.value = "2026-11-03";
  evaluate("render()");
  assert.equal(elements.postCount.textContent, "2");
  assert.equal(elements.likeCount.textContent, "230");
  assert.equal(elements.averageEngagementRate.textContent, "11.00%");
});

test("无有效互动率时显示 N/A，错误上传不替换现有数据", async () => {
  const { context, elements, evaluate } = createDashboard();
  evaluate("posts = [{ platform: 'Test', date: '2026-11-01', content: 'zero', likes: 1, comments: 1, views: 0 }]; syncFilters(); render();");
  assert.equal(elements.averageEngagementRate.textContent, "N/A");

  const invalid = new TextEncoder().encode("platform,date\nTest,2026-11-01");
  const upload = evaluate("handleUpload");
  await upload({ target: { files: [{ name: "bad.csv", size: invalid.byteLength, arrayBuffer: async () => invalid.buffer }], value: "bad.csv" } });
  assert.equal(elements.postCount.textContent, "1");
  assert.match(elements.dataStatus.textContent, /导入失败：CSV 缺少必需字段/);
});

test("拒绝非 UTF-8 文件并显示清晰提示", async () => {
  const { elements, evaluate } = createDashboard();
  const invalidUTF8 = Uint8Array.from([0xff, 0xfe, 0xfd]);
  const upload = evaluate("handleUpload");
  await upload({ target: { files: [{ name: "legacy.csv", size: invalidUTF8.byteLength, arrayBuffer: async () => invalidUTF8.buffer }], value: "legacy.csv" } });
  assert.equal(elements.postCount.textContent, "10");
  assert.match(elements.dataStatus.textContent, /文件不是有效的 UTF-8 编码/);
});
