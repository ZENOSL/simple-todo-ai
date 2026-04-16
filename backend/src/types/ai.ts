/**
 * @file src/types/ai.ts
 * @description AI 解析层的 TypeScript 类型定义
 *
 * 涵盖：ParsedTask 结构体、ParseError 类型、置信度记录、
 * 原始 GLM API 响应类型及内部使用的中间类型。
 */

// ─────────────────────────────────────────────
// 枚举值（字面量联合类型）
// ─────────────────────────────────────────────

/** 任务优先级，对应后端 Task.priority ENUM */
export type Priority = 'high' | 'medium' | 'low';

/** 任务分类，对应后端 Task.category */
export type Category = 'work' | 'life' | 'study';

// ─────────────────────────────────────────────
// 核心接口：AI 解析结果
// ─────────────────────────────────────────────

/**
 * AI 解析单条自然语言任务的标准输出结构。
 *
 * 与后端 POST /tasks/parse 的响应字段完全对齐（后端额外存储 sort_weight，
 * AI 模块不负责计算）。
 */
export interface ParsedTask {
  /** 提取的任务标题，去除时间词/优先级词/语气词后的核心动作 + 对象 */
  title: string;

  /**
   * 截止时间，ISO 8601 格式（YYYY-MM-DDTHH:MM:SS）。
   * 无截止时间时为 null（JSON null，不是字符串 "null"）。
   */
  due_date: string | null;

  /** 优先级 */
  priority: Priority;

  /** 分类 */
  category: Category;

  /**
   * 各字段置信度，0~1 之间的浮点数。
   * 用于后端日志（ai_confidence JSONB 字段）和前端 UI 显示不确定性提示。
   */
  confidence: {
    title: number;
    due_date: number;
    priority: number;
    category: number;
  };

  /** 用户原始输入，透传给后端写入 Task.raw_input */
  raw_input: string;

  /**
   * 解析来源标识，用于监控和告警分析。
   * - 'glm-4-flash'：主模型正常解析
   * - 'glm-4-air'：Fallback 模型解析
   * - 'rule-engine'：两次 AI 重试均失败，规则引擎兜底
   */
  source: 'glm-4-flash' | 'glm-4-air' | 'rule-engine';
}

// ─────────────────────────────────────────────
// 错误类型
// ─────────────────────────────────────────────

/** AI 解析错误类型枚举 */
export type ParseErrorCode =
  | 'INVALID_JSON'           // GLM 返回无法解析的 JSON
  | 'MISSING_FIELDS'         // JSON 合法但缺少必填字段
  | 'INVALID_ENUM'           // 枚举值超出允许范围且无法修复
  | 'AI_TIMEOUT'             // GLM API 调用超时（>8s）
  | 'AI_RATE_LIMIT'          // GLM 429 限速
  | 'AI_SERVER_ERROR'        // GLM 5xx 服务端错误
  | 'AI_REQUEST_ABORTED'     // 调用方主动取消（AbortSignal）
  | 'RULE_ENGINE_FALLBACK'   // 规则引擎兜底（不是错误，仅标识来源）
  | 'UNKNOWN';               // 未分类错误

/**
 * 解析错误，被 parseTask() 在无法兜底时抛出。
 * 正常情况下规则引擎会兜底，此错误仅在极端场景出现。
 */
export class ParseError extends Error {
  /** 错误分类码，供调用方做细粒度处理 */
  public readonly code: ParseErrorCode;

  /** 第几次重试发生（0 = 首次，1 = 第一次重试，2 = 第二次重试） */
  public readonly attempt: number;

  /** 原始错误，用于 stack trace 聚合 */
  public readonly cause?: unknown;

  constructor(
    message: string,
    code: ParseErrorCode,
    attempt: number = 0,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.attempt = attempt;
    this.cause = cause;
    // 保证 instanceof 在 TypeScript 继承中正确工作
    Object.setPrototypeOf(this, ParseError.prototype);
  }
}

// ─────────────────────────────────────────────
// GLM API 原始响应类型（内部使用）
// ─────────────────────────────────────────────

/** GLM Chat Completion 原始响应结构（chat/completions 接口） */
export interface GlmChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    message: {
      role: 'assistant';
      content: string;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** GLM API 错误响应结构 */
export interface GlmErrorResponse {
  error: {
    code: string;
    message: string;
    type?: string;
  };
}

// ─────────────────────────────────────────────
// 内部中间类型（不对外暴露）
// ─────────────────────────────────────────────

/**
 * GLM 返回的原始 JSON 对象（未经验证）。
 * 用于修复层输入，字段可能缺失、类型错误、含 markdown 污染。
 */
export interface RawGlmOutput {
  title?: unknown;
  due_date?: unknown;
  priority?: unknown;
  category?: unknown;
  [key: string]: unknown;
}

/** parseTask 内部调用 GLM 的选项 */
export interface ParseOptions {
  /** 用户时区，IANA 格式，默认 'Asia/Shanghai' */
  userTimezone?: string;

  /**
   * AbortSignal，用于在用户取消操作时立即终止 AI 调用。
   * 透传自 Fastify 的 request.signal（Node.js 18+ 支持）。
   */
  signal?: AbortSignal;
}
