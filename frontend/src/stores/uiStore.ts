import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { InputPanelState, OnboardingStep } from "../app/types/frontend";

/* ============================================================
   Paywall 触发规则：
   - 每次标记完成时 completionCount + 1
   - 达到第10次后 500ms 延迟弹出 Paywall
   - paywallShown 置 true 后不再重复弹出
   ============================================================ */
const PAYWALL_TRIGGER_COUNT = 10;
const PAYWALL_DELAY_MS = 500;

interface UIState {
  /* --- InputPanel --- */
  inputPanelState: InputPanelState;
  rawInput: string;

  /* --- Paywall --- */
  completionCount: number;
  paywallVisible: boolean;
  paywallShown: boolean;

  /* --- Onboarding --- */
  onboardingStep: OnboardingStep;

  /* --- Toast --- */
  toastMessage: string | null;
  toastTaskId: string | null;
  toastTimer: ReturnType<typeof setTimeout> | null;
}

interface UIActions {
  /* InputPanel */
  openInputPanel: () => void;
  closeInputPanel: () => void;
  setInputPanelState: (state: InputPanelState) => void;
  setRawInput: (value: string) => void;

  /* Paywall */
  incrementCompletion: () => void;
  closePaywall: () => void;

  /* Onboarding */
  advanceOnboarding: () => void;
  completeOnboarding: () => void;

  /* Toast */
  showUndoToast: (taskId: string, message: string) => void;
  dismissToast: () => void;
}

export const useUIStore = create<UIState & UIActions>()(
  persist(
    (set, get) => ({
      /* ---- Initial State ---- */
      inputPanelState: "closed",
      rawInput: "",
      completionCount: 0,
      paywallVisible: false,
      paywallShown: false,
      onboardingStep: "idle",
      toastMessage: null,
      toastTaskId: null,
      toastTimer: null,

      /* ---- InputPanel Actions ---- */
      openInputPanel: () =>
        set({ inputPanelState: "input", rawInput: "" }),

      closeInputPanel: () =>
        set({ inputPanelState: "closed", rawInput: "" }),

      setInputPanelState: (state) =>
        set({ inputPanelState: state }),

      setRawInput: (value) =>
        set({ rawInput: value }),

      /* ---- Paywall Actions ---- */
      incrementCompletion: () => {
        const { completionCount, paywallShown } = get();
        const next = completionCount + 1;

        set({ completionCount: next });

        if (!paywallShown && next >= PAYWALL_TRIGGER_COUNT) {
          // 500ms 延迟后触发 Paywall
          setTimeout(() => {
            set({ paywallVisible: true, paywallShown: true });
          }, PAYWALL_DELAY_MS);
        }
      },

      closePaywall: () =>
        set({ paywallVisible: false }),

      /* ---- Onboarding Actions ---- */
      advanceOnboarding: () => {
        const { onboardingStep } = get();
        const steps: OnboardingStep[] = [
          "idle",
          "highlight_input",
          "highlight_swipe",
          "complete",
        ];
        const currentIndex = steps.indexOf(onboardingStep);
        const nextStep = steps[currentIndex + 1] ?? "complete";
        set({ onboardingStep: nextStep });
      },

      completeOnboarding: () =>
        set({ onboardingStep: "complete" }),

      /* ---- Toast Actions ---- */
      showUndoToast: (taskId, message) => {
        const { toastTimer } = get();

        // 清除上一个 toast 定时器
        if (toastTimer) {
          clearTimeout(toastTimer);
        }

        const timer = setTimeout(() => {
          set({ toastMessage: null, toastTaskId: null, toastTimer: null });
        }, 3000);

        set({ toastMessage: message, toastTaskId: taskId, toastTimer: timer });
      },

      dismissToast: () => {
        const { toastTimer } = get();
        if (toastTimer) {
          clearTimeout(toastTimer);
        }
        set({ toastMessage: null, toastTaskId: null, toastTimer: null });
      },
    }),
    {
      name: "simple-todo-ui",
      storage: createJSONStorage(() => localStorage),
      // 只持久化需要跨会话保留的字段
      partialize: (state) => ({
        completionCount: state.completionCount,
        paywallShown: state.paywallShown,
        onboardingStep: state.onboardingStep,
      }),
    }
  )
);
