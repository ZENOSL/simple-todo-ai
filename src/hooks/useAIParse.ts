import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useUIStore } from "../stores/uiStore";
import { apiFetch } from "../lib/api/client";
import type { ParsedTask, ParseResponse, ConfirmTaskRequest, UsageInfo } from "../app/types/frontend";

/* ============================================================
   useAIParse Hook
   - 显式触发 AI 解析（Enter 键 / 按钮点击）
   - AbortController 取消上一个请求（防止竞态条件）
   - TanStack Query mutation 管理服务器状态
   ============================================================ */

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/* POST /api/tasks/parse */
async function parseTask(
  input: string,
  requestId: string,
  signal: AbortSignal
): Promise<ParseResponse> {
  const response = await apiFetch("/api/tasks/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, request_id: requestId }),
    signal,
  });
  return response.json() as Promise<ParseResponse>;
}

/* POST /api/tasks/confirm */
async function confirmTask(payload: ConfirmTaskRequest): Promise<void> {
  await apiFetch("/api/tasks/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface UseAIParseReturn {
  parsedTask: ParsedTask | null;
  usage: UsageInfo | null;
  isParsing: boolean;
  parseError: Error | null;
  isConfirming: boolean;
  triggerParse: (input: string) => void;
  updateParsedField: <K extends keyof ParsedTask>(field: K, value: ParsedTask[K]) => void;
  confirmParsed: (rawInput: string) => Promise<void>;
  reset: () => void;
}

export function useAIParse(): UseAIParseReturn {
  const queryClient = useQueryClient();
  const setInputPanelState = useUIStore((s) => s.setInputPanelState);

  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const [parsedTask, setParsedTask] = useState<ParsedTask | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  /* --- 解析 Mutation --- */
  const parseMutation = useMutation<
    ParseResponse,
    Error,
    { input: string; requestId: string }
  >({
    mutationFn: ({ input, requestId }) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      requestIdRef.current = requestId;
      return parseTask(input, requestId, controller.signal);
    },
    onSuccess: (data) => {
      setParsedTask(data.parsed);
      setUsage(data.usage);
      setInputPanelState("result");
    },
    onError: (error) => {
      if (error.name === "AbortError") return;
      setInputPanelState("input");
    },
  });

  /* --- 确认 Mutation --- */
  const confirmMutation = useMutation<void, Error, ConfirmTaskRequest>({
    mutationFn: confirmTask,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "today"] });
    },
  });

  /* --- 显式触发解析（Enter 键 / 按钮点击） --- */
  const triggerParse = useCallback((input: string) => {
    if (!input.trim()) return;
    // 如果已在解析中，不重复提交
    if (parseMutation.isPending) return;
    setInputPanelState("parsing");
    const requestId = generateRequestId();
    parseMutation.mutate({ input, requestId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- 更新解析结果字段 --- */
  const updateParsedField = useCallback(
    <K extends keyof ParsedTask>(field: K, value: ParsedTask[K]) => {
      setParsedTask((prev) => (prev ? { ...prev, [field]: value } : null));
    },
    []
  );

  /* --- 确认并写库 --- */
  const confirmParsed = useCallback(async (rawInput: string) => {
    const task = parsedTask;
    const requestId = requestIdRef.current;
    if (!task || !requestId) return;

    await confirmMutation.mutateAsync({
      request_id: requestId,
      task: {
        title: task.title,
        due_date: task.due_date,
        priority: task.priority,
        category: task.category,
        raw_input: rawInput,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedTask]);

  /* --- 重置所有状态 --- */
  const reset = useCallback(() => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    requestIdRef.current = null;
    setParsedTask(null);
    setUsage(null);
    parseMutation.reset();
    confirmMutation.reset();
    setInputPanelState("closed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- 卸载时清理 --- */
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  return {
    parsedTask,
    usage,
    isParsing: parseMutation.isPending,
    parseError: parseMutation.error,
    isConfirming: confirmMutation.isPending,
    triggerParse,
    updateParsedField,
    confirmParsed,
    reset,
  };
}
