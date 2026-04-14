/**
 * @file src/ai/glm-parser.ts
 * @description GLM-4-Flash AI 任务解析服务核心模块
 *
 * 职责：
 *  1. 将用户自然语言任务输入解析为四字段结构化 JSON
 *  2. 三重防护保障输出稳定性：
 *     ① Prompt 约束（System Prompt + 8 个 Few-shot 示例 + 输出自检指令）
 *     ② 后端修复层（枚举别名修复、markdown 剥离、"null"字符串处理）
 *     ③ 自动重试最多 2 次（指数退避）+ GLM-4-Air Fallback
 *  3. 规则引擎兜底（两次重试全部失败时返回基础解析结果，绝不抛出崩溃）
 *
 * 环境变量（必填）：
 *  - GLM_API_KEY         : 智谱AI API Key
 *
 * 环境变量（可选）：
 *  - GLM_API_BASE_URL    : 默认 https://open.bigmodel.cn/api/paas/v4
 *  - GLM_PRIMARY_MODEL   : 默认 glm-4-flash
 *  - GLM_FALLBACK_MODEL  : 默认 glm-4-air
 *  - GLM_TIMEOUT_MS      : 单次调用超时，默认 8000ms
 *
 * @author ai-engineer
 * @stage  第5阶段 - 实际开发 Sprint
 */

import {
  type Category,
  type GlmChatResponse,
  type GlmErrorResponse,
  ParseError,
  type ParseOptions,
  type ParsedTask,
  type Priority,
  type RawGlmOutput,
} from '../types/ai.js';

// ─────────────────────────────────────────────
// 配置常量（从环境变量读取，绝不硬编码）
// ─────────────────────────────────────────────

const CONFIG = {
  apiKey: process.env.GLM_API_KEY ?? '',
  baseUrl:
    process.env.GLM_API_BASE_URL ??
    'https://open.bigmodel.cn/api/paas/v4',
  primaryModel: process.env.GLM_PRIMARY_MODEL ?? 'glm-4-flash',
  fallbackModel: process.env.GLM_FALLBACK_MODEL ?? 'glm-4-air',
  timeoutMs: parseInt(process.env.GLM_TIMEOUT_MS ?? '8000', 10),
  maxRetries: 2,           // 含 Fallback 切换，最多重试 2 次
  retryBaseDelayMs: 500,   // 首次重试等待 500ms，第二次 1000ms（指数退避）
} as const;

// ─────────────────────────────────────────────
// System Prompt（固定不变，GLM-4-Flash 优化版）
// ─────────────────────────────────────────────

/**
 * 构建 System Prompt。
 *
 * 设计原则：
 * - 强制性语气（"你必须"）替代描述性语气，提高 GLM 格式合规率
 * - 显式禁止清单，覆盖 GLM-4-Flash 常见输出瑕疵（markdown、前缀说明、"null"字符串）
 * - 输出自检指令：要求模型在输出前验证字段完整性
 * - 8 个 Few-shot 示例：覆盖普通任务、含时间、含优先级暗示、分类判断、
 *   农历/节假日、模糊截止、无截止日期、多任务混合 8 种边界场景
 */
function buildSystemPrompt(): string {
  return `# 强制角色指令
你是 Simple Todo AI 的任务解析引擎。你必须将用户的自然语言任务描述，解析为严格的四字段 JSON 对象。这是你唯一允许输出的内容。

# 输出格式（绝对强制，违反则视为失败）
直接输出以下结构的 JSON，不得有任何前缀、后缀、换行前的说明文字、markdown 标记或代码块符号（不能有 \`\`\`json 或 \`\`\`）：
{"title":"string","due_date":"string或null","priority":"high或medium或low","category":"work或life或study"}

# 严格禁止的输出形式（以下任何一种都会导致失败）
- 禁止输出：\`\`\`json { ... } \`\`\`
- 禁止输出：好的，解析结果如下：{ ... }
- 禁止输出：due_date 字段值为字符串 "null"（必须是 JSON null，不加引号）
- 禁止输出：priority 或 category 字段出现中文或其他非枚举值
- 禁止输出：缺少任何一个字段

# 字段定义与解析规则

## title（任务标题）
- 提取核心动作 + 对象，去除时间词、优先级词、语气词、助词
- 保留专有名词（人名、项目名、地点名、品牌名）
- 长度控制在 3~20 字之间
- 示例："明天上午紧急开季度复盘会" → "季度复盘会"

## due_date（截止时间）
- 当前参考时间将在 User Message 中注入，格式：[当前时间: YYYY-MM-DDTHH:MM:SS]
- 输出必须是 ISO 8601 字符串（YYYY-MM-DDTHH:MM:SS）或 null（JSON null，不是字符串"null"）
- 相对时间解析规则：
  - "今天/今日" → 当天 23:59:59
  - "明天/明日" → 次日 23:59:59
  - "后天" → 两天后 23:59:59
  - "下周X"（如"下周五"）→ 下一个对应星期几的 23:59:59
  - "这周X" → 本周对应星期几的 23:59:59（如果已过则为下周）
  - "上午" → 当天 09:00:00，"下午" → 当天 15:00:00，"晚上" → 当天 20:00:00
  - 明确时间如"下午3点" → HH:00:00，"3点半" → HH:30:00
  - "月底" → 当月最后一天 23:59:59
  - "年底" → 当年 12月31日 23:59:59
  - 农历节日：春节 → 当年农历正月初一对应公历日期
  - 节假日：五一/劳动节 → 5月1日，国庆 → 10月1日，元旦 → 1月1日
  - "尽快/ASAP/越快越好" → null（无法确定具体截止日）
  - "有空/闲了/随时" → null
  - 无时间信息 → null

## priority（优先级，只能是以下三个值之一）
- "high"：包含"紧急/重要/关键/必须/今天必须/ASAP/尽快/重大/重要会议/DDL/deadline/截止/老板/领导要求"等关键词，或任务本身时间紧迫
- "medium"：默认值，常规任务，无明显紧急或轻松信号
- "low"：包含"顺手/有空/闲了/随便/不急/随时/小事/顺便"等关键词，或任务明显非紧迫

## category（分类，只能是以下三个值之一）
- "work"：工作任务，包含"会议/报告/汇报/项目/客户/同事/合同/邮件/代码/开发/产品/运营/销售/财务报告/PPT/提案/招聘/出差/考勤/周报/月报"等
- "study"：学习任务，包含"学习/练习/复习/阅读/读书/课程/培训/考试/作业/论文/看视频/教程/研究/笔记"等
- "life"：生活任务，默认分类，包含"买/购/送/接/家/医院/健身/运动/朋友/聚餐/旅行/快递/水电/银行/打扫/整理/家务/宠物"等

# 输出自检（输出前必须执行）
在输出最终 JSON 前，你必须在内部检查：
1. ✓ JSON 格式是否合法（无多余逗号、括号匹配）
2. ✓ 四个字段是否都存在（title、due_date、priority、category）
3. ✓ priority 是否在 ["high","medium","low"] 之内
4. ✓ category 是否在 ["work","life","study"] 之内
5. ✓ due_date 是否是合法 ISO 8601 字符串或 JSON null（非字符串"null"）
6. ✓ 输出是否没有 \`\`\`json 包裹

# 八个 Few-shot 示例

## 示例 1：普通任务（无时间、无优先级暗示）
用户输入：整理一下桌面文件
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"整理桌面文件","due_date":null,"priority":"low","category":"life"}

## 示例 2：含明确时间的工作任务
用户输入：明天下午3点和张总开季度复盘会，很重要
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"与张总季度复盘会","due_date":"2026-04-10T15:00:00","priority":"high","category":"work"}

## 示例 3：含优先级暗示（紧急）
用户输入：今晚之前必须把合同发给客户，这个很关键
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"发合同给客户","due_date":"2026-04-09T23:59:59","priority":"high","category":"work"}

## 示例 4：分类判断（学习 vs 生活）
用户输入：有空看完《深度学习》第3章，做点笔记
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"阅读深度学习第3章并做笔记","due_date":null,"priority":"low","category":"study"}

## 示例 5：农历/节假日时间
用户输入：五一前把项目文档整理好
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"整理项目文档","due_date":"2026-04-30T23:59:59","priority":"medium","category":"work"}

## 示例 6：模糊截止（含"尽快"）
用户输入：尽快回复上周的那封重要邮件
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"回复重要邮件","due_date":null,"priority":"high","category":"work"}

## 示例 7：无截止日期的低优先级任务
用户输入：顺手买瓶矿泉水
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"购买矿泉水","due_date":null,"priority":"low","category":"life"}

## 示例 8：复合输入（多动作，取主要任务）
用户输入：周五下午开完会之后顺便去超市买菜，别忘了还要给妈妈打电话
[当前时间: 2026-04-09T10:00:00]
期望输出：{"title":"周五开完会后去超市买菜","due_date":"2026-04-10T17:00:00","priority":"medium","category":"life"}`;
}

// ─────────────────────────────────────────────
// 修复层（后端二重保障）
// ─────────────────────────────────────────────

/**
 * 优先级枚举别名映射表。
 * 覆盖 GLM 常见偏差输出（中文、大写、同义词）。
 */
const PRIORITY_ALIAS_MAP: Record<string, Priority> = {
  // 中文映射
  '高': 'high',
  '高优先级': 'high',
  '紧急': 'high',
  '重要': 'high',
  '中': 'medium',
  '中等': 'medium',
  '普通': 'medium',
  '低': 'low',
  '低优先级': 'low',
  '不急': 'low',
  // 大写英文映射
  'HIGH': 'high',
  'MEDIUM': 'medium',
  'LOW': 'low',
  // 数字映射（偶发）
  '1': 'high',
  '2': 'medium',
  '3': 'low',
};

/**
 * 分类枚举别名映射表。
 * 覆盖 GLM 常见偏差输出（中文、大写、同义词）。
 */
const CATEGORY_ALIAS_MAP: Record<string, Category> = {
  // 中文映射
  '工作': 'work',
  '职场': 'work',
  '办公': 'work',
  '学习': 'study',
  '学业': 'study',
  '教育': 'study',
  '生活': 'life',
  '日常': 'life',
  '个人': 'life',
  // 大写英文映射
  'WORK': 'work',
  'STUDY': 'study',
  'LIFE': 'life',
};

/** 有效优先级集合 */
const VALID_PRIORITIES = new Set<string>(['high', 'medium', 'low']);

/** 有效分类集合 */
const VALID_CATEGORIES = new Set<string>(['work', 'life', 'study']);

/**
 * 从 GLM 原始输出字符串中剥离 markdown 代码块包裹。
 *
 * 处理场景：
 * - ```json\n{ ... }\n```
 * - ```\n{ ... }\n```
 * - 行首/行尾多余空白
 *
 * @param raw GLM 返回的 content 字符串
 * @returns 去除 markdown 包裹后的纯 JSON 字符串
 */
function stripMarkdown(raw: string): string {
  let s = raw.trim();
  // 剥离 ```json ... ``` 或 ``` ... ``` 包裹
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }
  return s;
}

/**
 * 将字符串 "null" 修复为 JSON null（针对 due_date 字段）。
 *
 * GLM-4-Flash 在少数情况下会输出 due_date: "null"（带引号）
 * 而非 due_date: null（JSON null），此函数修复该问题。
 *
 * @param value 原始字段值
 * @returns 如果是字符串 "null"，返回 null；否则原样返回
 */
function fixNullString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.toLowerCase() === 'null') return null;
  if (typeof value === 'string') return value;
  return null;
}

/**
 * 修复优先级字段值（枚举别名修复 + 大小写修复）。
 *
 * @param value 原始字段值
 * @returns 合法的 Priority 值，或 undefined（无法修复）
 */
function fixPriority(value: unknown): Priority | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // 先尝试直接匹配合法值（含小写修复）
  const lower = trimmed.toLowerCase() as Priority;
  if (VALID_PRIORITIES.has(lower)) return lower;
  // 再查别名表
  return PRIORITY_ALIAS_MAP[trimmed] ?? undefined;
}

/**
 * 修复分类字段值（枚举别名修复 + 大小写修复）。
 *
 * @param value 原始字段值
 * @returns 合法的 Category 值，或 undefined（无法修复）
 */
function fixCategory(value: unknown): Category | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase() as Category;
  if (VALID_CATEGORIES.has(lower)) return lower;
  return CATEGORY_ALIAS_MAP[trimmed] ?? undefined;
}

/**
 * 修复层主函数：接受 GLM 的原始 JSON 字符串，输出合法的 RawGlmOutput。
 *
 * 三步修复流程：
 * 1. 剥离 markdown 代码块包裹
 * 2. JSON.parse（若失败，向上抛出，触发重试）
 * 3. 字段级修复（"null"字符串 → null，枚举别名 → 标准值）
 *
 * @param rawContent GLM choices[0].message.content 原始字符串
 * @returns 经过修复的 RawGlmOutput 对象
 * @throws {ParseError} 若 JSON 解析失败（INVALID_JSON）
 */
function applyRepairLayer(rawContent: string, attempt: number): RawGlmOutput {
  const stripped = stripMarkdown(rawContent);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new ParseError(
      `GLM 返回的 JSON 无法解析（attempt ${attempt}）: ${stripped.slice(0, 200)}`,
      'INVALID_JSON',
      attempt,
      e,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ParseError(
      `GLM 返回值不是 JSON 对象（attempt ${attempt}）`,
      'INVALID_JSON',
      attempt,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // 字段级修复
  const repaired: RawGlmOutput = {
    ...obj,
    due_date: fixNullString(obj.due_date),
    priority: fixPriority(obj.priority) ?? obj.priority,
    category: fixCategory(obj.category) ?? obj.category,
  };

  return repaired;
}

/**
 * 验证修复后的对象是否满足 ParsedTask 四字段要求。
 *
 * @param obj 修复后的 RawGlmOutput
 * @param attempt 当前重试次数（用于错误信息）
 * @throws {ParseError} 若字段缺失或枚举值仍非法
 */
function validateFields(obj: RawGlmOutput, attempt: number): void {
  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    throw new ParseError(
      `title 字段缺失或为空（attempt ${attempt}）`,
      'MISSING_FIELDS',
      attempt,
    );
  }

  // due_date 允许 null 或合法 ISO 8601 字符串
  if (obj.due_date !== null && typeof obj.due_date !== 'string') {
    throw new ParseError(
      `due_date 字段类型非法（attempt ${attempt}）: ${String(obj.due_date)}`,
      'INVALID_ENUM',
      attempt,
    );
  }

  if (!VALID_PRIORITIES.has(String(obj.priority))) {
    throw new ParseError(
      `priority 枚举值非法（attempt ${attempt}）: ${String(obj.priority)}`,
      'INVALID_ENUM',
      attempt,
    );
  }

  if (!VALID_CATEGORIES.has(String(obj.category))) {
    throw new ParseError(
      `category 枚举值非法（attempt ${attempt}）: ${String(obj.category)}`,
      'INVALID_ENUM',
      attempt,
    );
  }
}

// ─────────────────────────────────────────────
// 规则引擎兜底
// ─────────────────────────────────────────────

/**
 * 关键词列表，用于规则引擎的优先级和分类推断。
 */
const RULE_PRIORITY_HIGH_KEYWORDS = ['紧急', '重要', '关键', '必须', 'asap', '尽快', 'deadline', 'ddl', '截止', '老板', '领导'];
const RULE_PRIORITY_LOW_KEYWORDS = ['顺手', '有空', '闲了', '随便', '不急', '随时', '小事', '顺便'];
const RULE_CATEGORY_WORK_KEYWORDS = ['会议', '报告', '汇报', '项目', '客户', '合同', '邮件', '代码', '开发', '产品', '运营', '财务', 'ppt', '提案', '招聘', '出差', '周报', '月报', '同事'];
const RULE_CATEGORY_STUDY_KEYWORDS = ['学习', '练习', '复习', '阅读', '读书', '课程', '培训', '考试', '作业', '论文', '看视频', '教程', '研究', '笔记'];

/**
 * 规则引擎：仅基于字符串匹配推断四字段。
 *
 * 在 AI 调用全部失败时启用，保证用户侧不崩溃。
 * 准确率低于 AI，但优先级为"可用性"而非"准确性"。
 *
 * @param input 用户原始输入
 * @returns ParsedTask（source='rule-engine'，置信度全部 0.4）
 */
function ruleEngineFallback(input: string): ParsedTask {
  const lower = input.toLowerCase();

  // 优先级推断
  let priority: Priority = 'medium';
  if (RULE_PRIORITY_HIGH_KEYWORDS.some((kw) => lower.includes(kw))) {
    priority = 'high';
  } else if (RULE_PRIORITY_LOW_KEYWORDS.some((kw) => lower.includes(kw))) {
    priority = 'low';
  }

  // 分类推断
  let category: Category = 'life';
  if (RULE_CATEGORY_WORK_KEYWORDS.some((kw) => lower.includes(kw))) {
    category = 'work';
  } else if (RULE_CATEGORY_STUDY_KEYWORDS.some((kw) => lower.includes(kw))) {
    category = 'study';
  }

  // 标题：截取前 20 字（去除常见时间词前缀）
  const timePrefix = /^(今天|明天|后天|下周|这周|上午|下午|晚上|[一二三四五六七八九十百千万\d]+[点号时分秒月日年])[，,、\s]*/u;
  const cleanedInput = input.replace(timePrefix, '').trim();
  const title = cleanedInput.slice(0, 20) || input.slice(0, 20);

  return {
    title,
    due_date: null,
    priority,
    category,
    confidence: { title: 0.4, due_date: 0.0, priority: 0.4, category: 0.4 },
    raw_input: input,
    source: 'rule-engine',
  };
}

// ─────────────────────────────────────────────
// GLM HTTP 调用层（使用原生 fetch，无额外 SDK 依赖）
// ─────────────────────────────────────────────

/**
 * 调用 GLM Chat Completions API（/chat/completions endpoint）。
 *
 * 选择 HTTP fetch 而非 @zhipuai/zhipuai-sdk 的原因：
 * 1. 官方 SDK 的 TypeScript 类型定义不完整，生产环境需额外补充
 * 2. SDK 内部封装了 JWT 生成逻辑，但该逻辑已充分文档化，自实现更可控
 * 3. fetch 是 Node.js 18+ 原生 API，无额外依赖，减少供应链风险
 * 4. 便于精确控制超时（AbortSignal）和重试（fetch 层直接处理）
 *
 * GLM API 与 OpenAI 接口格式兼容，直接使用 Bearer Token 认证
 * （智谱AI接受 API Key 作为 Bearer Token，无需动态生成 JWT）。
 *
 * @param model GLM 模型名称（glm-4-flash 或 glm-4-air）
 * @param systemPrompt System Prompt 内容
 * @param userMessage User Message 内容
 * @param signal AbortSignal（可选，用于超时和用户取消）
 * @returns GLM 返回的 choices[0].message.content 字符串
 * @throws {ParseError} 超时、限速、服务端错误、请求被中止
 */
async function callGlmApi(
  model: string,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!CONFIG.apiKey) {
    throw new ParseError(
      'GLM_API_KEY 环境变量未配置',
      'AI_SERVER_ERROR',
      0,
    );
  }

  // 合并超时 signal 和外部传入 signal
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(
    () => timeoutController.abort(),
    CONFIG.timeoutMs,
  );

  // 若外部已 abort，立即传递
  signal?.addEventListener('abort', () => timeoutController.abort(), {
    once: true,
  });

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,   // 低温度提高 JSON 格式一致性
    top_p: 0.8,
    max_tokens: 256,    // 四字段 JSON 不超过 256 tokens
  };

  let response: Response;
  try {
    response = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: timeoutController.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    // fetch 本身抛出的错误：网络断开、AbortError
    const err = e as Error;
    if (err.name === 'AbortError') {
      // 区分超时 vs 用户取消
      if (signal?.aborted) {
        throw new ParseError('AI 请求被用户取消', 'AI_REQUEST_ABORTED', 0, e);
      }
      throw new ParseError(
        `GLM API 调用超时（>${CONFIG.timeoutMs}ms）`,
        'AI_TIMEOUT',
        0,
        e,
      );
    }
    throw new ParseError(
      `GLM API 网络错误: ${err.message}`,
      'AI_SERVER_ERROR',
      0,
      e,
    );
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    let errorBody: GlmErrorResponse | null = null;
    try {
      errorBody = (await response.json()) as GlmErrorResponse;
    } catch {
      // 无法解析错误体，忽略
    }

    const errMsg = errorBody?.error?.message ?? `HTTP ${response.status}`;

    if (response.status === 429) {
      throw new ParseError(
        `GLM API 限速: ${errMsg}`,
        'AI_RATE_LIMIT',
        0,
      );
    }
    if (response.status >= 500) {
      throw new ParseError(
        `GLM API 服务端错误（${response.status}）: ${errMsg}`,
        'AI_SERVER_ERROR',
        0,
      );
    }
    // 4xx 非 429（如 401 鉴权失败、400 参数错误）
    throw new ParseError(
      `GLM API 请求错误（${response.status}）: ${errMsg}`,
      'AI_SERVER_ERROR',
      0,
    );
  }

  let data: GlmChatResponse;
  try {
    data = (await response.json()) as GlmChatResponse;
  } catch (e) {
    throw new ParseError(
      'GLM API 响应体 JSON 解析失败',
      'AI_SERVER_ERROR',
      0,
      e,
    );
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new ParseError(
      'GLM API 返回的 choices[0].message.content 为空',
      'AI_SERVER_ERROR',
      0,
    );
  }

  return content;
}

// ─────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────

/**
 * 获取当前时间的 ISO 8601 字符串（基于用户时区）。
 *
 * @param userTimezone IANA 时区字符串，如 'Asia/Shanghai'
 * @returns 格式 YYYY-MM-DDTHH:MM:SS 的时间字符串
 */
function getCurrentTimeString(userTimezone: string): string {
  const now = new Date();
  try {
    // 使用 Intl.DateTimeFormat 获取时区感知的各分量
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: userTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    // 时区无效时降级到 UTC
    return now.toISOString().slice(0, 19);
  }
}

/**
 * 指数退避等待。
 *
 * @param attempt 当前重试次数（0-indexed）
 */
async function exponentialBackoff(attempt: number): Promise<void> {
  const delay = CONFIG.retryBaseDelayMs * Math.pow(2, attempt);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * 判断错误是否可重试。
 * - 限速（429）和用户主动取消不重试
 * - 超时、服务端错误、JSON 解析失败可重试
 */
function isRetryable(error: ParseError): boolean {
  return (
    error.code !== 'AI_RATE_LIMIT' &&
    error.code !== 'AI_REQUEST_ABORTED'
  );
}

// ─────────────────────────────────────────────
// 主函数：parseTask
// ─────────────────────────────────────────────

/**
 * 将用户自然语言任务描述解析为结构化 ParsedTask 对象。
 *
 * 执行流程：
 * ```
 * 尝试 1: GLM-4-Flash（主模型）
 *   ├─ 成功 → 修复层 → 验证 → 返回（source='glm-4-flash'）
 *   └─ 失败（可重试）→ 指数退避
 * 尝试 2: GLM-4-Air（Fallback 模型）
 *   ├─ 成功 → 修复层 → 验证 → 返回（source='glm-4-air'）
 *   └─ 失败 → 规则引擎兜底
 * 规则引擎: 返回（source='rule-engine'，低置信度）
 * ```
 *
 * 保证：此函数在任何情况下都不会向上抛出 ParseError（规则引擎兜底）。
 * 唯一例外是 AI_REQUEST_ABORTED（用户主动取消，立即向上传递）。
 *
 * @param input 用户原始自然语言输入（1~1000 字符）
 * @param userTimezone 用户时区，IANA 格式，默认 'Asia/Shanghai'
 * @param options 额外选项（AbortSignal 等）
 * @returns Promise<ParsedTask>
 */
export async function parseTask(
  input: string,
  userTimezone: string = 'Asia/Shanghai',
  options: ParseOptions = {},
): Promise<ParsedTask> {
  const { signal } = options;

  // 用户主动取消时，立即停止，不进入任何重试
  if (signal?.aborted) {
    throw new ParseError('AI 请求被用户取消', 'AI_REQUEST_ABORTED', 0);
  }

  // 输入预处理：去除首尾空白，超长截断（防止 prompt 注入和 token 超限）
  const sanitizedInput = input.trim().slice(0, 1000);
  if (!sanitizedInput) {
    // 空输入直接走规则引擎
    return ruleEngineFallback(input);
  }

  const systemPrompt = buildSystemPrompt();
  const currentTimeStr = getCurrentTimeString(userTimezone);

  // 构建 User Prompt（注入当前时间上下文）
  const userMessage = `[当前时间: ${currentTimeStr}]\n[用户时区: ${userTimezone}]\n\n用户输入：${sanitizedInput}`;

  // 模型序列：首次用 primary，首次失败后用 fallback
  const modelSequence = [CONFIG.primaryModel, CONFIG.fallbackModel];
  let lastError: ParseError | null = null;

  for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
    const model = modelSequence[attempt] ?? CONFIG.fallbackModel;

    try {
      // 检查是否已被取消
      if (signal?.aborted) {
        throw new ParseError('AI 请求被用户取消', 'AI_REQUEST_ABORTED', attempt);
      }

      // 调用 GLM API
      const rawContent = await callGlmApi(model, systemPrompt, userMessage, signal);

      // 应用修复层
      const repairedObj = applyRepairLayer(rawContent, attempt);

      // 验证四字段
      validateFields(repairedObj, attempt);

      // 成功：构建并返回 ParsedTask
      const source =
        model === CONFIG.primaryModel ? 'glm-4-flash' : 'glm-4-air';

      return {
        title: (repairedObj.title as string).trim().slice(0, 50),
        due_date: repairedObj.due_date as string | null,
        priority: repairedObj.priority as Priority,
        category: repairedObj.category as Category,
        // 置信度：AI 解析统一给较高置信度（准确性由模型保障）
        // due_date 为 null 时置信度适当降低，提示用户确认
        confidence: {
          title: 0.92,
          due_date: repairedObj.due_date !== null ? 0.88 : 0.70,
          priority: 0.85,
          category: 0.82,
        },
        raw_input: sanitizedInput,
        source,
      };
    } catch (e) {
      const parseErr =
        e instanceof ParseError
          ? e
          : new ParseError(
              `未知错误（attempt ${attempt}）: ${String(e)}`,
              'UNKNOWN',
              attempt,
              e,
            );

      // 用户主动取消：立即向上抛出，不进入下一次重试
      if (parseErr.code === 'AI_REQUEST_ABORTED') {
        throw parseErr;
      }

      // 限速错误：不重试
      if (!isRetryable(parseErr)) {
        lastError = parseErr;
        break;
      }

      lastError = parseErr;

      // 记录重试日志（生产环境应接入结构化日志系统，如 pino）
      console.warn(
        `[glm-parser] attempt=${attempt} model=${model} error=${parseErr.code} msg=${parseErr.message}`,
      );

      // 最后一次重试失败，直接 break，不等待
      if (attempt < CONFIG.maxRetries - 1) {
        await exponentialBackoff(attempt);
      }
    }
  }

  // 所有重试失败：记录错误并启用规则引擎兜底
  console.error(
    `[glm-parser] 所有 ${CONFIG.maxRetries} 次 AI 调用失败，启用规则引擎兜底`,
    {
      lastErrorCode: lastError?.code,
      lastErrorMsg: lastError?.message,
      input: sanitizedInput.slice(0, 100),
    },
  );

  return ruleEngineFallback(sanitizedInput);
}

// ─────────────────────────────────────────────
// 导出（供 Fastify 路由层使用）
// ─────────────────────────────────────────────

export { ruleEngineFallback, applyRepairLayer, stripMarkdown };
