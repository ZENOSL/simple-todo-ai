"use client";

import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api/client";
import { motion, AnimatePresence } from "framer-motion";
import { TaskCard } from "../components/task/TaskCard";
import { InputPanel } from "../components/input/InputPanel";
import { useUIStore } from "../stores/uiStore";
import type {
  Task,
  UITask,
  TodayTasksResponse,
  WeekTasksResponse,
  CompleteTaskResponse,
  UserMeResponse,
} from "./types/frontend";

type Tab = "today" | "week";

/* ============================================================
   API 函数
   ============================================================ */
async function fetchTodayTasks(): Promise<TodayTasksResponse> {
  const res = await apiFetch("/api/tasks/today");
  return res.json() as Promise<TodayTasksResponse>;
}

async function fetchWeekTasks(): Promise<WeekTasksResponse> {
  const res = await apiFetch("/api/tasks/week");
  return res.json() as Promise<WeekTasksResponse>;
}

async function fetchUserMe(): Promise<UserMeResponse> {
  const res = await apiFetch("/api/users/me");
  return res.json() as Promise<UserMeResponse>;
}

async function completeTask(id: string): Promise<CompleteTaskResponse> {
  const res = await apiFetch(`/api/tasks/${id}/complete`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return res.json() as Promise<CompleteTaskResponse>;
}

async function undoComplete(id: string): Promise<void> {
  await apiFetch(`/api/tasks/${id}/complete`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ undo: true }),
  });
}

async function deleteTask(id: string): Promise<void> {
  await apiFetch(`/api/tasks/${id}`, { method: "DELETE" });
}

/* ============================================================
   进度条组件
   ============================================================ */
function ProgressBar({ total, completed }: { total: number; completed: number }) {
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-gray-700">今日任务</span>
        <span className="text-xs text-slate-400">{completed} / {total} 完成</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`今日进度：${percentage}%`}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ background: percentage === 100 ? "var(--gradient-achievement-orange)" : "var(--color-brand-primary)" }}
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
      {percentage > 0 && (
        <motion.p
          className="mt-1 text-right text-xs font-medium"
          style={{ color: percentage === 100 ? "var(--color-brand-warning)" : "var(--color-brand-primary)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          {percentage === 100 ? "全部完成 🎉" : `${percentage}%`}
        </motion.p>
      )}
    </div>
  );
}

/* ============================================================
   UndoToast
   ============================================================ */
function UndoToast({ message, taskId, onUndo }: { message: string; taskId: string; onUndo: (id: string) => void }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          className="fixed bottom-24 left-4 right-4 z-[--z-toast] flex items-center justify-between rounded-xl bg-gray-800 px-4 py-3 shadow-lg"
          style={{ zIndex: "var(--z-toast)" }}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.2 }}
          role="alert"
          aria-live="polite"
        >
          <span className="text-sm text-white">{message}</span>
          <button
            type="button"
            onClick={() => onUndo(taskId)}
            className="ml-4 flex-shrink-0 rounded-full px-3 py-1 text-sm font-semibold text-blue-400 transition-colors hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            撤销
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ============================================================
   空状态
   ============================================================ */
function EmptyState({ onAddTask, label }: { onAddTask: () => void; label: string }) {
  return (
    <motion.div
      className="flex flex-col items-center justify-center py-20 text-center"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
    >
      <p className="mb-2 text-5xl">📝</p>
      <h3 className="mb-1 text-base font-semibold text-slate-600">{label}</h3>
      <p className="mb-6 text-sm text-slate-400">用自然语言添加你的第一个任务</p>
      <button type="button" onClick={onAddTask} className="btn-brand">+ 添加任务</button>
    </motion.div>
  );
}

/* ============================================================
   加载骨架屏
   ============================================================ */
function SkeletonList() {
  return (
    <div className="space-y-3 px-4 pt-4" aria-busy="true" aria-label="加载中">
      {[1, 2, 3].map((i) => (
        <div key={i} className="card-surface flex items-center gap-3 p-4">
          <div className="shimmer h-5 w-5 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="shimmer h-4 rounded" style={{ width: `${60 + i * 10}%` }} />
            <div className="shimmer h-3 w-1/4 rounded" />
          </div>
          <div className="shimmer h-6 w-10 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   本周视图：按日期分组
   ============================================================ */
const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function WeekView({
  tasks,
  weekStart,
  weekEnd,
  onComplete,
  onDelete,
  containerWidth,
}: {
  tasks: Task[];
  weekStart: string;
  weekEnd: string;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  containerWidth: number;
}) {
  // 生成本周 7 天
  const days: string[] = [];
  const start = new Date(weekStart + "T00:00:00");
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }

  const tasksByDay = new Map<string, Task[]>();
  for (const day of days) tasksByDay.set(day, []);
  for (const task of tasks) {
    const day = task.due_date ? task.due_date.slice(0, 10) : null;
    if (day && tasksByDay.has(day)) tasksByDay.get(day)!.push(task);
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="pb-4">
      <p className="px-4 pb-2 pt-3 text-xs text-slate-400">
        {weekStart} — {weekEnd}
      </p>
      {days.map((day) => {
        const dayTasks = tasksByDay.get(day) ?? [];
        const date = new Date(day + "T00:00:00");
        const label = `${date.getMonth() + 1}/${date.getDate()} ${WEEKDAY_CN[date.getDay()]}`;
        const isToday = day === today;

        return (
          <div key={day} className="mb-2">
            {/* 日期标题 */}
            <div className="mb-1 flex items-center gap-2 px-4">
              <span
                className={`text-xs font-semibold ${isToday ? "text-blue-600" : "text-slate-400"}`}
              >
                {label}
                {isToday && <span className="ml-1 text-blue-400">今天</span>}
              </span>
              <div className="h-px flex-1 bg-slate-100" />
              {dayTasks.length > 0 && (
                <span className="text-xs text-slate-300">{dayTasks.length} 项</span>
              )}
            </div>
            {dayTasks.length === 0 ? (
              <p className="px-4 py-1 text-xs text-slate-300">无任务</p>
            ) : (
              dayTasks.map((task) => {
                const uiTask: UITask = {
                  ...task,
                  status: task.is_completed ? "completed" : "pending",
                };
                return (
                  <TaskCard
                    key={task.id}
                    task={uiTask}
                    onComplete={onComplete}
                    onDelete={onDelete}
                    containerWidth={containerWidth}
                  />
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   页面主体
   ============================================================ */
export default function HomePage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("today");

  const openInputPanel = useUIStore((s) => s.openInputPanel);
  const paywallVisible = useUIStore((s) => s.paywallVisible);
  const toastMessage   = useUIStore((s) => s.toastMessage);
  const toastTaskId    = useUIStore((s) => s.toastTaskId);
  const dismissToast   = useUIStore((s) => s.dismissToast);

  const [optimisticCompleted, setOptimisticCompleted] = useState<Set<string>>(new Set());
  const [containerWidth, setContainerWidth] = useState(375);

  useEffect(() => {
    const update = () => setContainerWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  /* --- 查询 --- */
  const todayQuery = useQuery<TodayTasksResponse>({
    queryKey: ["tasks", "today"],
    queryFn: fetchTodayTasks,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    placeholderData: (previousData) => previousData, // refetch 期间保留旧数据，避免 data=undefined 空白
  });

  const weekQuery = useQuery<WeekTasksResponse>({
    queryKey: ["tasks", "week"],
    queryFn: fetchWeekTasks,
    staleTime: 60_000,
    enabled: activeTab === "week",
  });

  const userQuery = useQuery<UserMeResponse>({
    queryKey: ["users", "me"],
    queryFn: fetchUserMe,
    staleTime: 60_000,
  });

  /* --- Tab 切换时主动 refetch（兜底：防止 stale 数据导致空白） --- */
  useEffect(() => {
    if (activeTab === "today" && todayQuery.isStale) {
      void todayQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  /* --- Mutations --- */
  const completeMutation = useMutation<CompleteTaskResponse, Error, string>({
    mutationFn: completeTask,
    onMutate: (id) => setOptimisticCompleted((prev) => new Set(prev).add(id)),
    onSuccess: (_, id) => {
      setOptimisticCompleted((prev) => { const s = new Set(prev); s.delete(id); return s; });
      // 立即更新缓存中该任务的完成状态，避免 invalidate 造成的数据空窗期
      queryClient.setQueryData<TodayTasksResponse>(["tasks", "today"], (old) => {
        if (!old) return old;
        const tasks = old.tasks.map((t) =>
          t.id === id ? { ...t, is_completed: true } : t
        );
        const completed = tasks.filter((t) => t.is_completed).length;
        return { ...old, tasks, completed };
      });
      // 后台同步最新数据
      queryClient.invalidateQueries({ queryKey: ["tasks", "today"] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "week"] });
    },
    onError: (_, id) => {
      setOptimisticCompleted((prev) => { const s = new Set(prev); s.delete(id); return s; });
    },
  });

  const undoMutation = useMutation<void, Error, string>({
    mutationFn: undoComplete,
    onSuccess: () => {
      dismissToast();
      queryClient.invalidateQueries({ queryKey: ["tasks", "today"] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "week"] });
    },
  });

  const deleteMutation = useMutation<void, Error, string>({
    mutationFn: deleteTask,
    onSuccess: (_, id) => {
      // 立即从缓存中移除该任务，避免 invalidate 造成的数据空窗期
      queryClient.setQueryData<TodayTasksResponse>(["tasks", "today"], (old) => {
        if (!old) return old;
        const tasks = old.tasks.filter((t) => t.id !== id);
        const completed = tasks.filter((t) => t.is_completed).length;
        return { ...old, tasks, total: tasks.length, completed };
      });
      // 后台同步最新数据
      queryClient.invalidateQueries({ queryKey: ["tasks", "today"] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "week"] });
    },
  });

  const handleComplete = useCallback((id: string) => {
    completeMutation.mutate(id);
    const task = todayQuery.data?.tasks.find((t) => t.id === id);
    if (task) useUIStore.getState().showUndoToast(id, `"${task.title.slice(0, 12)}${task.title.length > 12 ? "…" : ""}" 已完成`);
    useUIStore.getState().incrementCompletion();
  }, [completeMutation, todayQuery.data]);

  const handleUndo   = useCallback((id: string) => undoMutation.mutate(id), [undoMutation]);
  const handleDelete = useCallback((id: string) => deleteMutation.mutate(id), [deleteMutation]);
  const handleTaskCreated = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["tasks", "today"] });
  }, [queryClient]);

  /* --- 构建 UITask 列表 --- */
  const uiTasks: UITask[] = (todayQuery.data?.tasks ?? []).map((task) => ({
    ...task,
    status: optimisticCompleted.has(task.id) ? "completed" : task.is_completed ? "completed" : "pending",
  }));

  const pendingTasks   = uiTasks.filter((t) => t.status === "pending");
  const completedTasks = uiTasks.filter((t) => t.status === "completed");
  const total     = todayQuery.data?.total    ?? 0;
  const completed = todayQuery.data?.completed ?? 0;

  const userTier      = userQuery.data?.user.tier ?? "free";
  const usageRemaining = userQuery.data?.usage.remaining_today ?? null;
  const usageLimit     = userQuery.data?.usage.limit_today ?? 10;

  return (
    <div className="relative min-h-screen" style={{ background: "var(--color-bg-app)" }}>

      {/* ---- 顶部导航栏 ---- */}
      <header className="sticky top-0 z-10 bg-[#f8f9fa]/90 backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 pb-2 pt-safe">
          <div>
            <h1 className="text-xl font-bold text-gray-800">
              {activeTab === "today" ? "今日" : "本周"}
            </h1>
            <p className="text-xs text-slate-400">
              {new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}
            </p>
          </div>

          {/* 用户信息 + 用量 */}
          <div className="flex items-center gap-2">
            {userTier === "free" && usageRemaining !== null && (
              <span
                className={`text-xs font-medium ${
                  usageRemaining <= 2 ? "text-red-500" : usageRemaining <= 5 ? "text-amber-500" : "text-slate-400"
                }`}
              >
                AI {usageRemaining}/{usageLimit}
              </span>
            )}
            {userTier === "pro" && (
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-600">Pro</span>
            )}
            <button type="button" className="touch-target flex items-center justify-center rounded-full" aria-label="用户菜单">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white"
                style={{ background: "var(--color-brand-primary)" }}
              >
                {userTier === "pro" ? "P" : "T"}
              </div>
            </button>
          </div>
        </div>

        {/* Tab 栏 */}
        <div className="flex border-b border-slate-100 px-4">
          {(["today", "week"] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`relative mr-6 pb-2 text-sm font-medium transition-colors ${
                activeTab === tab ? "text-gray-800" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              {tab === "today" ? "今日" : "本周"}
              {activeTab === tab && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                  style={{ background: "var(--color-brand-primary)" }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ---- 主内容 ---- */}
      <main className="pb-32">
        <AnimatePresence>
          {activeTab === "today" ? (
            <motion.div key="today" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {/* 进度条 */}
              {!todayQuery.isPending && total > 0 && <ProgressBar total={total} completed={completed} />}

              {/* 骨架屏：首次加载无数据，或 fetching 中且无缓存数据时显示 */}
              {(todayQuery.isPending || (todayQuery.isFetching && !todayQuery.data)) && <SkeletonList />}

              {/* 错误 */}
              {todayQuery.isError && (
                <div className="py-12 text-center">
                  <p className="mb-4 text-slate-400">加载失败，请重试</p>
                  <button type="button" onClick={() => void todayQuery.refetch()} className="btn-brand">重新加载</button>
                </div>
              )}

              {/* 空状态 */}
              {!todayQuery.isPending && !todayQuery.isError && total === 0 && (
                <EmptyState onAddTask={openInputPanel} label="今天还没有任务" />
              )}

              {/* 待完成 */}
              {pendingTasks.length > 0 && (
                <section aria-label="待完成任务">
                  <div className="mb-2 mt-4" role="list" aria-label={`待完成 ${pendingTasks.length} 项`}>
                    {pendingTasks.map((task, index) => (
                      <motion.div key={task.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05, duration: 0.25 }}>
                        <TaskCard task={task} onComplete={handleComplete} onDelete={handleDelete} containerWidth={containerWidth} />
                      </motion.div>
                    ))}
                  </div>
                </section>
              )}

              {/* 已完成 */}
              {completedTasks.length > 0 && (
                <section aria-label="已完成任务" className="mt-4">
                  <div className="mb-2 flex items-center gap-2 px-4">
                    <div className="h-px flex-1 bg-slate-200" />
                    <span className="text-xs text-slate-400">已完成 {completedTasks.length} 项</span>
                    <div className="h-px flex-1 bg-slate-200" />
                  </div>
                  <div role="list">
                    {completedTasks.map((task) => (
                      <TaskCard key={task.id} task={task} onComplete={handleComplete} onDelete={handleDelete} containerWidth={containerWidth} />
                    ))}
                  </div>
                </section>
              )}
            </motion.div>
          ) : (
            <motion.div key="week" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {weekQuery.isPending && <SkeletonList />}
              {weekQuery.isError && (
                <div className="py-12 text-center">
                  <p className="mb-4 text-slate-400">加载失败，请重试</p>
                  <button type="button" onClick={() => void weekQuery.refetch()} className="btn-brand">重新加载</button>
                </div>
              )}
              {weekQuery.data && (
                <WeekView
                  tasks={weekQuery.data.tasks}
                  weekStart={weekQuery.data.week_start}
                  weekEnd={weekQuery.data.week_end}
                  onComplete={handleComplete}
                  onDelete={handleDelete}
                  containerWidth={containerWidth}
                />
              )}
              {!weekQuery.isPending && !weekQuery.isError && (weekQuery.data?.tasks.length ?? 0) === 0 && (
                <EmptyState onAddTask={openInputPanel} label="本周还没有任务" />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* ---- 底部添加按钮 ---- */}
      <div className="fixed bottom-0 left-0 right-0 px-4 pb-safe" style={{ paddingBottom: "calc(var(--safe-area-bottom, 0px) + 16px)", zIndex: "var(--z-panel)" }}>
        <div className="flex items-center gap-3 rounded-2xl bg-white/90 px-4 py-3 shadow-lg backdrop-blur-md">
          <button type="button" onClick={openInputPanel} className="flex flex-1 items-center gap-2 text-left text-sm text-slate-400 focus-visible:outline-none" aria-label="添加新任务">
            <span className="flex h-7 w-7 items-center justify-center rounded-full text-white" style={{ background: "var(--color-brand-primary)" }} aria-hidden="true">+</span>
            <span>添加任务...</span>
          </button>
          <button type="button" onClick={openInputPanel} className="touch-target flex items-center gap-1 text-xs font-medium" style={{ color: "var(--color-brand-primary)" }} aria-label="使用 AI 解析添加任务">
            <SparklesIcon />
            AI
          </button>
        </div>
      </div>

      {/* ---- InputPanel ---- */}
      <InputPanel onTaskCreated={handleTaskCreated} />

      {/* ---- Undo Toast ---- */}
      {toastMessage && toastTaskId && <UndoToast message={toastMessage} taskId={toastTaskId} onUndo={handleUndo} />}

      {/* ---- Paywall 占位 ---- */}
      {paywallVisible && (
        <div className="fixed inset-0 z-[--z-paywall] flex items-end" style={{ zIndex: "var(--z-paywall)" }} role="dialog" aria-modal="true" aria-label="升级到 Pro">
          <div className="w-full rounded-t-2xl bg-white p-8 text-center shadow-2xl">
            <p className="mb-2 text-2xl">🚀</p>
            <h2 className="mb-1 text-lg font-bold">解锁 Pro 无限任务</h2>
            <p className="text-sm text-slate-500">您已完成 10 个任务，升级解锁更多功能</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   内联图标
   ============================================================ */
function SparklesIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M9.664 1.319a.75.75 0 01.672 0 41.059 41.059 0 018.198 5.424.75.75 0 01-.254 1.285 31.372 31.372 0 00-7.86 3.83.75.75 0 01-.84 0 31.508 31.508 0 00-2.08-1.287V9.394c0-.244.065-.477.185-.681A29.727 29.727 0 015.77 7.75c.264-.17.543-.329.837-.481l.254-.131-.053-.055A5.999 5.999 0 006 6a6 6 0 016-6z" clipRule="evenodd" />
      <path d="M5 6.25a.75.75 0 01.75-.75h8.5a.75.75 0 010 1.5h-8.5A.75.75 0 015 6.25zM2.495 8.896a.75.75 0 01.75-.646h.01c.313 0 .59.19.704.48.33.852.586 1.74.759 2.652H4.5a.75.75 0 010 1.5h-.004a27.028 27.028 0 01-.96-3.49.75.75 0 01.96-.496zM17.505 8.896a.75.75 0 00-.75-.646h-.01a.75.75 0 00-.704.48 27.17 27.17 0 01-.759 2.652H15.5a.75.75 0 000 1.5h.004c.357-1.158.652-2.343.96-3.49a.75.75 0 00-.96-.496z" />
    </svg>
  );
}
