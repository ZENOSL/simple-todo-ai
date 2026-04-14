"use client";

import { useState, useId } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ParsedTask, TaskPriority, TaskCategory, UsageInfo } from "../../app/types/frontend";

/* ============================================================
   AI 解析结果面板
   - 四字段展示：标题 / 时间 / 优先级 / 分类
   - 每字段独立可编辑
   - 骨架屏 → 结果切换（AnimatePresence 200ms）
   - 确认 / 取消 按钮
   ============================================================ */

const PRIORITY_OPTIONS: { value: TaskPriority; label: string; color: string }[] = [
  { value: "high", label: "高", color: "text-red-600 bg-red-50 border-red-200" },
  { value: "medium", label: "中", color: "text-amber-600 bg-amber-50 border-amber-200" },
  { value: "low", label: "低", color: "text-slate-500 bg-slate-50 border-slate-200" },
];

const CATEGORY_OPTIONS: { value: TaskCategory; label: string; icon: string }[] = [
  { value: "work", label: "工作", icon: "💼" },
  { value: "life", label: "生活", icon: "🏠" },
  { value: "study", label: "学习", icon: "📚" },
];

/** 将无法识别的 category 值（如 AI 返回 "other"）映射为默认值 "work" */
function normalizeCategoryValue(value: string): TaskCategory {
  const valid: TaskCategory[] = ["work", "life", "study"];
  return valid.includes(value as TaskCategory) ? (value as TaskCategory) : "work";
}

/* ============================================================
   骨架屏
   ============================================================ */
function ParseSkeleton() {
  return (
    <div className="space-y-3 px-4" role="status" aria-label="AI 解析中">
      {/* 标题字段骨架 */}
      <div className="rounded-lg border border-slate-100 bg-white p-3">
        <div className="shimmer mb-2 h-3 w-12 rounded" />
        <div className="shimmer h-5 w-4/5 rounded" />
      </div>
      {/* 时间字段骨架 */}
      <div className="rounded-lg border border-slate-100 bg-white p-3">
        <div className="shimmer mb-2 h-3 w-10 rounded" />
        <div className="shimmer h-5 w-1/3 rounded" />
      </div>
      {/* 优先级 + 分类骨架 */}
      <div className="flex gap-3">
        <div className="flex-1 rounded-lg border border-slate-100 bg-white p-3">
          <div className="shimmer mb-2 h-3 w-12 rounded" />
          <div className="shimmer h-7 w-16 rounded-full" />
        </div>
        <div className="flex-1 rounded-lg border border-slate-100 bg-white p-3">
          <div className="shimmer mb-2 h-3 w-10 rounded" />
          <div className="shimmer h-7 w-20 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   单字段可编辑行
   ============================================================ */
interface EditableFieldProps {
  label: string;
  value: string;
  onSave: (newValue: string) => void;
  placeholder?: string;
  type?: "text" | "datetime-local";
}

function EditableField({
  label,
  value,
  onSave,
  placeholder,
  type = "text",
}: EditableFieldProps) {
  const inputId = useId();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const handleBlur = () => {
    setIsEditing(false);
    if (draft !== value) {
      onSave(draft);
    }
  };

  return (
    <div className="rounded-lg border border-slate-100 bg-white p-3 transition-colors focus-within:border-blue-300">
      <label
        htmlFor={inputId}
        className="mb-1 block text-xs font-medium text-slate-400"
      >
        {label}
      </label>
      {isEditing ? (
        <input
          id={inputId}
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setDraft(value);
              setIsEditing(false);
            }
          }}
          placeholder={placeholder}
          className="w-full text-sm font-medium text-gray-800 outline-none"
          autoFocus
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setIsEditing(true);
          }}
          className="w-full text-left text-sm font-medium text-gray-800 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {value || (
            <span className="text-slate-300">{placeholder ?? "点击编辑"}</span>
          )}
          <span className="ml-1 text-xs text-slate-300">✏️</span>
        </button>
      )}
    </div>
  );
}

/* ============================================================
   Props
   ============================================================ */
export interface AIParsePanelProps {
  isParsing: boolean;
  parsedTask: ParsedTask | null;
  usage: UsageInfo | null;
  rawInput: string;
  onFieldChange: <K extends keyof ParsedTask>(
    field: K,
    value: ParsedTask[K]
  ) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  isConfirming: boolean;
}

/* ============================================================
   AIParsePanel 主组件
   ============================================================ */
export function AIParsePanel({
  isParsing,
  parsedTask,
  usage,
  rawInput,
  onFieldChange,
  onConfirm,
  onCancel,
  isConfirming,
}: AIParsePanelProps) {
  const formatDateTimeLocal = (isoString: string | null): string => {
    if (!isoString) return "";
    try {
      const d = new Date(isoString);
      // datetime-local 格式: YYYY-MM-DDTHH:mm
      return d.toISOString().slice(0, 16);
    } catch {
      return "";
    }
  };

  const parseDateTimeLocal = (value: string): string | null => {
    if (!value) return null;
    try {
      return new Date(value).toISOString();
    } catch {
      return null;
    }
  };

  return (
    <div className="pb-2">
      {/* 面板标题 */}
      <div className="mb-3 flex items-center justify-between px-4">
        <h2 className="text-sm font-semibold text-slate-600">AI 解析结果</h2>
        <div className="flex items-center gap-2">
          {/* 今日剩余配额 */}
          {usage && usage.plan === "free" && usage.remaining_today !== null && (
            <span
              className={`text-xs font-medium ${
                usage.remaining_today <= 2
                  ? "text-red-500"
                  : usage.remaining_today <= 5
                  ? "text-amber-500"
                  : "text-slate-400"
              }`}
            >
              今日剩余 {usage.remaining_today}/{usage.limit_today}
            </span>
          )}
          {usage && usage.plan === "pro" && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
              Pro 无限次
            </span>
          )}
          {isParsing && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
              解析中
            </span>
          )}
        </div>
      </div>

      {/* 内容区：骨架屏 / 结果 切换 */}
      <AnimatePresence mode="wait">
        {isParsing || !parsedTask ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ParseSkeleton />
          </motion.div>
        ) : (
          <motion.div
            key="result"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-3 px-4"
          >
            {/* 标题字段 */}
            <EditableField
              label="任务标题"
              value={parsedTask.title}
              onSave={(v) => onFieldChange("title", v)}
              placeholder="输入任务标题"
            />

            {/* 时间字段 */}
            <EditableField
              label="截止时间"
              value={formatDateTimeLocal(parsedTask.due_date)}
              onSave={(v) => onFieldChange("due_date", parseDateTimeLocal(v))}
              placeholder="无截止时间"
              type="datetime-local"
            />

            {/* 优先级 + 分类 并排 */}
            <div className="flex gap-3">
              {/* 优先级 */}
              <div className="flex-1 rounded-lg border border-slate-100 bg-white p-3">
                <p className="mb-2 text-xs font-medium text-slate-400">优先级</p>
                <div className="flex gap-1.5">
                  {PRIORITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => onFieldChange("priority", opt.value)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all ${
                        parsedTask.priority === opt.value
                          ? opt.color + " ring-1 ring-current"
                          : "border-slate-200 text-slate-400 hover:border-slate-300"
                      }`}
                      aria-pressed={parsedTask.priority === opt.value}
                      aria-label={`优先级 ${opt.label}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 分类 */}
              <div className="flex-1 rounded-lg border border-slate-100 bg-white p-3">
                <p className="mb-2 text-xs font-medium text-slate-400">分类</p>
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => onFieldChange("category", opt.value)}
                      className={`rounded-full border px-2 py-0.5 text-xs transition-all ${
                        normalizeCategoryValue(parsedTask.category) === opt.value
                          ? "border-blue-400 bg-blue-50 text-blue-600 ring-1 ring-blue-400"
                          : "border-slate-200 text-slate-400 hover:border-slate-300"
                      }`}
                      aria-pressed={normalizeCategoryValue(parsedTask.category) === opt.value}
                      aria-label={`分类: ${opt.label}`}
                    >
                      {opt.icon} {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 原始输入（只读） */}
            {rawInput && (
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-400">
                  原始输入：<span className="text-slate-500">{rawInput}</span>
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 操作按钮 */}
      <div className="mt-4 flex gap-3 px-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={isConfirming}
          className="flex-1 rounded-full border border-slate-200 py-3 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50 active:scale-95 disabled:opacity-50"
        >
          取消
        </button>

        <button
          type="button"
          onClick={onConfirm}
          disabled={isConfirming || isParsing || !parsedTask}
          className="btn-brand flex-1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isConfirming ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              保存中
            </span>
          ) : (
            "确认添加"
          )}
        </button>
      </div>
    </div>
  );
}
