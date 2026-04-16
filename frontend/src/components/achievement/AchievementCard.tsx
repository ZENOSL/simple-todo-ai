"use client";

import { useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { AchievementData } from "../../app/types/frontend";

/* ============================================================
   AchievementCard — 成就卡片
   - 两版：普通完成（紫渐变）/ 今日全完成（橙渐变）
   - 弹性出现动画 cubic-bezier(0.34, 1.56, 0.64, 1)
   - 分享按钮
   ============================================================ */

/* ============================================================
   动画配置
   ============================================================ */
const SPRING_VARIANTS = {
  hidden: {
    opacity: 0,
    scale: 0.65,
    y: 40,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: "spring" as const,
      // 等效于 cubic-bezier(0.34, 1.56, 0.64, 1)
      damping: 12,
      stiffness: 200,
      mass: 0.8,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.9,
    y: -20,
    transition: { duration: 0.2 },
  },
};

/* ============================================================
   主题配置
   ============================================================ */
const THEME = {
  single: {
    gradient: "from-violet-500 via-indigo-500 to-blue-500",
    bgGlow: "rgba(124, 58, 237, 0.25)",
    emoji: "✅",
    title: "任务完成！",
    shareText: "我刚完成了一个任务！",
  },
  all_done: {
    gradient: "from-amber-400 via-orange-500 to-red-500",
    bgGlow: "rgba(245, 158, 11, 0.25)",
    emoji: "🎉",
    title: "今日全部完成！",
    shareText: "我今天完成了所有任务！",
  },
};

/* ============================================================
   分享功能
   ============================================================ */
async function shareAchievement(text: string, completedCount: number) {
  const shareData = {
    title: "Simple Todo AI",
    text: `${text} (已完成 ${completedCount} 个任务) #SimpleTodoAI`,
  };

  if (navigator.share && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
      return;
    } catch {
      // 用户取消分享，不报错
    }
  }

  // 降级到复制到剪贴板
  try {
    await navigator.clipboard.writeText(shareData.text);
    // 简单反馈：可由父组件 toast 处理
    return "copied";
  } catch {
    // 剪贴板 API 不可用，忽略
  }
}

/* ============================================================
   粒子装饰（纯 CSS 动画）
   ============================================================ */
function Confetti() {
  const particles = Array.from({ length: 6 });
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl" aria-hidden="true">
      {particles.map((_, i) => (
        <motion.div
          key={i}
          className="absolute h-2 w-2 rounded-full bg-white/60"
          initial={{ x: "50%", y: "50%", opacity: 0 }}
          animate={{
            x: `${20 + i * 12}%`,
            y: `${10 + (i % 3) * 25}%`,
            opacity: [0, 0.8, 0],
            scale: [0, 1.5, 0],
          }}
          transition={{
            duration: 0.8,
            delay: 0.15 + i * 0.08,
            ease: "easeOut",
          }}
        />
      ))}
    </div>
  );
}

/* ============================================================
   Props
   ============================================================ */
export interface AchievementCardProps {
  achievement: AchievementData;
  visible: boolean;
  onDismiss: () => void;
}

/* ============================================================
   AchievementCard 主组件
   ============================================================ */
export function AchievementCard({
  achievement,
  visible,
  onDismiss,
}: AchievementCardProps) {
  const theme = THEME[achievement.type] ?? THEME.single;

  const handleShare = useCallback(async () => {
    await shareAchievement(theme.shareText, achievement.completed_count);
  }, [theme.shareText, achievement.completed_count]);

  return (
    <AnimatePresence>
      {visible && (
        <>
          {/* 背景遮罩（点击关闭） */}
          <motion.div
            key="ach-overlay"
            className="fixed inset-0 flex items-end justify-center pb-24"
            style={{ zIndex: "var(--z-modal)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onDismiss}
            aria-hidden="true"
          >
            {/* 毛玻璃遮罩 */}
            <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
          </motion.div>

          {/* 成就卡片 */}
          <motion.div
            key="ach-card"
            className="fixed bottom-28 left-4 right-4"
            style={{ zIndex: "calc(var(--z-modal) + 1)" }}
            variants={SPRING_VARIANTS}
            initial="hidden"
            animate="visible"
            exit="exit"
            role="status"
            aria-live="polite"
            aria-label={achievement.message}
          >
            <div
              className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${theme.gradient} p-6 shadow-2xl`}
              style={{
                boxShadow: `0 20px 60px ${theme.bgGlow}, 0 8px 24px rgba(0,0,0,0.15)`,
              }}
            >
              {/* 粒子装饰 */}
              <Confetti />

              {/* 高光圆 */}
              <div
                className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/10"
                aria-hidden="true"
              />
              <div
                className="absolute -bottom-6 -left-6 h-24 w-24 rounded-full bg-white/10"
                aria-hidden="true"
              />

              {/* 内容 */}
              <div className="relative z-10">
                {/* 主 emoji */}
                <motion.p
                  className="mb-2 text-4xl"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{
                    type: "spring",
                    damping: 10,
                    stiffness: 300,
                    delay: 0.15,
                  }}
                  aria-hidden="true"
                >
                  {theme.emoji}
                </motion.p>

                {/* 标题 */}
                <motion.h3
                  className="mb-1 text-xl font-bold text-white"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.2, duration: 0.25 }}
                >
                  {theme.title}
                </motion.h3>

                {/* 消息 */}
                <motion.p
                  className="mb-4 text-sm text-white/80"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3, duration: 0.25 }}
                >
                  {achievement.message}
                  <span className="ml-2 font-semibold text-white">
                    共 {achievement.completed_count} 个 ✓
                  </span>
                </motion.p>

                {/* 操作按钮 */}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleShare}
                    className="flex flex-1 items-center justify-center gap-2 rounded-full bg-white/20 py-2.5 text-sm font-semibold text-white backdrop-blur-sm transition-all hover:bg-white/30 active:scale-95"
                    aria-label="分享成就"
                  >
                    <ShareIcon />
                    分享
                  </button>
                  <button
                    type="button"
                    onClick={onDismiss}
                    className="flex flex-1 items-center justify-center rounded-full bg-white py-2.5 text-sm font-semibold transition-all hover:bg-white/90 active:scale-95"
                    style={{ color: "var(--color-brand-primary)" }}
                    aria-label="关闭成就卡片"
                  >
                    继续加油
                  </button>
                </div>
              </div>
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
function ShareIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13 4.5a2.5 2.5 0 11.702 1.737L6.97 9.604a2.518 2.518 0 010 .792l6.733 3.367a2.5 2.5 0 11-.671 1.341l-6.733-3.367a2.5 2.5 0 110-3.474l6.733-3.366A2.52 2.52 0 0113 4.5z" />
    </svg>
  );
}
