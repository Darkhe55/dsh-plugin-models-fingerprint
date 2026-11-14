/**
 * Offline fixed-probe plan. This module only defines prompts and validates
 * imported results. It never calls an LLM; a real collection run must still ask
 * for confirm=true and is deliberately outside this command.
 */
export const PROBE_PLAN_VERSION = 1

export const PROBE_CATEGORIES = Object.freeze([
  {
    id: 'tokenizer',
    title: 'Tokenizer 边界',
    prompts: [
      '仅输出下面字符串的字符数：中文𠮷émoji🙂混合123',
      '把“人工智能模型指纹”逐字拆成字符，用空格连接',
      '统计以下文本的 UTF-8 字节数和 Unicode 字符数：a中🙂\u0301',
      '只输出 tokenizer 测试：Ĳǅǈǋǲ ﬀ ﬁ ﬂ',
      '以下哪个更长？输出 A 或 B：A=“🙂🙂🙂” B=“中中中”',
    ],
  },
  {
    id: 'short',
    title: '短文本',
    prompts: [
      '用一句话解释什么是模型指纹。',
      '回答“2+2=？”只给数字。',
      '把“今天天气很好”翻译成英文。',
      '列出三种常见排序算法。',
      '用不超过十个字总结：证据优先于猜测。',
    ],
  },
  {
    id: 'reasoning',
    title: 'Reasoning',
    prompts: [
      '一个盒子里有 3 个红球和 2 个蓝球，不放回取两次，求两次都是红球的概率。',
      '若所有 A 都是 B，有些 B 是 C，能否推出有些 A 是 C？说明理由。',
      '计算 17×23，并写出中间步骤。',
      '有 8 枚外观相同的硬币，其中一枚较轻，用天平两次找出它。',
      '解释为什么在存在未观测混杂时相关性不等于因果。',
    ],
  },
  {
    id: 'json',
    title: 'JSON',
    prompts: [
      '输出 JSON：{"name":"alpha","count":3,"tags":["a","b"]}',
      '把“张三，30 岁，工程师”转成 JSON 对象。',
      '输出一个包含三个数组的 JSON，键名分别为 a、b、c。',
      '修复 JSON：{name: "x", ok: true,}',
      '输出 JSON schema，描述一个包含 id 和 title 的对象。',
    ],
  },
  {
    id: 'code',
    title: '代码',
    prompts: [
      '写一个 JavaScript 函数，返回数组中的最大值。',
      '用 Python 实现二分查找。',
      '写一个 SQL 查询，统计每个用户的订单数。',
      '用 Rust 写一个函数，判断字符串是否为回文。',
      '用 Go 写一个 HTTP handler，返回 {"ok":true}。',
    ],
  },
  {
    id: 'tool',
    title: '工具调用',
    prompts: [
      '请调用天气工具查询北京今天的天气。',
      '请调用计算器工具计算 12345×678。',
      '请调用搜索工具查找“DSH”的定义。',
      '请调用文件工具读取 README.md 的第一行。',
      '请调用日历工具创建明天 10 点的提醒。',
    ],
  },
])

export function buildProbePlan({ models = [], repeats = 10, windows = ['w1', 'w2'] } = {}) {
  const prompts = []
  for (const category of PROBE_CATEGORIES) {
    for (let index = 0; index < category.prompts.length; index += 1) {
      prompts.push({
        id: category.id + '-' + String(index + 1).padStart(2, '0'),
        category: category.id,
        title: category.title,
        prompt: category.prompts[index],
        repeats: Math.max(1, Number(repeats) || 10),
        windows: windows.slice(),
      })
    }
  }
  const perModel = prompts.reduce((sum, prompt) => sum + prompt.repeats * prompt.windows.length, 0)
  return {
    schema: 'model-fingerprint-probe-plan/v' + PROBE_PLAN_VERSION,
    version: PROBE_PLAN_VERSION,
    generatedAt: new Date().toISOString(),
    callPolicy: 'offline-only',
    automaticProviderCalls: false,
    confirmRequired: true,
    models: models.map((model) => ({ provider: model.provider, model: model.model, label: model.label || model.model })),
    categories: PROBE_CATEGORIES.map((category) => ({ id: category.id, title: category.title, prompts: category.prompts.length })),
    repeats: Math.max(1, Number(repeats) || 10),
    windows: windows.slice(),
    prompts,
    totals: {
      prompts: prompts.length,
      categories: PROBE_CATEGORIES.length,
      perModel,
      allModels: perModel * Math.max(1, models.length),
    },
    collectionProtocol: {
      runEachPrompt: 'repeats per prompt per time window',
      timeWindows: windows.slice(),
      sessionHeldOut: true,
      noAutomaticCall: true,
      nextStep: 'collect outside the plugin and import the resulting behavior rows with validateProbeResults',
    },
  }
}

export function validateProbeResults(plan, rows) {
  const accepted = []
  const rejected = []
  const promptIds = new Set((plan && plan.prompts || []).map((prompt) => prompt.id))
  for (const row of Array.isArray(rows) ? rows : []) {
    const reasons = []
    if (!row || !row.provider || !row.model) reasons.push('route-missing')
    if (!row || !row.promptId || !promptIds.has(row.promptId)) reasons.push('unknown-prompt')
    if (!row || !row.window) reasons.push('window-missing')
    if (!row || !Number.isFinite(Number(row.repeat))) reasons.push('repeat-missing')
    if (!row || !row.behavior) reasons.push('behavior-missing')
    if (reasons.length) rejected.push({ row, reasons })
    else accepted.push(row)
  }
  return { accepted, rejected, acceptedCount: accepted.length, rejectedCount: rejected.length }
}
