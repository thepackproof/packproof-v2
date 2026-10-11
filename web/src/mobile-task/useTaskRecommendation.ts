import { useEffect, useRef, useState } from 'react';
import { stableRecommendation, type HomeAction, type selectTaskHome } from '../../../mobile/src/experience/task-home';

/** Keep a focused target stable while it is still eligible. Account changes reset the pin. */
export function useTaskRecommendation(state: ReturnType<typeof selectTaskHome>, scope: string) {
  const previous = useRef<{ scope: string; action: HomeAction } | null>(null);
  const [interacting, setInteracting] = useState(false);
  const action = stableRecommendation(previous.current?.scope === scope ? previous.current.action : null, state, interacting);
  useEffect(() => { previous.current = { scope, action }; }, [scope, action]);
  return { action, handlers: {
    onFocusCapture: () => setInteracting(true),
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteracting(false); },
    onPointerDown: () => setInteracting(true),
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => { if (!event.currentTarget.contains(document.activeElement)) setInteracting(false); },
  } };
}
