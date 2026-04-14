"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useUIStore } from "../../stores/uiStore";
import { useAIParse } from "../../hooks/useAIParse";
import { AIParsePanel } from "./AIParsePanel";
import type { ParsedTask } from "../../app/types/frontend";

/* ============================================================
   InputPanel — 底部半屏 slide-up 面板
   - Enter 键 / 按钮显式触发 AI 解析
   - AbortController 取消上一个请求
   - visualViewport API 键盘适配（FE-01）
   - 解析中显示骨架屏
   ============================================================ */

/* ============================================================
   visualViewport 键盘高度监听
   将键盘高度写入 CSS Custom Property --keyboard-height
   ============================================================ */
function useKeyboardHeight() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      const keyboardHeight = window.innerHeight - viewport.height - viewport.offsetTop;
      const safeHeight = Math.max(0, keyboardHeight);
      document.documentElement.style.setProperty(
        "--keyboard-height",
        `${safeHeight}px`
      );
    };

    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();

    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.setProperty("--keyboard-height", "0px");
    };
  }, []);
}

/* ============================================================
   面板内容区高度：半屏（不超过 480px）
   通过 CSS Custom Property 向上偏移键盘高度
   ============================================================ */
const PANEL_MAX_HEIGHT = 480;
const OVERLAY_DISMISS_THRESHOLD = 50; // 向下拖拽 50px 关闭

/* ============================================================
   Props
   ============================================================ */
export interface InputPanelProps {
  onTaskCreated?: () => void;
}

/* ============================================================
   InputPanel 主组件
   ============================================================ */
export function InputPanel({ onTaskCreated }: InputPanelProps) {
  useKeyboardHeight();

  const inputPanelState = useUIStore((s) => s.inputPanelState);
  const rawInput = useUIStore((s) => s.rawInput);
  const setRawInput = useUIStore((s) => s.setRawInput);
  const closeInputPanel = useUIStore((s) => s.closeInputPanel);
  const setInputPanelState = useUIStore((s) => s.setInputPanelState);

  const {
    parsedTask,
    usage,
    isParsing,
    isConfirming,
    triggerParse,
    updateParsedField,
    confirmParsed,
    reset,
  } = useAIParse();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 本地编辑中的解析结果（用于字段独立编辑）
  const [localParsed, setLocalParsed] = useState<ParsedTask | null>(null);

  const isOpen = inputPanelState !== "closed";
  const isInResultMode = inputPanelState === "result";

  /* --- 同步 parsedTask 到 localParsed --- */
  useEffect(() => {
    if (parsedTask && !localParsed) {
      setLocalParsed(parsedTask);
    }
  }, [parsedTask, localParsed]);

  /* --- 打开时自动聚焦 --- */
  useEffect(() => {
    if (inputPanelState === "input") {
      setLocalParsed(null);
      // 延迟一帧确保动画完成后再聚焦
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [inputPanelState]);

  /* --- 处理输入变化（仅更新文本，不自动触发解析） --- */
  const handleInputChange = useCallback(
    (value: string) => {
      setRawInput(value);
    },
    [setRawInput]
  );

  /* --- 显式触发解析（Enter 键 / 按钮点击） --- */
  const handleTriggerParse = useCallback(() => {
    if (!rawInput.trim() || isParsing) return;
    triggerParse(rawInput);
  }, [rawInput, isParsing, triggerParse]);

  /* --- 键盘快捷键 --- */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        handleClose();
        return;
      }
      // Enter 触发 AI 解析（Shift+Enter 换行）
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleTriggerParse();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleTriggerParse]
  );

  /* --- 关闭面板 --- */
  const handleClose = useCallback(() => {
    reset();
    setLocalParsed(null);
    closeInputPanel();
  }, [reset, closeInputPanel]);

  /* --- 字段独立编辑 --- */
  const handleFieldChange = useCallback(
    <K extends keyof ParsedTask>(field: K, value: ParsedTask[K]) => {
      setLocalParsed((prev) => (prev ? { ...prev, [field]: value } : null));
      updateParsedField(field, value);
    },
    [updateParsedField]
  );

  /* --- 确认添加 --- */
  const handleConfirm = useCallback(async () => {
    try {
      await confirmParsed(rawInput);
      onTaskCreated?.();
      handleClose();
    } catch (error) {
      // 错误由 useAIParse 内部的 mutation.error 处理，UI 通过 toast 展示
      console.error("[InputPanel] confirm failed:", error);
    }
  }, [confirmParsed, rawInput, onTaskCreated, handleClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* 遮罩层 */}
          <motion.div
            key="overlay"
            className="fixed inset-0 bg-black/40"
            style={{ zIndex: "var(--z-panel)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={handleClose}
            aria-hidden="true"
          />

          {/* 面板主体 */}
          <motion.div
            key="panel"
            className="fixed bottom-0 left-0 right-0 rounded-t-2xl bg-[#f8f9fa] shadow-lg"
            style={{
              zIndex: "calc(var(--z-panel) + 1)",
              maxHeight: PANEL_MAX_HEIGHT,
              // 键盘弹出时，面板整体上移键盘高度
              marginBottom:
                "calc(var(--keyboard-height, 0px) + var(--safe-area-bottom, 0px))",
            }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{
              type: "spring",
              damping: 28,
              stiffness: 300,
            }}
            role="dialog"
            aria-modal="true"
            aria-label="添加新任务"
            // 向下拖拽关闭
            drag="y"
            dragConstraints={{ top: 0, bottom: PANEL_MAX_HEIGHT }}
            dragElastic={{ top: 0, bottom: 0.3 }}
            onDragEnd={(_: unknown, info: { offset: { y: number } }) => {
              if (info.offset.y > OVERLAY_DISMISS_THRESHOLD) {
                handleClose();
              }
            }}
          >
            {/* 拖拽把手 */}
            <div className="flex justify-center py-3" aria-hidden="true">
              <div className="h-1 w-10 rounded-full bg-slate-300" />
            </div>

            {/* 面板内容 */}
            <div
              className="overflow-y-auto pb-6"
              style={{ maxHeight: PANEL_MAX_HEIGHT - 40 }}
            >
              <AnimatePresence mode="wait">
                {isInResultMode ? (
                  /* --- 解析结果面板 --- */
                  <motion.div
                    key="parse-result"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <AIParsePanel
                      isParsing={isParsing}
                      parsedTask={localParsed ?? parsedTask}
                      usage={usage}
                      rawInput={rawInput}
                      onFieldChange={handleFieldChange}
                      onConfirm={handleConfirm}
                      onCancel={handleClose}
                      isConfirming={isConfirming}
                    />
                  </motion.div>
                ) : (
                  /* --- 文本输入面板 --- */
                  <motion.div
                    key="text-input"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="px-4"
                  >
                    {/* 输入框标题 */}
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-slate-600">
                        添加任务
                      </h2>
                      <button
                        type="button"
                        onClick={handleClose}
                        className="touch-target flex items-center justify-center rounded-full p-1 text-slate-400 hover:text-slate-600"
                        aria-label="关闭面板"
                      >
                        <CloseIcon />
                      </button>
                    </div>

                    {/* 文本输入区 */}
                    <div className="relative rounded-xl border border-slate-200 bg-white transition-colors focus-within:border-[var(--color-brand-primary)] focus-within:ring-2 focus-within:ring-[var(--color-brand-primary)]/25">
                      <textarea
                        ref={textareaRef}
                        value={rawInput}
                        onChange={(e) => handleInputChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={
                          "用自然语言描述任务...\n例如：明天下午3点开产品评审会，高优"
                        }
                        className="block w-full resize-none rounded-xl bg-transparent p-4 text-sm text-gray-800 placeholder-slate-300 outline-none focus:outline-none focus-visible:outline-none"
                        rows={3}
                        aria-label="任务描述输入框"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />

                      {/* 底部操作栏：提示 + AI 解析按钮 */}
                      <div className="flex items-center justify-between px-4 pb-3">
                        <span className="text-xs text-slate-300">
                          {rawInput.length > 0
                            ? "按 Enter 或点击按钮解析"
                            : "支持中英文自然语言"}
                        </span>
                        <button
                          type="button"
                          onClick={handleTriggerParse}
                          disabled={!rawInput.trim() || isParsing}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                          style={{ background: "var(--color-brand-primary)" }}
                          aria-label="AI 解析"
                        >
                          {isParsing ? (
                            <>
                              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                              解析中...
                            </>
                          ) : (
                            <>
                              <AISparkleIcon />
                              AI 解析
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* 快捷示例 */}
                    {rawInput.length === 0 && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.3 }}
                        className="mt-4 space-y-2"
                      >
                        <p className="text-xs text-slate-400">快速示例：</p>
                        {[
                          "今晚8点健身1小时",
                          "明天上午提交季度报告，高优",
                          "本周五前回复客户邮件",
                        ].map((example) => (
                          <button
                            key={example}
                            type="button"
                            onClick={() => handleInputChange(example)}
                            className="block w-full rounded-lg border border-dashed border-slate-200 px-3 py-2 text-left text-xs text-slate-400 transition-colors hover:border-blue-300 hover:text-blue-500"
                          >
                            {example}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ============================================================
   内联 SVG 图标
   ============================================================ */
function AISparkleIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3.5 8a4.5 4.5 0 1 1 9 0 4.5 4.5 0 0 1-9 0Zm4.5-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm6.75 2.25a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5h1.5ZM8 12a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 12ZM3.25 7.25a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5h1.5Zm9.46-4.46a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0ZM4.86 11.14a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 0 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm8.34 2.12a.75.75 0 0 1-1.06 0l-1.06-1.06a.75.75 0 0 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06ZM4.86 4.86a.75.75 0 0 1-1.06 0L2.74 3.8a.75.75 0 0 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
    </svg>
  );
}
