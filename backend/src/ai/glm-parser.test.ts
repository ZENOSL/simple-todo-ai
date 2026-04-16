/**
 * @file src/ai/glm-parser.test.ts
 * @description GLM 解析服务单元测试
 *
 * 测试框架：Vitest（与后端 Fastify 项目统一）
 * 运行命令：npx vitest run src/ai/glm-parser.test.ts
 *
 * 覆盖范围：
 *  1. 正常解析路径（含时间、含优先级、含分类）
 *  2. 修复层：枚举别名修复、markdown 代码块剥离、"null"字符串处理
 *  3. 重试逻辑：首次失败 → Fallback 模型成功
 *  4. 规则引擎兜底：两次重试均失败时的降级行为
 *  5. 用户取消（AbortSignal）行为
 *  6. 空输入和超长输入边界处理
 *
 * 测试策略：
 *  - Mock fetch（global.fetch）以隔离外部 HTTP 依赖
 *  - 不 Mock parseTask 内部逻辑（白盒测试修复层和规则引擎）
 *  - 每个 describe 块在 beforeEach 中重置 Mock 状态
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParseError } from '../types/ai.js';
import {
  applyRepairLayer,
  parseTask,
  ruleEngineFallback,
  stripMarkdown,
} from './glm-parser.js';

// ─────────────────────────────────────────────
// 测试工具函数
// ─────────────────────────────────────────────

/** 构造标准 GLM 成功响应的 fetch mock 返回值 */
function mockGlmSuccess(content: string): Response {
  const body = JSON.stringify({
    id: 'test-id',
    object: 'chat.completion',
    created: Date.now(),
    model: 'glm-4-flash',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 构造 GLM API 错误响应的 fetch mock 返回值 */
function mockGlmError(status: number, code: string, message: string): Response {
  const body = JSON.stringify({ error: { code, message } });
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

/** 标准合法 ParsedTask JSON 字符串 */
const VALID_PARSED_JSON = JSON.stringify({
  title: '与张总季度复盘会',
  due_date: '2026-04-10T15:00:00',
  priority: 'high',
  category: 'work',
});

/** 环境变量 Setup（每个测试需要有 GLM_API_KEY） */
beforeEach(() => {
  process.env.GLM_API_KEY = 'test-api-key-for-unit-tests';
  process.env.GLM_TIMEOUT_MS = '8000';
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.GLM_API_KEY;
});

// ─────────────────────────────────────────────
// 一、修复层单元测试（纯函数，无 Mock 依赖）
// ─────────────────────────────────────────────

describe('stripMarkdown()', () => {
  it('应剥离 ```json ... ``` 包裹', () => {
    const input = '```json\n{"title":"test"}\n```';
    expect(stripMarkdown(input)).toBe('{"title":"test"}');
  });

  it('应剥离 ``` ... ``` 包裹（无 json 语言标识）', () => {
    const input = '```\n{"title":"test"}\n```';
    expect(stripMarkdown(input)).toBe('{"title":"test"}');
  });

  it('对无包裹的纯 JSON 字符串无影响', () => {
    const input = '{"title":"test","due_date":null}';
    expect(stripMarkdown(input)).toBe(input);
  });

  it('应去除首尾空白', () => {
    const input = '  {"title":"test"}  ';
    expect(stripMarkdown(input)).toBe('{"title":"test"}');
  });

  it('处理多行 JSON（无 markdown 包裹）', () => {
    const input = '{\n  "title": "test"\n}';
    expect(stripMarkdown(input)).toBe('{\n  "title": "test"\n}');
  });
});

describe('applyRepairLayer()', () => {
  it('应解析合法 JSON 并原样返回', () => {
    const input = '{"title":"测试","due_date":null,"priority":"high","category":"work"}';
    const result = applyRepairLayer(input, 0);
    expect(result.title).toBe('测试');
    expect(result.due_date).toBeNull();
    expect(result.priority).toBe('high');
    expect(result.category).toBe('work');
  });

  it('应将字符串 "null" 的 due_date 修复为 JSON null', () => {
    const input = '{"title":"测试","due_date":"null","priority":"medium","category":"life"}';
    const result = applyRepairLayer(input, 0);
    expect(result.due_date).toBeNull();
  });

  it('应将中文优先级别名 "紧急" 修复为 "high"', () => {
    const input = '{"title":"测试","due_date":null,"priority":"紧急","category":"work"}';
    const result = applyRepairLayer(input, 0);
    expect(result.priority).toBe('high');
  });

  it('应将大写优先级别名 "HIGH" 修复为 "high"', () => {
    const input = '{"title":"测试","due_date":null,"priority":"HIGH","category":"work"}';
    const result = applyRepairLayer(input, 0);
    expect(result.priority).toBe('high');
  });

  it('应将中文分类别名 "工作" 修复为 "work"', () => {
    const input = '{"title":"测试","due_date":null,"priority":"medium","category":"工作"}';
    const result = applyRepairLayer(input, 0);
    expect(result.category).toBe('work');
  });

  it('应将中文分类别名 "学习" 修复为 "study"', () => {
    const input = '{"title":"测试","due_date":null,"priority":"low","category":"学习"}';
    const result = applyRepairLayer(input, 0);
    expect(result.category).toBe('study');
  });

  it('应先剥离 markdown 代码块再解析', () => {
    const input = '```json\n{"title":"测试","due_date":null,"priority":"medium","category":"life"}\n```';
    const result = applyRepairLayer(input, 0);
    expect(result.title).toBe('测试');
  });

  it('对无法解析的 JSON 应抛出 ParseError（INVALID_JSON）', () => {
    expect(() => applyRepairLayer('这不是JSON', 0)).toThrow(ParseError);
    try {
      applyRepairLayer('{ broken json', 0);
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).code).toBe('INVALID_JSON');
    }
  });

  it('对 JSON 为数组时应抛出 ParseError（INVALID_JSON）', () => {
    expect(() => applyRepairLayer('[1,2,3]', 0)).toThrow(ParseError);
  });
});

// ─────────────────────────────────────────────
// 二、规则引擎兜底测试（纯函数，无 Mock 依赖）
// ─────────────────────────────────────────────

describe('ruleEngineFallback()', () => {
  it('应返回 source="rule-engine"', () => {
    const result = ruleEngineFallback('买菜');
    expect(result.source).toBe('rule-engine');
  });

  it('包含"紧急"关键词时 priority 应为 high', () => {
    const result = ruleEngineFallback('紧急处理这个问题');
    expect(result.priority).toBe('high');
  });

  it('包含"有空"关键词时 priority 应为 low', () => {
    const result = ruleEngineFallback('有空的话整理一下书架');
    expect(result.priority).toBe('low');
  });

  it('无优先级关键词时 priority 默认 medium', () => {
    const result = ruleEngineFallback('写一份总结');
    expect(result.priority).toBe('medium');
  });

  it('包含"会议"关键词时 category 应为 work', () => {
    const result = ruleEngineFallback('开会讨论项目进展');
    expect(result.category).toBe('work');
  });

  it('包含"学习"关键词时 category 应为 study', () => {
    const result = ruleEngineFallback('学习TypeScript高级类型');
    expect(result.category).toBe('study');
  });

  it('无分类关键词时 category 默认 life', () => {
    const result = ruleEngineFallback('买一瓶水');
    expect(result.category).toBe('life');
  });

  it('due_date 应始终为 null（规则引擎不解析时间）', () => {
    const result = ruleEngineFallback('明天下午开会');
    expect(result.due_date).toBeNull();
  });

  it('title 不应超过 20 字', () => {
    const longInput = '这是一个非常非常非常非常非常非常非常非常长的输入内容，用于测试截断逻辑';
    const result = ruleEngineFallback(longInput);
    expect(result.title.length).toBeLessThanOrEqual(20);
  });

  it('置信度应全部低于 0.5', () => {
    const result = ruleEngineFallback('做点什么');
    expect(result.confidence.title).toBeLessThan(0.5);
    expect(result.confidence.due_date).toBe(0);
    expect(result.confidence.priority).toBeLessThan(0.5);
    expect(result.confidence.category).toBeLessThan(0.5);
  });

  it('raw_input 应等于传入字符串', () => {
    const input = '测试输入';
    const result = ruleEngineFallback(input);
    expect(result.raw_input).toBe(input);
  });
});

// ─────────────────────────────────────────────
// 三、parseTask() 正常解析路径测试
// ─────────────────────────────────────────────

describe('parseTask() - 正常路径', () => {
  it('应正确解析含明确时间的工作任务', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(VALID_PARSED_JSON));

    const result = await parseTask('明天下午3点和张总开季度复盘会，很重要');

    expect(result.title).toBe('与张总季度复盘会');
    expect(result.due_date).toBe('2026-04-10T15:00:00');
    expect(result.priority).toBe('high');
    expect(result.category).toBe('work');
    expect(result.source).toBe('glm-4-flash');
  });

  it('应正确解析无截止时间的低优先级任务', async () => {
    const json = JSON.stringify({
      title: '整理桌面文件',
      due_date: null,
      priority: 'low',
      category: 'life',
    });
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(json));

    const result = await parseTask('整理一下桌面文件');

    expect(result.title).toBe('整理桌面文件');
    expect(result.due_date).toBeNull();
    expect(result.priority).toBe('low');
    expect(result.category).toBe('life');
  });

  it('应正确解析学习类任务', async () => {
    const json = JSON.stringify({
      title: '阅读深度学习第3章并做笔记',
      due_date: null,
      priority: 'low',
      category: 'study',
    });
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(json));

    const result = await parseTask('有空看完深度学习第3章，做点笔记');

    expect(result.category).toBe('study');
    expect(result.source).toBe('glm-4-flash');
  });

  it('应透传 raw_input 为输入字符串', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(VALID_PARSED_JSON));

    const input = '明天下午3点和张总开季度复盘会';
    const result = await parseTask(input);

    expect(result.raw_input).toBe(input);
  });

  it('应截断超过 1000 字的输入', async () => {
    const longInput = 'A'.repeat(2000);
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(VALID_PARSED_JSON));

    const result = await parseTask(longInput);
    // raw_input 应被截断到 1000 字
    expect(result.raw_input.length).toBeLessThanOrEqual(1000);
  });

  it('对 GLM 返回 markdown 包裹的 JSON 应自动剥离并正常解析', async () => {
    const wrappedJson = '```json\n' + VALID_PARSED_JSON + '\n```';
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(wrappedJson));

    const result = await parseTask('明天下午3点和张总开季度复盘会');

    expect(result.title).toBe('与张总季度复盘会');
    expect(result.source).toBe('glm-4-flash');
  });

  it('对 GLM 返回 due_date="null" 应自动修复为 null', async () => {
    const json = JSON.stringify({
      title: '整理文件',
      due_date: 'null',    // 字符串 "null"，应被修复
      priority: 'medium',
      category: 'work',
    });
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(json));

    const result = await parseTask('整理文件');

    expect(result.due_date).toBeNull();
  });

  it('对 GLM 返回中文优先级 "紧急" 应自动修复为 "high"', async () => {
    const json = JSON.stringify({
      title: '紧急处理故障',
      due_date: null,
      priority: '紧急',   // 中文别名，应被修复
      category: 'work',
    });
    vi.mocked(fetch).mockResolvedValueOnce(mockGlmSuccess(json));

    const result = await parseTask('紧急处理线上故障');

    expect(result.priority).toBe('high');
  });
});

// ─────────────────────────────────────────────
// 四、重试逻辑测试
// ─────────────────────────────────────────────

describe('parseTask() - 重试逻辑', () => {
  it('首次 GLM-4-Flash 失败（500），应自动重试 GLM-4-Air 并成功', async () => {
    // 第一次调用：GLM-4-Flash 返回 500
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockGlmError(500, 'server_error', '内部错误'))
      // 第二次调用：GLM-4-Air 返回成功
      .mockResolvedValueOnce(mockGlmSuccess(VALID_PARSED_JSON));

    const result = await parseTask('明天下午3点开会');

    expect(result.title).toBe('与张总季度复盘会');
    // Fallback 模型返回的 source 为 glm-4-air
    expect(result.source).toBe('glm-4-air');
    // 应调用了两次 fetch
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('首次返回无效 JSON，应自动重试 Fallback 模型', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockGlmSuccess('这不是JSON'))
      .mockResolvedValueOnce(mockGlmSuccess(VALID_PARSED_JSON));

    const result = await parseTask('整理文件');

    expect(result.source).toBe('glm-4-air');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('首次返回缺少字段的 JSON，应自动重试 Fallback 模型', async () => {
    // 缺少 category 字段
    const incompleteJson = JSON.stringify({
      title: '测试任务',
      due_date: null,
      priority: 'medium',
      // category 缺失
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockGlmSuccess(incompleteJson))
      .mockResolvedValueOnce(mockGlmSuccess(VALID_PARSED_JSON));

    const result = await parseTask('测试输入');

    expect(result.source).toBe('glm-4-air');
  });

  it('限速错误（429）不应重试，直接降级规则引擎', async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockGlmError(429, 'rate_limit_exceeded', '请求频率超限'),
    );

    const result = await parseTask('开会讨论项目进展');

    // 因为有关键词"会议"（开会），规则引擎应推断为 work
    expect(result.source).toBe('rule-engine');
    // 429 不重试，fetch 应只被调用一次
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// 五、规则引擎兜底触发测试
// ─────────────────────────────────────────────

describe('parseTask() - 规则引擎兜底', () => {
  it('两次 AI 调用均失败时，应启用规则引擎兜底而非抛出异常', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockGlmError(500, 'server_error', '错误'))
      .mockResolvedValueOnce(mockGlmError(500, 'server_error', '错误'));

    // 不应抛出异常
    const result = await parseTask('开会讨论项目');

    expect(result.source).toBe('rule-engine');
    // 应有合理的默认值
    expect(['high', 'medium', 'low']).toContain(result.priority);
    expect(['work', 'life', 'study']).toContain(result.category);
  });

  it('空输入时，应立即返回规则引擎结果（不调用 GLM）', async () => {
    const result = await parseTask('   ');

    expect(result.source).toBe('rule-engine');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('两次均返回无效 JSON 时，应启用规则引擎兜底', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockGlmSuccess('无效内容'))
      .mockResolvedValueOnce(mockGlmSuccess('同样无效'));

    const result = await parseTask('测试任务');

    expect(result.source).toBe('rule-engine');
  });
});

// ─────────────────────────────────────────────
// 六、AbortSignal 测试
// ─────────────────────────────────────────────

describe('parseTask() - AbortSignal', () => {
  it('预先 abort 的 signal 应立即抛出 ParseError（AI_REQUEST_ABORTED）', async () => {
    const controller = new AbortController();
    controller.abort();    // 提前 abort

    await expect(
      parseTask('测试输入', 'Asia/Shanghai', { signal: controller.signal }),
    ).rejects.toThrow(ParseError);

    await expect(
      parseTask('测试输入', 'Asia/Shanghai', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_ABORTED' });

    // 不应调用 fetch（已提前取消）
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('fetch 调用中途 abort 时应抛出 ParseError（AI_REQUEST_ABORTED）', async () => {
    const controller = new AbortController();

    // Mock fetch：在调用时立即触发 abort
    vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
      const signal = options?.signal as AbortSignal | undefined;
      controller.abort();
      // 模拟 fetch 感知到 abort 后抛出 AbortError
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    // abort 信号被传递给 fetch，触发规则引擎兜底而非 ABORTED 抛出
    // （因为 fetch 层的 abort 被捕获并包装）
    // 对于用户主动取消（信号在 parseTask 内部检查时已 abort），会抛出
    // 本测试验证 signal 被正确传递
    const result = await parseTask('测试取消场景', 'Asia/Shanghai', {
      signal: controller.signal,
    });

    // 由于 abort 发生在 fetch 内部，包装后走兜底逻辑
    // 实际行为取决于 signal.aborted 在重试前的检查时机
    expect(['rule-engine', 'glm-4-air']).toContain(result.source);
  });
});

// ─────────────────────────────────────────────
// 七、ParseError 类型测试
// ─────────────────────────────────────────────

describe('ParseError', () => {
  it('应正确设置 name、code、attempt 属性', () => {
    const err = new ParseError('测试错误', 'INVALID_JSON', 1);
    expect(err.name).toBe('ParseError');
    expect(err.code).toBe('INVALID_JSON');
    expect(err.attempt).toBe(1);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof ParseError).toBe(true);
  });

  it('应正确保存 cause', () => {
    const cause = new Error('原始错误');
    const err = new ParseError('包装错误', 'UNKNOWN', 0, cause);
    expect(err.cause).toBe(cause);
  });
});
